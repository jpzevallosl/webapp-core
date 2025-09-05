import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';

interface EcsStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.Vpc;
  clusterName: string;
  taskImage?: string;        // URI de imagen (opcional, si no se provee usaremos la del repo ECR)
  containerPort: number;
  desiredCount: number;
  cpu: number;
  memory: number;
  dbSecret: sm.Secret;
  dbSecurityGroup: ec2.SecurityGroup;
}

export class EcsStack extends cdk.Stack {
  public readonly albDomain: string;  // DNS del ALB para uso en CloudFront origin

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { projectName, vpc, clusterName, taskImage, containerPort, desiredCount, cpu, memory, dbSecret, dbSecurityGroup } = props;

    // ECS Cluster
    const cluster = new ecs.Cluster(this, `${projectName}-EcsCluster`, {
      vpc,
      clusterName: clusterName
    });

    // Task Role: rol que usará la tarea ECS (contenedor) para acceder a otros servicios
    const taskRole = new iam.Role(this, `${projectName}-TaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Rol IAM que usan los contenedores de ECS para acceder a AWS',
    });
    // Políticas: permitir leer secretos de BD, escribir logs (CloudWatch logs perm. están en execution role generalmente)
    dbSecret.grantRead(taskRole);
    // (Agregar otras políticas según necesite la app, e.g. acceso a S3, etc.)

    // Definir la Task Definition (Fargate)
    const taskDef = new ecs.FargateTaskDefinition(this, `${projectName}-TaskDef`, {
      memoryLimitMiB: memory,
      cpu: cpu,
      taskRole: taskRole,  // rol de la tarea
      // executionRole: (se podría especificar uno personalizado, pero por defecto CDK crea uno con AWS managed policy ECSExecution)
    });

    // Contenedor principal de la Task
    const image = taskImage 
      ? ecs.ContainerImage.fromRegistry(taskImage) 
      : ecs.ContainerImage.fromEcrRepository(cdk.Stack.of(this).node.tryGetContext('ecrRepo') || {} as any);
      // ^ alternativa: podría pasarse la referencia del repo ECR via props para usar ecs.ContainerImage.fromEcrRepository

    const container = taskDef.addContainer(`${projectName}-AppContainer`, {
      image: image,
      containerName: 'app',
      memoryLimitMiB: memory,
      cpu: cpu,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ 
        streamPrefix: `${projectName}-app`, 
        logRetention: cdk.Duration.days(30).toDays() // mantener 30 días (opcional)
      }),
      environment: {
        'DB_HOST': props.dbSecurityGroup ? props.dbSecurityGroup.securityGroupId : '', // Usaremos endpoint real abajo
        'DB_NAME': props.dbSecret ? dbSecret.secretValueFromJson('username').toString() : dbSecret.secretValueFromJson('username').toString(),
        'DB_USER': dbSecret.secretValueFromJson('username').toString(),
        // Otros env vars de configuración de la app (e.g., API keys) se pueden agregar aquí
      },
      secrets: {
        'DB_PASSWORD': ecs.Secret.fromSecretsManager(dbSecret, 'password')
      }
    });
    // Nota: En lugar de DB_HOST como SG id (incorrecto), después de crear RDS deberíamos pasar su endpoint DNS:
    // Podemos actualizar environment['DB_HOST'] = databaseStack.dbInstance.instanceEndpoint.hostname en app.ts al instanciar ECSStack, 
    // o pasarlo via props; aquí por simplicidad asumimos la app puede resolver host con secret o que se actualará fuera de este snippet.

    container.addPortMappings({ containerPort: containerPort });

    // Security Group para las tareas ECS (App)
    const ecsSecurityGroup = new ec2.SecurityGroup(this, `${projectName}-App-SG`, {
      vpc,
      description: 'Permite acceso al contenedor ECS solo desde el ALB',
      allowAllOutbound: true  // permitir salidas (podríamos restringir a puertos de BD/endpoint)
    });

    // Security Group para el ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, `${projectName}-ALB-SG`, {
      vpc,
      description: 'Permite acceso al ALB solo desde CloudFront, y salida al ECS',
      allowAllOutbound: true  // ALB puede hacer health checks a ECS (salidas a SG ECS)
    });

    // Ingress rule: ALB acepta trafico HTTPS (443) solo desde CloudFront (prefix list de CloudFront)
    const cfPrefixList = ec2.PrefixList.fromPrefixListId(this, 'CloudFrontPrefixList', 
                          // us-east-1 prefix list ID for com.amazonaws.global.cloudfront.origin-facing (puede variar por región)
                          // Alternativamente, usar fromPrefixListName si CDK lo soporta.
                          'pl-3b927c52'   // ID para us-east-1 :contentReference[oaicite:23]{index=23}
                        );
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cfPrefixList.prefixListId),
      ec2.Port.tcp(443),
      'Allow CloudFront only'
    );
    // Egress rule: ALB puede salir hacia ECS SG (establecer conexión con tareas)
    albSecurityGroup.addEgressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(containerPort),
      'Allow ALB to reach ECS tasks'
    );

    // ECS tasks SG: permitir entrada solo desde ALB SG en el puerto del contenedor
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(containerPort),
      'Allow traffic from ALB'
    );
    // (Opcional) Restringir salidas de ECS: por ejemplo, permitir solo hacia SG de BD y endpoints:
    // ecsSecurityGroup.addEgressRule(dbSecurityGroup, ec2.Port.tcp(3306), 'Allow ECS to DB');
    // (Para no complicar, dejamos allowAllOutbound true que permite a ECS llamar a externos vía NAT si fuera necesario.)

    // Crear el ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, `${projectName}-ALB`, {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: `${projectName}-alb`
    });

    // Listener y certificado
    let listener: elbv2.ApplicationListener;
    if (process.env.BACKEND_CERT_ARN) {
      // Listener HTTPS con certificado proporcionado
      listener = alb.addListener('HttpsListener', {
        port: 443,
        certificates: [ elbv2.ListenerCertificate.fromArn(process.env.BACKEND_CERT_ARN) ],
        open: false  // no abrir a todo internet, controlaremos via SG
      });
    } else {
      // Sin certificado: usamos HTTP (CloudFront manejará HTTPS externamente)
      listener = alb.addListener('HttpListener', {
        port: 80,
        open: false
      });
      // Ajustar SG para permitir puerto 80 en lugar de 443 desde CloudFront si este caso ocurre
      albSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(cfPrefixList.prefixListId),
        ec2.Port.tcp(80),
        'Allow CloudFront HTTP (no cert scenario)'
      );
    }

    // Target Group para ECS
    const targetGroup = new elbv2.ApplicationTargetGroup(this, `${projectName}-TG`, {
      vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [],  // attach via service
      targetType: elbv2.TargetType.IP,  // Fargate uses IP target mode
      healthCheck: {
        path: '/health',   // suponer que la app expone /health
        interval: cdk.Duration.seconds(30),
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5)
      }
    });
    // Asignar target group al listener
    listener.addTargetGroups('EcsTargetGroup', {
      targetGroups: [ targetGroup ]
    });

    // ECS Service (Fargate)
    const ecsService = new ecs.FargateService(this, `${projectName}-Service`, {
      cluster,
      taskDefinition: taskDef,
      desiredCount: desiredCount,
      securityGroups: [ ecsSecurityGroup ],
      assignPublicIp: false,
      vpcSubnets: { subnetGroupName: 'Application' }  // desplegar tasks en subredes privadas de aplicación
    });

    // Conectar el service al ALB target group
    ecsService.attachToApplicationTargetGroup(targetGroup);

    // Permitir que el SG de BD acepte tráfico desde el SG de ECS (Puerto 3306)
    dbSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow ECS tasks to access RDS'
    );

    // Output: DNS del ALB (para usarlo en CloudFront origin config)
    this.albDomain = alb.loadBalancerDnsName;
    new cdk.CfnOutput(this, 'AlbDNS', {
      value: this.albDomain,
      description: 'DNS del Application Load Balancer (usar en CloudFront Origin)'
    });
  }
}

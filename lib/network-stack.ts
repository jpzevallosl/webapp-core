import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

interface NetworkStackProps extends cdk.StackProps {
  projectName: string;
  cidr: string;
  maxAzs: number;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcEndpointsSecurityGroup: ec2.SecurityGroup;  // SG para endpoints interface

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { projectName, cidr, maxAzs } = props;

    // Crear la VPC con subnets públicas, privadas (con NAT) y aisladas (sin NAT)
    this.vpc = new ec2.Vpc(this, `${projectName}-VPC`, {
      cidr: cidr,
      maxAzs: maxAzs,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,  // antes llamado PRIVATE
        },
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,    // antes llamado ISOLATED
        }
      ],
      natGateways: maxAzs, // 1 NAT Gateway por AZ (alta disponibilidad)
    });

    // Security Group para Endpoints de VPC (permitir acceso solo desde subredes de app)
    this.vpcEndpointsSecurityGroup = new ec2.SecurityGroup(this, `${projectName}-EndpointsSG`, {
      vpc: this.vpc,
      description: 'Permite acceso a endpoints VPC solo desde las subredes privadas de aplicación',
      allowAllOutbound: true  // saliente irrestricto desde endpoints (respuestas)
    });
    // Reglas de entrada: permitir HTTPS (443) desde las IPs de las subredes privadas de aplicación
    // Obtenemos el bloque CIDR agregado de cada subnet privada de app
    for (const subnet of this.vpc.selectSubnets({ subnetGroupName: 'Application' }).subnets) {
      if (subnet.ipv4CidrBlock) {
        this.vpcEndpointsSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(subnet.ipv4CidrBlock),
          ec2.Port.tcp(443),
          'Allow HTTPS from application subnets'
        );
      }
    }

    // VPC Gateway Endpoint para S3 (acceso S3 privado sin NAT)
    this.vpc.addGatewayEndpoint(`${projectName}-S3Endpoint`, {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      // en subnets privadas y aisladas típicamente
      subnets: [
        { subnets: this.vpc.selectSubnets({ subnetGroupName: 'Application' }).subnets },
        { subnets: this.vpc.selectSubnets({ subnetGroupName: 'Database' }).subnets }
      ]
    });

    // VPC Interface Endpoints (ECR, CloudWatch Logs, Secrets Manager, etc.)
    this.vpc.addInterfaceEndpoint(`${projectName}-ECR-ApiEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetGroupName: 'Application' }, // endpoints en subredes de aplicación
      securityGroups: [ this.vpcEndpointsSecurityGroup ]
    });
    this.vpc.addInterfaceEndpoint(`${projectName}-ECR-DockerEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetGroupName: 'Application' },
      securityGroups: [ this.vpcEndpointsSecurityGroup ]
    });
    this.vpc.addInterfaceEndpoint(`${projectName}-CloudWatchEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetGroupName: 'Application' },
      securityGroups: [ this.vpcEndpointsSecurityGroup ]
    });
    this.vpc.addInterfaceEndpoint(`${projectName}-SecretsManagerEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetGroupName: 'Application' },
      securityGroups: [ this.vpcEndpointsSecurityGroup ]
    });
    // (Se pueden agregar otros endpoints según necesidad, ej: SNS, SQS, etc., si la app los usa)
  }
}


// bin/app.ts
import * as cdk from 'aws-cdk-lib';
import { config } from 'dotenv';
import { NetworkStack } from '../lib/network-stack';
import { EcrStack } from '../lib/ecr-stack';
import { DatabaseStack } from '../lib/database-stack';
import { EcsStack } from '../lib/ecs-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { AuthStack } from '../lib/auth-stack';

// Cargar variables del .env
config();

const app = new cdk.App();

// Opcional: definir la cuenta y región a desplegar usando variables de entorno
const envRegion = process.env.AWS_REGION || 'us-east-1';
const envAccount = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '<YOUR-AWS-ACCOUNT-ID>';

// Podemos usar un objeto env para pasarlo a cada stack (aunque no es obligatorio si usamos default)
const env = { account: envAccount, region: envRegion };

// Prefijo general de nombres
const projectName = process.env.PROJECT_NAME || 'webapp-core';

// Instanciar stacks en orden lógico
const networkStack = new NetworkStack(app, `${projectName}-NetworkStack`, {
  env,
  projectName: projectName,
  cidr: process.env.VPC_CIDR || '10.0.0.0/16',
  maxAzs: Number(process.env.MAX_AZS) || 2
});

const ecrStack = new EcrStack(app, `${projectName}-ECRStack`, {
  env,
  projectName: projectName,
  repoName: process.env.ECR_REPO_NAME || `${projectName}-app-repo`
});

// Base de datos (depende de la red)
const databaseStack = new DatabaseStack(app, `${projectName}-DatabaseStack`, {
  env,
  projectName: projectName,
  vpc: networkStack.vpc,
  dbName: process.env.DB_NAME || 'appdb',
  dbEngine: process.env.DB_ENGINE || 'mysql',
  dbEngineVersion: process.env.DB_ENGINE_VERSION || '8.0',
  dbInstanceClass: process.env.DB_INSTANCE_CLASS || 'db.t3.micro',
  dbUsername: process.env.DB_USERNAME || 'admin'
});

// Autenticación (Cognito) - no depende directamente de otros recursos
const authStack = new AuthStack(app, `${projectName}-AuthStack`, {
  env,
  projectName: projectName,
  userPoolName: process.env.COGNITO_USER_POOL_NAME || `${projectName}-users`,
  webClientName: process.env.COGNITO_APP_CLIENT_NAME || `${projectName}-web-client`
});

// ECS y ALB (depende de red y base de datos)
const ecsStack = new EcsStack(app, `${projectName}-EcsStack`, {
  env,
  projectName: projectName,
  vpc: networkStack.vpc,
  clusterName: `${projectName}-cluster`,
  taskImage: process.env.CONTAINER_IMAGE_URI || undefined, // si no se provee, se usará repo ECR
  containerPort: Number(process.env.ECS_CONTAINER_PORT) || 80,
  desiredCount: Number(process.env.ECS_DESIRED_COUNT) || 2,
  cpu: Number(process.env.ECS_TASK_CPU) || 256,
  memory: Number(process.env.ECS_TASK_MEMORY) || 512,
  dbSecret: databaseStack.dbSecret,       // secreto de credenciales de BD
  dbSecurityGroup: databaseStack.dbSecurityGroup // SG de la base de datos (para permisos)
});

// Frontend (CloudFront, S3, WAF) depende del ALB (para conocer su DNS) y de posiblemente Auth (si usamos Cognito info en CF)
const frontendStack = new FrontendStack(app, `${projectName}-FrontendStack`, {
  env,
  projectName: projectName,
  bucketName: `${projectName}-frontend-bucket`,
  albDomain: ecsStack.albDomain,   // DNS público del ALB
  albHttpsPort: 443,               // puerto HTTPS del ALB (CloudFront origin)
  cloudFrontDomain: process.env.FRONTEND_DOMAIN || undefined,
  cloudFrontCertArn: process.env.FRONTEND_CERT_ARN || undefined,
  // WAF rules could also be parameterized if needed
});

// Establecer dependencias explícitas (para el orden de despliegue)
ecsStack.addDependency(databaseStack);    // ECS después de BD (para que la BD y secreto existan)
ecsStack.addDependency(networkStack);     // ECS después de la red
databaseStack.addDependency(networkStack);// DB después de la red
frontendStack.addDependency(ecsStack);    // Frontend después de ECS/ALB
frontendStack.addDependency(networkStack);// Frontend después de la red (por si necesita VPC info, endpoints)
frontendStack.addDependency(authStack);   // (si CloudFront requiere configuración relacionada a Auth)

// Salida opcional: URL de la aplicación (si se proporcionó dominio personalizado, será ese, sino el dominio de CloudFront)
new cdk.CfnOutput(app, 'FrontendURL', {
  value: process.env.FRONTEND_DOMAIN 
    ? `https://${process.env.FRONTEND_DOMAIN}` 
    : frontendStack.cloudFrontDistribution.domainName,
  description: 'URL pública del frontend de la aplicación'
});


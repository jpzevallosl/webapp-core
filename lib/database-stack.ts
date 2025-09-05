import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';

interface DatabaseStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.Vpc;
  dbName: string;
  dbEngine: string;          // e.g., 'mysql' | 'postgres' | 'aurora-mysql' | ...
  dbEngineVersion: string;   // e.g., '8.0' for MySQL 8.0, or '5.7', etc.
  dbInstanceClass: string;   // instance type, e.g., 'db.t3.micro'
  dbUsername: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecret: sm.Secret;
  public readonly dbInstance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { projectName, vpc, dbName, dbEngine, dbEngineVersion, dbInstanceClass, dbUsername } = props;

    // Security Group para RDS: permite acceso desde ECS (inbound: 3306 from ECS SG)
    this.dbSecurityGroup = new ec2.SecurityGroup(this, `${projectName}-DB-SG`, {
      vpc,
      description: 'Permite acceso a la base de datos solo desde la capa de aplicación ECS',
      allowAllOutbound: true   // BD puede responder a clientes (ECS) 
    });
    // NOTA: la regla de ingreso desde el SG de ECS no se puede establecer aquí aún
    // porque el SG de ECS está en otro stack. Esa regla se añadirá desde ECS stack (o app.ts) una vez ambos SG existan.

    // Crear una clave KMS para cifrado de la BD (y potencialmente otros datos)
    const kmsKey = new kms.Key(this, `${projectName}-DB-KMSKey`, {
      description: `CMK para cifrado de datos en RDS (${projectName})`,
      alias: `${projectName.toLowerCase()}-rds-key`,
      enableKeyRotation: true
    });

    // Secret de credenciales de BD
    this.dbSecret = new sm.Secret(this, `${projectName}-DBCredentials`, {
      description: `Credenciales administrador para RDS ${projectName}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: dbUsername }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
        // passwordLength: 16 // longitud por defecto ~32
      }
    });

    // Elegir engine según parámetro (simple mapping)
    let engine: rds.IInstanceEngine;
    if (dbEngine.toLowerCase().includes('postgres')) {
      engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_13_4 });
      // (En un caso real mapearíamos versión exacta dbEngineVersion)
    } else if (dbEngine.toLowerCase().includes('aurora')) {
      engine = rds.DatabaseInstanceEngine.auroraMysql({ version: rds.AuroraMysqlEngineVersion.VER_3_03_0 }); 
    } else { 
      // por defecto MySQL
      engine = rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_28 });
    }

    // Crear instancia RDS
    this.dbInstance = new rds.DatabaseInstance(this, `${projectName}-Database`, {
      engine: engine,
      vpc,
      vpcSubnets: { subnetGroupName: 'Database' },  // desplegar en subredes aisladas de datos
      instanceType: ec2.InstanceType.of(
        // parseamos el instance class, ej 'db.t3.micro' -> InstanceClass.T3, InstanceSize.MICRO
        ec2.InstanceClass[dbInstanceClass.split('.')[1].toUpperCase() as keyof typeof ec2.InstanceClass] || ec2.InstanceClass.T3,
        ec2.InstanceSize[dbInstanceClass.split('.')[2].toUpperCase() as keyof typeof ec2.InstanceSize] || ec2.InstanceSize.MICRO
      ),
      allocatedStorage: 20, // 20 GB por defecto (mínimo)
      storageEncrypted: true,
      storageEncryptionKey: kmsKey,
      credentials: rds.Credentials.fromSecret(this.dbSecret),  // usa el secret creado
      multiAz: false,    // para dev, Multi-AZ desactivado; se puede activar en prod (costo +)
      securityGroups: [ this.dbSecurityGroup ],
      databaseName: dbName,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT  // en caso de destruir stack, conservar snapshot
    });

    // (Salida opcional) Exportar el endpoint de la BD y nombre del secreto
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.dbInstance.instanceEndpoint.socketAddress,
      description: 'Endpoint (host:port) de la base de datos RDS'
    });
    new cdk.CfnOutput(this, 'DatabaseSecretName', {
      value: this.dbSecret.secretName,
      description: 'Nombre del secreto en Secrets Manager con credenciales de la BD'
    });
  }
}


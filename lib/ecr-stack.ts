import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

interface EcrStackProps extends cdk.StackProps {
  projectName: string;
  repoName: string;
}

export class EcrStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    const { projectName, repoName } = props;
    // Crear el repositorio ECR
    this.repository = new ecr.Repository(this, `${projectName}-EcrRepo`, {
      repositoryName: repoName,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256  // (por defecto AES-256, también podríamos usar KMS)
    });

    // (Salida) URI del repositorio, para usar al construir la imagen
    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: this.repository.repositoryUri,
      description: 'URI del repositorio ECR para la aplicación'
    });
  }
}


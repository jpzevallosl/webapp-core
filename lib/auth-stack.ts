import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

interface AuthStackProps extends cdk.StackProps {
  projectName: string;
  userPoolName: string;
  webClientName: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { projectName, userPoolName, webClientName } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: userPoolName,
      selfSignUpEnabled: true,
      signInAliases: { email: true },  // permitir inicio por email
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 8,
        requireSymbols: false,
        requireUppercase: false,
        requireDigits: false,
        requireLowercase: false
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN  // conservar usuarios si se borra la stack
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      clientName: webClientName,
      generateSecret: false,  // public client (no secret for web)
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: { implicitCodeGrant: true },
        callbackUrls: [ 'https://localhost:3000/callback' ],  // por ejemplo, URL de tu app front local
        logoutUrls: [ 'https://localhost:3000/' ]
      }
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'ID del User Pool de Cognito'
    });
    new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'ID del App Client de Cognito'
    });
  }
}


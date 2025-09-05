import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

interface FrontendStackProps extends cdk.StackProps {
  projectName: string;
  bucketName: string;
  albDomain: string;
  albHttpsPort: number;
  cloudFrontDomain?: string;
  cloudFrontCertArn?: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly cloudFrontDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { projectName, bucketName, albDomain, albHttpsPort, cloudFrontDomain, cloudFrontCertArn } = props;

    // Bucket S3 para frontend
    const siteBucket = new s3.Bucket(this, `${projectName}-FrontendBucket`, {
      bucketName: bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,  // o .KMS si quisiéramos usar una CMK
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN  // no borrar objetos al eliminar stack (por seguridad)
    });

    // Origin Access Control para CloudFront accediendo al bucket
    const oac = new cloudfront.CfnOriginAccessControl(this, 'SiteBucketOAC', {
      originAccessControlConfig: {
        name: `${projectName}-OAC`,
        description: 'OAC para que CloudFront acceda al bucket S3 privado',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',   // siempre firmar las peticiones
        signingProtocol: 'sigv4'
      }
    });

    // Definir la Web ACL de WAF (reglas administradas)
    const webACL = new wafv2.CfnWebACL(this, `${projectName}-WebACL`, {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${projectName}-webacl`, sampledRequestsEnabled: true },
      description: `WAF Web ACL for CloudFront - ${projectName}`,
      name: `${projectName}-WebACL`,
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: {
            name: 'AWSManagedRulesCommonRuleSet',
            vendorName: 'AWS'
          }},
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${projectName}-common-rules`, sampledRequestsEnabled: true }
        },
        // (Se podrían añadir más reglas administradas: IP reputation, Anonymous IP, SQLi, etc., con distintas prioridades)
        // {
        //   name: 'AWS-AWSManagedRulesAmazonIpReputationList',
        //   priority: 2,
        //   overrideAction: { none: {} },
        //   statement: { managedRuleGroupStatement: {
        //       name: 'AWSManagedRulesAmazonIpReputationList',
        //       vendorName: 'AWS'
        //   }},
        //   visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${projectName}-ip-rep`, sampledRequestsEnabled: true }
        // }
      ]
    });

    // CloudFront Distribution
    const cfOrigins: Record<string, origins.OriginGroup | origins.IOrigin> = {};

    // Origin para el bucket S3
    cfOrigins['s3'] = new origins.S3Origin(siteBucket, {
      originAccessIdentity: undefined, // no usar OAI porque usamos OAC
      // CloudFront aún no tiene L2 soporte directo para OAC, pero se puede vincular mediante propiedades abajo
    });

    // Origin para el ALB (usando DNS público)
    cfOrigins['alb'] = new origins.HttpOrigin(albDomain, {
      protocolPolicy: albHttpsPort === 443 
                      ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY 
                      : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      // Se asume ALB tiene listener 443 con certificado válido si albHttpsPort=443,
      // si no, usamos HTTP_ONLY (ej: origin via http://alb)
    });

    // Construir la distribución CloudFront
    this.cloudFrontDistribution = new cloudfront.Distribution(this, `${projectName}-CloudFront`, {
      defaultRootObject: 'index.html',
      enabled: true,
      comment: `${projectName} CloudFront distribution`,
      defaultBehavior: {
        origin: cfOrigins['s3'],
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,  // solo contenido estático
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,  // caching por defecto para static
      },
      additionalBehaviors: {
        // Reenviar todo /api/* al ALB (backend)
        'api/*': {
          origin: cfOrigins['alb'],
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,  // permitir POST, PUT si API los usa
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // no cachear respuestas API
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER, // enviar headers, query, cookies
          // Si quisiéramos solo específicas: podríamos crear una OriginRequestPolicy que incluya Authorization, etc.
        }
      },
      webAclId: webACL.attrArn,  // Asociar la distribución al WAF Web ACL
      domainNames: cloudFrontDomain ? [ cloudFrontDomain ] : undefined,
      certificate: cloudFrontCertArn ? cloudfront.Certificate.fromCertificateArn(this, 'CFCustomCert', cloudFrontCertArn) : undefined
    });

    // Atar el Origin Access Control al origen S3 de la distribución (no hay soporte directo en L2, se hace via escape hatch)
    const cfnDistribution = this.cloudFrontDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.getAtt('Id'));

    // Bucket Policy para permitir acceso solo desde CloudFront OAC
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [ siteBucket.arnForObjects('*') ],
      principals: [ new iam.ServicePrincipal('cloudfront.amazonaws.com') ],
      conditions: {
        'StringEquals': {
          'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${this.cloudFrontDistribution.distributionId}`
        }
      }
    }));

    // (Salida) URL de CloudFront
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: cloudFrontDomain ? `https://${cloudFrontDomain}` : `https://${this.cloudFrontDistribution.domainName}`,
      description: 'URL del frontend servido por CloudFront'
    });
  }
}


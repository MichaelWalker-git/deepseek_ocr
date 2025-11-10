import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { BlockPublicAccess, Bucket, BucketEncryption, CorsRule, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { createDefaultLambdaRole, getCdkConstructId, getPolicyStatement } from '../shared/cdk-helpers';

export interface StackProps extends cdk.StackProps {
  kmsKey: IKey;
}

export class S3Stack extends Stack {
  public readonly removalPolicy: RemovalPolicy = RemovalPolicy.DESTROY;
  public readonly kmsKey: IKey;
  public readonly filesBucket: Bucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id);

    const { kmsKey } = props;
    this.kmsKey = kmsKey;

    // S3 buckets
    const corsRule: CorsRule = {
      allowedOrigins: ['*'],
      allowedHeaders: ['*'],
      allowedMethods: [HttpMethods.GET, HttpMethods.POST, HttpMethods.PUT, HttpMethods.DELETE],
    };

    const loggingBucket = new Bucket(this, getCdkConstructId({ resourceName: 'login-bucket' }, this), {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: this.removalPolicy,
      encryption: BucketEncryption.KMS,
      versioned: true,
      enforceSSL: true,
      autoDeleteObjects: this.removalPolicy === RemovalPolicy.DESTROY,
    });

    loggingBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:*'],
        resources: [loggingBucket.bucketArn, `${loggingBucket.bucketArn}/*`],
        effect: cdk.aws_iam.Effect.DENY,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        conditions: {
          Bool: { 'aws:SecureTransport': 'false' },
        },
      }),
    );

    const filesBucketNotificationRole = createDefaultLambdaRole(this, getCdkConstructId({ resourceName: 'files-bucket-notification-role' }, this));

    // Input Bucket
    this.filesBucket = new Bucket(this, getCdkConstructId({ resourceName: 'files-bucket' }, this), {
      bucketName: getCdkConstructId({ resourceName: 'files-bucket' }, this),
      cors: [corsRule],
      removalPolicy: this.removalPolicy,
      encryption: BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      versioned: true,
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: 'inputBucketLogs/',
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      notificationsHandlerRole: filesBucketNotificationRole,
      autoDeleteObjects: this.removalPolicy === RemovalPolicy.DESTROY,
    });

    this.filesBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:*'],
        resources: [this.filesBucket.bucketArn, `${this.filesBucket.bucketArn}/*`],
        effect: cdk.aws_iam.Effect.DENY,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        conditions: {
          Bool: { 'aws:SecureTransport': 'false' },
        },
      }),
    );

    filesBucketNotificationRole.addToPolicy(getPolicyStatement({
      resources: ['*'],
      operations: ['InvokeFunction'],
      service: 'lambda',
    }));

    filesBucketNotificationRole.addToPolicy(getPolicyStatement({
      resources: [
        `arn:aws:s3:::${this.filesBucket.bucketName}`,
        `arn:aws:s3:::${this.filesBucket.bucketName}/*`,
      ],
      operations: ['PutBucketNotification', 'GetBucketNotification'],
      service: 's3',
    }));

  }
}

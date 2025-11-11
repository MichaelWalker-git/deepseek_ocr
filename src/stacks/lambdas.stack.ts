import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { startProcessing } from '../resources/lambda/processing';
import { createDefaultLambdaRole, getCdkConstructId, getPolicyStatement } from '../shared/cdk-helpers';

export interface LambdasStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  kmsKey: IKey;
  fileBucketName: string;
  securityGroup: SecurityGroup;
  loadBalancerUrl?: string;
}

export class LambdasStack extends cdk.Stack {
  public readonly startProcessingLambda: IFunction;

  constructor(scope: Construct, id: string, props: LambdasStackProps) {
    super(scope, id);

    const {
      vpc,
      fileBucketName,
      kmsKey,
      securityGroup,
      loadBalancerUrl,
    } = props;

    //Roles
    const startProcessingRole = createDefaultLambdaRole(this, getCdkConstructId({ resourceName: 'start-processing-role' }, scope));
    startProcessingRole.addToPolicy(getPolicyStatement({
      service: 's3',
      operations: ['PutObject', 'GetObject', 'PutObjectAcl', 'ListBucket', 'DeleteObject', 'GetItem'],
      resources: [
        `arn:aws:s3:::${fileBucketName}`,
        `arn:aws:s3:::${fileBucketName}/*`,
      ],
    }));
    startProcessingRole.addToPolicy(getPolicyStatement({
      service: 'kms',
      operations: ['Encrypt', 'Decrypt', 'GenerateDataKey'],
      resources: ['*'],
    }));

    // Lambdas
    this.startProcessingLambda = startProcessing(this, {
      REGION: this.region,
      FILES_BUCKET: fileBucketName,
      ALB_URL: loadBalancerUrl || '',
    }, startProcessingRole, vpc, securityGroup);
  }
}

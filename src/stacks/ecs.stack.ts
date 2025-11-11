import path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { DeepSeekOcrEc2GpuConstruct } from '../constructs/deepseek-ocr-ecs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface StackProps {
  vpc: ec2.IVpc;
  securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
  };
}

export class EcsStack extends cdk.Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, args: StackProps) {
    super(scope, id);

    const { vpc, securityGroups } = args;

    const exportKmsArn = getCdkConstructId({ resourceName: 'kms-arn' }, scope);
    const kmsArn = Fn.importValue(exportKmsArn);
    const kmsKey = Key.fromKeyArn(this, 'StackKms', kmsArn);

    // Make sure you have the execution and/or task role objects here
    const executionRole = new iam.Role(this, 'ExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Apply grants HERE (not in KMS stack)
    kmsKey.grantEncryptDecrypt(executionRole);
    kmsKey.grantEncryptDecrypt(taskRole);

    // ECS Cluster Stack
    const ecsClusterConstruct = new DeepSeekOcrEc2GpuConstruct(this, 'EcsGpuService', {
      vpc,
      securityGroups,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      dockerBuildContext: path.join(__dirname, '../../docker'),
      kmsKey,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE),
      spotPrice: undefined,
    });

    this.loadBalancer = ecsClusterConstruct.loadBalancer;
  }
}

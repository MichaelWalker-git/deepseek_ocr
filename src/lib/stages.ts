import { StackProps, Stage } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiGatewayStack } from '../stacks/api-gateway.stack';
import { EcsStack } from '../stacks/ecs.stack';
import { KmsStack } from '../stacks/kms.stack';
import { LambdasStack } from '../stacks/lambdas.stack';
import { NetworkingStack } from '../stacks/networking.stack';
import { S3Stack } from '../stacks/s3.stack';

const REGION = process.env.CDK_DEFAULT_REGION || '';

export class DevStage extends Stage {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps,
  ) {
    super(scope, id, props);

    if (!process.env.STAGE) {
      throw new Error('Missing required env vars: STAGE');
    }

    // KMS Stack
    const kmsStack = new KmsStack(this, 'DeepSeek-OCR-KMS-Stack');
    const { kmsKey } = kmsStack;

    // Network Stack
    const networkingStack = new NetworkingStack(this, 'DeepSeek-OCR-Networking-Stack', {
      env: { region: REGION },
    });

    const { vpc, securityGroups } = networkingStack;

    // ECS Stack
    const ecsStack = new EcsStack(
      this,
      'DeepSeek-OCR-ECS-Stack',
      {
        vpc,
        securityGroups,
        ...props,
      },
    );

    ecsStack.node.addDependency(kmsStack);
    ecsStack.node.addDependency(networkingStack);

    const { loadBalancer } = ecsStack;

    // s3 Stack
    const s3Stack = new S3Stack(this, 'DeepSeek-OCR-S3-Stack', {
      kmsKey,
    });
    const { filesBucket } = s3Stack;

    // Lambdas Stack
    const lambdasStack = new LambdasStack(this, 'DeepSeek-OCR-Lambdas-Stack', {
      vpc,
      kmsKey,
      fileBucketName: filesBucket.bucketName,
      securityGroup: securityGroups.lambdas,
      loadBalancerUrl: loadBalancer.loadBalancerDnsName,
    });
    const { startProcessingLambda } = lambdasStack;

    // Api Stack
    const apiGatewayStack = new ApiGatewayStack(this, 'DeepSeek-OCR-Api-Stack', {
      vpc,
      loadBalancer,
      startProcessingLambda,
    });
  }
}

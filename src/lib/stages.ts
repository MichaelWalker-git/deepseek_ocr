import { StackProps, Stage } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeepSeekOcrEcrConstruct } from '../constructs/deepseek-ocr-ecr';
import { ApiGatewayStack } from '../stacks/api-gateway.stack';
import { EcrStack } from '../stacks/ecr.stack';
import { EcsStack } from '../stacks/ecs.stack';
import { KmsStack } from '../stacks/kms.stack';
import { NetworkingStack } from '../stacks/networking.stack';

const REGION = process.env.CDK_DEFAULT_REGION || '';

export interface StackInputs extends StackProps {}

export class DevStage extends Stage {
  constructor(
    scope: Construct,
    id: string,
    args: StackInputs,
    props?: StackProps,
  ) {
    super(scope, id, props);

    if (!process.env.STAGE) {
      throw new Error('Missing required env vars: STAGE');
    }

    // KMS Stack
    const kmsStack = new KmsStack(this, 'DeepSeek-OCR-KMS-Stack');

    // Network Stack
    const networkingStack = new NetworkingStack(this, 'DeepSeek-OCR-Networking-Stack', {
      env: { region: REGION },
    });

    const { vpc, securityGroups } = networkingStack;

    // ECR Stack
    const ecrStack = new EcrStack(this, 'DeepSeek-OCR-ECR-Stack');
    const { repository } = ecrStack;

    // ECS Stack
    const ecsStack = new EcsStack(
      this,
      'DeepSeek-OCR-ECS-Stack',
      {
        vpc,
        repository,
        securityGroups,
        env: { region: REGION },
        ...args,
      },
    );

    ecsStack.addDependency(kmsStack);
    ecsStack.addDependency(networkingStack);
    ecsStack.addDependency(ecrStack);

    // const { loadBalancer } = backendAppStack;
    //
    // // Api Stack
    // const apiGatewayStack = new ApiGatewayStack(this, 'Api-Stack', {
    //   vpc,
    //   loadBalancer,
    // });
    //
    // apiGatewayStack.addDependency(kmsStack);
    // apiGatewayStack.addDependency(networkingStack);
    // apiGatewayStack.addDependency(backendAppStack);

  }
}

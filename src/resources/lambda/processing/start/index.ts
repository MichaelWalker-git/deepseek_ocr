import { join } from 'path';
import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { getCdkConstructId } from '../../../../shared/cdk-helpers';
import { DEFAULT_PROPS } from '../../../../shared/constants';
import { LambdaHandler } from '../../../../shared/types';

export const startProcessing: LambdaHandler = (scope, env, role, vpc, securityGroup) => {
  const constructId = getCdkConstructId({ resourceName: 'start-processing-lambda', addId: true }, scope);
  return new NodejsFunction(scope, constructId, {
    functionName: 'start-processing-lambda',
    ...DEFAULT_PROPS,
    role,
    vpc,
    securityGroups: [securityGroup],
    runtime: Runtime.NODEJS_22_X,
    reservedConcurrentExecutions: 5,
    timeout: Duration.minutes(5),
    entry: join(__dirname, '/handler.ts'),
    environment: env,
    bundling: {
      nodeModules: ['axios', 'form-data'],
    },
  });
};

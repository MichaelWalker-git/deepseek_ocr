import * as path from 'path';
import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';

export const STAGES = {
  dev: 'dev',
  prod: 'prod',
  test: 'test',
  FTR: 'FTR',
  MARKETPLACE: 'marketplace',
};

// Lambda
export const DEFAULT_PROPS: NodejsFunctionProps = {
  runtime: Runtime.NODEJS_18_X,
  memorySize: 512,
  timeout: Duration.seconds(30),
  depsLockFilePath: path.join(__dirname, '../../../', 'package-lock.json'),
  handler: 'handler',
  bundling: {
    externalModules: ['aws-sdk'],
  },
};

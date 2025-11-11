#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { config } from 'dotenv';

config();

import { DevStage } from './lib/stages';
import { STAGES } from './shared/constants';

// Environment variables with defaults for marketplace deployment
const CDK_DEFAULT_REGION = process.env.CDK_DEFAULT_REGION || 'us-east-1';
const CDK_DEFAULT_ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT || '';

const app = new cdk.App();

const props = {
  env: {
    region: CDK_DEFAULT_REGION,
    account: CDK_DEFAULT_ACCOUNT,
  },
};

// Deploy the marketplace stage
new DevStage(
  app,
  STAGES.dev,
  props,
);

// Synthesize the CloudFormation templates
app.synth();

// Log deployment information
console.log('🚀 Marketplace CloudFormation Template Generation Complete!');
console.log('🌍 Region:', CDK_DEFAULT_REGION);
console.log('📁 Output Directory: cdk.out/');

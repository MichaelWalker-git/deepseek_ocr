import { awscdk, javascript } from 'projen';

const project = new awscdk.AwsCdkTypeScriptApp({
  defaultReleaseBranch: 'main',
  cdkVersion: '2.221.0',
  name: 'deepseekocr',
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.PNPM,

  description: 'DeepSeek OCR Pipeline - Hybrid CDK implementation with ECS and A2I human review',

  deps: [
    // AWS SDK v3 for Lambda functions
    '@aws-sdk/client-ecs',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-sagemaker-a2i-runtime',
    '@aws-sdk/client-sfn',
    '@aws-sdk/client-ecr',
    '@aws-sdk/client-lambda',
    '@aws-sdk/client-sfn',
    '@aws-sdk/lib-dynamodb',
    '@aws-sdk/util-dynamodb',
    '@aws-sdk/s3-request-presigner',
    'aws-sdk',
    'dotenv',
    'cdk-nag',
    'axios',
    'form-data',
    'aws-lambda',
  ],

  devDeps: [
    '@types/aws-lambda',
    '@typescript-eslint/eslint-plugin',
    '@typescript-eslint/parser',
    '@types/node',
    'esbuild',
    '@stylistic/eslint-plugin',
    'esbuild',
    'eslint',
    'eslint-import-resolver-typescript',
    'eslint-plugin-import',
    'ts-jest',
    'ts-node',
    'typescript',
  ],

  context: {
    // Enable new features
    '@aws-cdk/core:newStyleStackSynthesis': true,
    '@aws-cdk/aws-apigateway:usagePlanKeyOrderInsensitiveId': true,
    '@aws-cdk/aws-ecs:arnFormatIncludesClusterName': true,
  },

  // Build configuration
  srcdir: 'src',
  testdir: 'test',
  libdir: 'lib',

  // ESLint and Prettier
  eslint: true,
  prettier: false,
  jest: false,

  // Additional scripts
  scripts: {
    'diff:dev': "cdk diff 'prod/*'",
    'deploy:dev': "STAGE=dev cdk deploy 'dev/*'",
    'destroy:dev': "STAGE=dev cdk destroy 'dev/*'",
    'synth:dev': 'STAGE=dev cdk synth',
  },

  gitignore: [
    'docker/models/',
    '*.pem',
    '.env',
    '.DS_Store',
    'cdk.out/',
    'local-docs/',
    '*.js',
    '*.d.ts',
    'node_modules/',
    'cdk.out/',
    '.env',
    '.env.local',
    '.env.*.local',
    'coverage/',
    '.nyc_output/',
    'dist/',
    'lib/',
    '*.tsbuildinfo',
    '.idea',
    '!src/lib/',
  ],

  // Sample code generation
  sampleCode: false,
});

// Add custom tasks
project.addTask('build-docker', {
  description: 'Build DeepSeek OCR Docker image',
  exec: 'docker build -t deepseek-ocr:latest docker/',
});

project.addTask('deploy-dev', {
  description: 'Deploy to development environment',
  exec: 'cdk deploy --profile dev --context environment=development',
});

project.addTask('deploy-prod', {
  description: 'Deploy to production environment',
  exec: 'cdk deploy --profile prod --context environment=production --require-approval never',
});

project.synth();

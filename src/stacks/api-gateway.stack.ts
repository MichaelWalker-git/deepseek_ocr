import { RemovalPolicy } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { LambdaIntegration, ResponseType } from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface ApiGatewayProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  startProcessingLambda: IFunction;
  loadBalancer?: elbv2.IApplicationLoadBalancer;
  enableApiKeys?: boolean;
  usagePlan?: {
    throttleRateLimit?: number;
    throttleBurstLimit?: number;
    quotaLimit?: number;
    quotaPeriod?: apigateway.Period;
  };
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public apiKey?: apigateway.ApiKey;
  public usagePlan?: apigateway.UsagePlan;
  private requestValidator?: apigateway.RequestValidator;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    const {
      vpc,
      loadBalancer,
      startProcessingLambda,
      enableApiKeys = true,
      usagePlan = {
        throttleRateLimit: 100,
        throttleBurstLimit: 200,
        quotaLimit: 10000,
        quotaPeriod: apigateway.Period.DAY,
      },
    } = props;

    // Create KMS key for CloudWatch logs encryption (HIPAA compliance)
    const logGroupKey = new kms.Key(this, getCdkConstructId({ resourceName: 'log-group-key' }, scope), {
      description: `KMS key for CloudWatch log group encryption - DeepSeek OCR ${process.env.STAGE}`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Grant CloudWatch Logs service permission to use the key
    logGroupKey.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      sid: 'Enable CloudWatch Logs',
      effect: cdk.aws_iam.Effect.ALLOW,
      principals: [new cdk.aws_iam.ServicePrincipal('logs.amazonaws.com')],
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:CreateGrant',
        'kms:DescribeKey',
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/apigateway/deepseek-ocr-${process.env.STAGE}`,
        },
      },
    }));

    // Create CloudWatch log group for API Gateway logs with KMS encryption
    const logGroup = new logs.LogGroup(this, getCdkConstructId({ resourceName: 'log-group' }, scope), {
      logGroupName: `/aws/apigateway/deepseek-ocr-${process.env.STAGE}`,
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: logGroupKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create REST API
    this.api = new apigateway.RestApi(this, getCdkConstructId({ resourceName: 'api' }, scope), {
      restApiName: getCdkConstructId({ resourceName: 'api' }, scope),
      description: `DeepSeek OCR API for ${process.env.STAGE} environment`,

      // CORS configuration
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },

      // Binary media types for file uploads
      binaryMediaTypes: [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/gif',
        'image/bmp',
        'image/tiff',
        'multipart/form-data',
      ],

      // Deployment options
      deploy: true,
      deployOptions: {
        stageName: process.env.STAGE,
        throttlingRateLimit: usagePlan.throttleRateLimit,
        throttlingBurstLimit: usagePlan.throttleBurstLimit,

        // Enable CloudWatch logging
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),

        // Enable X-Ray tracing (HIPAA compliance)
        tracingEnabled: true,
      },
    });

    const corsHeaders = {
      'Access-Control-Allow-Origin': "'*'", // or your CF origin in single quotes
      'Access-Control-Allow-Headers': "'*'",
      'Access-Control-Allow-Methods': "'GET,OPTIONS,POST,PUT,DELETE'",
    };

    // 401 from authorizer
    this.api.addGatewayResponse('UnauthorizedResponse', {
      type: ResponseType.UNAUTHORIZED,
      responseHeaders: corsHeaders,
    });

    // 403 (IAM/Authorizer policy denies)
    this.api.addGatewayResponse('AccessDeniedResponse', {
      type: ResponseType.ACCESS_DENIED,
      responseHeaders: corsHeaders,
    });

    // generic 4xx/5xx
    this.api.addGatewayResponse('Default4xx', {
      type: ResponseType.DEFAULT_4XX,
      responseHeaders: corsHeaders,
    });

    this.api.addGatewayResponse('Default5xx', {
      type: ResponseType.DEFAULT_5XX,
      responseHeaders: corsHeaders,
    });

    // Create the request validator once
    this.requestValidator = this.createRequestValidator(scope);

    // Add API resources and methods
    this.createApiResources({ loadBalancer, startProcessingLambda });

    // Create API Key and Usage Plan if enabled
    if (enableApiKeys) {
      this.createApiKeyAndUsagePlan(usagePlan, scope);
    }
  }

  private createApiResources({
    loadBalancer,
    startProcessingLambda,
  }:
  {
    loadBalancer?: elbv2.IApplicationLoadBalancer;
    startProcessingLambda: IFunction;
  }): void {
    // Health check endpoint - specific integration
    const health = this.api.root.addResource('health');
    const healthIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'GET',
      uri: `http://${loadBalancer?.loadBalancerDnsName || ''}/health`,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        timeout: cdk.Duration.seconds(29),
        requestParameters: {
          'integration.request.header.Accept': "'application/json'",
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
        ],
      },
    });

    health.addMethod('GET', healthIntegration, {
      apiKeyRequired: false, // Health check doesn't need API key
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // OCR endpoints
    const ocr = this.api.root.addResource('ocr');

    // Image OCR endpoint
    const image = ocr.addResource('image');
    const imageIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'POST',
      uri: `http://${loadBalancer?.loadBalancerDnsName || ''}/ocr/image`,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        timeout: cdk.Duration.seconds(29),
        requestParameters: {
          'integration.request.header.Content-Type': 'method.request.header.Content-Type',
          'integration.request.header.X-Api-Key': 'method.request.header.X-Api-Key',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
        ],
      },
    });

    image.addMethod('POST', imageIntegration, {
      requestValidator: this.requestValidator,
      apiKeyRequired: true,
      requestParameters: {
        'method.request.header.Content-Type': true,
        'method.request.header.X-Api-Key': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // PDF OCR endpoint
    const pdf = ocr.addResource('pdf');
    const pdfIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'POST',
      uri: `http://${loadBalancer?.loadBalancerDnsName || ''}/ocr/pdf`,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        timeout: cdk.Duration.seconds(29),
        requestParameters: {
          'integration.request.header.Content-Type': 'method.request.header.Content-Type',
          'integration.request.header.X-Api-Key': 'method.request.header.X-Api-Key',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
        ],
      },
    });

    pdf.addMethod('POST', pdfIntegration, {
      requestValidator: this.requestValidator,
      apiKeyRequired: true,
      requestParameters: {
        'method.request.header.Content-Type': true,
        'method.request.header.X-Api-Key': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // Batch OCR endpoint
    const batch = ocr.addResource('batch');
    const batchIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'POST',
      uri: `http://${loadBalancer?.loadBalancerDnsName || ''}/ocr/batch`,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        timeout: cdk.Duration.seconds(29),
        requestParameters: {
          'integration.request.header.Content-Type': 'method.request.header.Content-Type',
          'integration.request.header.X-Api-Key': 'method.request.header.X-Api-Key',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
        ],
      },
    });

    batch.addMethod('POST', batchIntegration, {
      requestValidator: this.requestValidator,
      apiKeyRequired: true,
      requestParameters: {
        'method.request.header.Content-Type': true,
        'method.request.header.X-Api-Key': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // s3 OCR endpoint
    const s3 = ocr.addResource('s3');
    s3.addMethod('POST', new LambdaIntegration(startProcessingLambda), {
      requestValidator: this.requestValidator,
      apiKeyRequired: true,
      requestParameters: {
        'method.request.header.Content-Type': true,
        'method.request.header.X-Api-Key': true,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // Add a catch-all proxy resource for any other paths
    // This uses the {proxy+} pattern correctly
    const proxyResource = this.api.root.addResource('{proxy+}');
    const proxyIntegration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'ANY',
      uri: `http://${loadBalancer?.loadBalancerDnsName || ''}/{proxy}`,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        timeout: cdk.Duration.seconds(29),
        requestParameters: {
          'integration.request.path.proxy': 'method.request.path.proxy',
          'integration.request.header.Content-Type': 'method.request.header.Content-Type',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
        ],
      },
    });

    proxyResource.addMethod('ANY', proxyIntegration, {
      requestParameters: {
        'method.request.path.proxy': true,
        'method.request.header.Content-Type': false,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });
  }

  private createRequestValidator(scope: Construct): apigateway.RequestValidator {
    return new apigateway.RequestValidator(this, getCdkConstructId({ resourceName: 'request-validator' }, scope), {
      restApi: this.api,
      requestValidatorName: getCdkConstructId({ resourceName: 'validator' }, this),
      validateRequestBody: true,
      validateRequestParameters: true,
    });
  }

  private createApiKeyAndUsagePlan(usagePlanConfig: NonNullable<ApiGatewayProps['usagePlan']>, scope: Construct): void {
    // Create API Key
    this.apiKey = new apigateway.ApiKey(this, getCdkConstructId({ resourceName: 'api-key' }, scope), {
      apiKeyName: getCdkConstructId({ resourceName: 'api-key' }, this),
      description: 'API Key for DeepSeek OCR service',
      enabled: true,
    });

    // Create Usage Plan
    this.usagePlan = new apigateway.UsagePlan(this, getCdkConstructId({ resourceName: 'usage-plan' }, scope), {
      name: getCdkConstructId({ resourceName: 'usage-plan' }, this),
      description: 'Usage plan for DeepSeek OCR API',

      // Throttling configuration
      throttle: {
        rateLimit: usagePlanConfig.throttleRateLimit || 100,
        burstLimit: usagePlanConfig.throttleBurstLimit || 200,
      },

      // Quota configuration
      quota: {
        limit: usagePlanConfig.quotaLimit || 10000,
        period: usagePlanConfig.quotaPeriod || apigateway.Period.DAY,
      },

      // Associate with API stages
      apiStages: [
        {
          api: this.api,
          stage: this.api.deploymentStage,
        },
      ],
    });

    // Associate API Key with Usage Plan
    this.usagePlan.addApiKey(this.apiKey);
  }
}

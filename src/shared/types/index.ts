import { ISecurityGroup, IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Role } from 'aws-cdk-lib/aws-iam';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import {
  APIGatewayProxyEventPathParameters,
  APIGatewayProxyEventQueryStringParameters,
  APIGatewayProxyEventV2WithRequestContext,
} from 'aws-lambda';
import { Construct } from 'constructs';


export interface LambdaHandlerEvent<
  T = Record<string, unknown>,
  S = Record<string, unknown>,
> extends APIGatewayProxyEventV2WithRequestContext<Record<any, any>> {
  pathParameters: APIGatewayProxyEventPathParameters & T;
  queryStringParameters: APIGatewayProxyEventQueryStringParameters & S;
  body: string;
  Records: Record<any, any>;
}

export interface LambdaHandler {
  (
    scope: Construct,
    env: Record<string, string> | undefined,
    role: Role,
    vpc: IVpc,
    securityGroup: SecurityGroup | ISecurityGroup,
    args?: any
  ): IFunction;
}

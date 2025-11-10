import { Tags } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface NetworkingProps extends cdk.StackProps {
  vpcCidr?: string;
  maxAzs?: number;
  enableNatGateway?: boolean;
}

export class NetworkingStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
    lambdas: ec2.SecurityGroup;
  };

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);

    const {
      vpcCidr = '10.0.0.0/16',
      maxAzs = 3,
      enableNatGateway = true,
    } = props;

    // Create VPC
    this.vpc = new ec2.Vpc(this, getCdkConstructId({ resourceName: 'vpc' }, scope), {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs,
      enableDnsHostnames: true,
      enableDnsSupport: true,

      // Subnet configuration
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],

      // NAT Gateway configuration
      natGateways: enableNatGateway ? 1 : 0,

      // Gateway endpoints for cost optimization
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
        DynamoDB: {
          service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        },
      },
    });

    // Store subnet references
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;

    // Create VPC Endpoints for AWS services to reduce NAT Gateway costs
    this.createVpcEndpoints();

    // Create security groups
    this.securityGroups = this.createSecurityGroups();

    Tags.of(this.vpc).add('Purpose', 'DeepSeek-OCR-Pipeline');
  }

  private createVpcEndpoints(): void {
    // ECR API endpoint
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ECR Docker endpoint
    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ECS endpoint
    this.vpc.addInterfaceEndpoint('EcsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // CloudWatch Logs endpoint
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Step Functions endpoint
    this.vpc.addInterfaceEndpoint('StepFunctionsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
  }

  private createSecurityGroups() {
    // Application Load Balancer security group
    const albSg = new ec2.SecurityGroup(this, getCdkConstructId({ resourceName: 'alb-security-group' }, this), {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: false,
    });

    // Allow HTTP/HTTPS inbound traffic
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic',
    );

    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic',
    );

    // Allow outbound to ECS tasks
    albSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8000),
      'Allow traffic to ECS tasks',
    );

    // ECS tasks security group
    const ecsSg = new ec2.SecurityGroup(this, getCdkConstructId({ resourceName: 'ecs-security-group' }, this), {
      vpc: this.vpc,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true, // Required for pulling images and making API calls
    });

    // Allow traffic from ALB
    ecsSg.addIngressRule(
      albSg,
      ec2.Port.tcp(8000),
      'Allow traffic from ALB',
    );

    // Allow health checks from ALB
    ecsSg.addIngressRule(
      albSg,
      ec2.Port.tcp(8000),
      'Allow health checks from ALB',
    );

    //Lambdas security group
    const lambdasSg = new ec2.SecurityGroup(this, getCdkConstructId({ resourceName: 'lambdas-security-group' }, this), {
      vpc: this.vpc,
      description: 'Security group for Lambdas',
      allowAllOutbound: true,
    });

    return {
      ecs: ecsSg,
      alb: albSg,
      lambdas: lambdasSg,
    };
  }
}

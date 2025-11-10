import { Duration, RemovalPolicy, Size } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface DeepSeekOcrEc2GpuProps {
  vpc: ec2.IVpc;
  securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
  };
  ecrRepository: ecr.IRepository;
  imageTag?: string;
  minCapacity?: number;
  maxCapacity?: number;
  desiredCapacity?: number;
  kmsKey: kms.IKey;
  accessLogsBucket?: s3.IBucket;
  instanceType?: ec2.InstanceType;
  spotPrice?: string;
}

export class DeepSeekOcrEc2GpuConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.Ec2Service;
  public readonly taskDefinition: ecs.Ec2TaskDefinition;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly listener: elbv2.ApplicationListener;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

  constructor(scope: Construct, id: string, props: DeepSeekOcrEc2GpuProps) {
    super(scope, id);

    const {
      vpc,
      securityGroups,
      ecrRepository,
      imageTag = 'latest',
      minCapacity = 1,
      maxCapacity = 3,
      desiredCapacity = 1, // Start with 1 GPU instance
      kmsKey,
      accessLogsBucket,
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE),
      spotPrice,
    } = props;

    // Create ECS cluster
    this.cluster = new ecs.Cluster(this, getCdkConstructId({ resourceName: 'gpu-cluster' }, this), {
      vpc,
      clusterName: getCdkConstructId({ resourceName: 'gpu-cluster' }, this),
      containerInsights: true,
    });

    // Create Launch Template for GPU instances
    const launchTemplate = new ec2.LaunchTemplate(this, getCdkConstructId({ resourceName: 'gpu-launch-template' }, this), {
      instanceType,
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU), // GPU-optimized AMI
      userData: ec2.UserData.forLinux(),
      securityGroup: securityGroups.ecs,
      role: this.createInstanceRole(),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(200, { // Increased to 200GB for model storage
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // Add user data to configure the ECS agent
    launchTemplate.userData?.addCommands(
      'echo ECS_CLUSTER=' + this.cluster.clusterName + ' >> /etc/ecs/ecs.config',
      'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config',
      'echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config',
      // Install NVIDIA drivers if not present
      'yum install -y nvidia-docker2',
      'systemctl restart docker',
      // Configure GPU for container usage
      'nvidia-smi',
      // Create directory for model cache
      'mkdir -p /mnt/ecs-data/models',
      'chmod 777 /mnt/ecs-data/models',
    );

    // Create Auto Scaling Group with mixed instances strategy
    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, getCdkConstructId({ resourceName: 'gpu-asg' }, this), {
      vpc,
      minCapacity,
      maxCapacity,
      desiredCapacity,
      launchTemplate,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });

    // Configure mixed instances for cost optimization (on-demand + spot)
    if (spotPrice) {
      const cfnAutoScalingGroup = this.autoScalingGroup.node.defaultChild as autoscaling.CfnAutoScalingGroup;
      cfnAutoScalingGroup.mixedInstancesPolicy = {
        instancesDistribution: {
          onDemandBaseCapacity: 1, // Keep at least 1 on-demand instance
          onDemandPercentageAboveBaseCapacity: 0, // Use spot for additional capacity
          spotInstancePools: 2,
          spotMaxPrice: spotPrice,
        },
        launchTemplate: {
          launchTemplateSpecification: {
            launchTemplateId: launchTemplate.launchTemplateId,
            version: '$Latest',
          },
          overrides: [
            { instanceType: 'g4dn.xlarge' },
            { instanceType: 'g4dn.2xlarge' }, // Fallback option
            { instanceType: 'g5.xlarge' }, // Alternative GPU instance type
          ],
        },
      };
    }

    // Add capacity provider to cluster
    const capacityProvider = new ecs.AsgCapacityProvider(this, getCdkConstructId({ resourceName: 'gpu-capacity-provider' }, this), {
      autoScalingGroup: this.autoScalingGroup,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      targetCapacityPercent: 100,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 1,
    });

    this.cluster.addAsgCapacityProvider(capacityProvider);

    // Create Application Load Balancer
    const logsBucket = accessLogsBucket || new s3.Bucket(this, getCdkConstructId({ resourceName: 'alb-logs-bucket' }, this), {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{
        expiration: Duration.days(90),
      }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, getCdkConstructId({ resourceName: 'load-balancer' }, this), {
      vpc,
      internetFacing: true,
      securityGroup: securityGroups.alb,
      loadBalancerName: getCdkConstructId({ resourceName: 'gpu-lb' }, this),
      deletionProtection: false,
      dropInvalidHeaderFields: true,
    });

    this.loadBalancer.logAccessLogs(logsBucket, 'alb-access-logs');
    this.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');

    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, getCdkConstructId({ resourceName: 'target-group' }, this), {
      vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE, // Use INSTANCE for EC2
      targetGroupName: getCdkConstructId({ resourceName: 'gpu-tg' }, this),
      healthCheck: {
        enabled: true,
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        port: '8000',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: Duration.seconds(30), // Longer timeout for GPU model loading
        interval: Duration.seconds(60),
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(60),
      stickinessCookieDuration: Duration.hours(1), // Enable session stickiness
    });

    // Create listener
    this.listener = this.loadBalancer.addListener(getCdkConstructId({ resourceName: 'listener' }, this), {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });

    // Create task definition
    this.taskDefinition = this.createTaskDefinition(
      ecrRepository,
      imageTag,
      kmsKey,
    );

    // Create ECS service
    this.service = new ecs.Ec2Service(this, getCdkConstructId({ resourceName: 'gpu-service' }, this), {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: getCdkConstructId({ resourceName: 'gpu-service' }, this),
      desiredCount: desiredCapacity,
      enableExecuteCommand: true,
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          weight: 1,
          base: 1,
        },
      ],
      placementStrategies: [
        ecs.PlacementStrategy.spreadAcrossInstances(),
      ],
      placementConstraints: [
        ecs.PlacementConstraint.memberOf('attribute:ecs.instance-type =~ g4dn.*'),
      ],
    });

    // Register service with target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Configure auto scaling for the service
    this.configureServiceAutoScaling(minCapacity, maxCapacity);
  }

  private createInstanceRole(): iam.Role {
    const role = new iam.Role(this, getCdkConstructId({ resourceName: 'instance-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add permissions for GPU monitoring
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
        'ec2:DescribeVolumes',
        'ec2:DescribeTags',
        'logs:PutLogEvents',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
      ],
      resources: ['*'],
    }));

    return role;
  }

  private createTaskDefinition(
    ecrRepository: ecr.IRepository,
    imageTag: string,
    kmsKey: kms.IKey,
  ): ecs.Ec2TaskDefinition {
    // Create task execution role
    const taskExecutionRole = new iam.Role(this, getCdkConstructId({ resourceName: 'execution-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Add ECR permissions
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // Add KMS permissions for logs
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:GenerateDataKey',
      ],
      resources: [kmsKey.keyArn],
    }));

    // Create task role
    const taskRole = new iam.Role(this, getCdkConstructId({ resourceName: 'task-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add permissions for S3 (for model storage)
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
      ],
      resources: [
        'arn:aws:s3:::*-deepseek-ocr-models/*',
        'arn:aws:s3:::*-deepseek-ocr-models',
      ],
    }));

    // Create EC2 task definition with GPU support
    const taskDefinition = new ecs.Ec2TaskDefinition(this, getCdkConstructId({ resourceName: 'gpu-task-definition' }, this), {
      executionRole: taskExecutionRole,
      taskRole,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    // Create log group
    const logGroup = new logs.LogGroup(this, getCdkConstructId({ resourceName: 'log-group' }, this), {
      logGroupName: '/aws/ecs/deepseek-ocr-gpu',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
      encryptionKey: kmsKey,
    });

    // Create secrets for sensitive environment variables
    const secretsManager = new secretsmanager.Secret(this, getCdkConstructId({ resourceName: 'env-secrets' }, this), {
      description: 'Environment secrets for DeepSeek OCR GPU container',
      encryptionKey: kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          HUGGINGFACE_TOKEN: '', // Add your HuggingFace token if model is private
        }),
        generateStringKey: 'api_key',
      },
    });

    // Add container with GPU support
    const container = taskDefinition.addContainer(getCdkConstructId({ resourceName: 'gpu-container' }, this), {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, imageTag),

      // Allocate significant resources for the GPU model
      memoryReservationMiB: 14336, // 14GB (leaving 2GB for system on g4dn.xlarge with 16GB)
      cpu: 3840, // 3.75 vCPU (leaving 0.25 for system on 4 vCPU instance)

      // GPU configuration
      gpuCount: 1, // Request 1 GPU

      // Environment variables - FIXED: Use HuggingFace repository ID, not local path
      environment: {
        // GPU settings
        CUDA_VISIBLE_DEVICES: '0',

        // CRITICAL FIX: Use the HuggingFace repository ID instead of local path
        MODEL_PATH: 'deepseek-ai/DeepSeek-OCR', // This is the HuggingFace repo ID
        VLLM_TORCH_DTYPE: 'half',

        // Model caching directories
        HF_HOME: '/app/models',
        TRANSFORMERS_CACHE: '/app/models',
        HUGGINGFACE_HUB_CACHE: '/app/models',

        // Performance settings
        MAX_CONCURRENCY: '5',
        GPU_MEMORY_UTILIZATION: '0.85',
        VLLM_USE_V1: '0',
        LOG_LEVEL: 'INFO',

        // Optional: S3 backup for model cache (can be removed if not using S3)
        MODEL_CACHE_DIR: '/app/models',
        S3_MODEL_BUCKET: `${this.node.tryGetContext('environment')}-deepseek-ocr-models`,
      },

      // Secrets (only if model is private)
      secrets: {
        // HUGGINGFACE_TOKEN: ecs.Secret.fromSecretsManager(secretsManager, 'HUGGINGFACE_TOKEN'),
      },

      // Logging
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'deepseek-ocr-gpu',
        logGroup,
      }),

      // Health check with longer timeout for model download
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval: Duration.seconds(60),
        timeout: Duration.seconds(30),
        retries: 10, // Increased retries
        startPeriod: Duration.seconds(300), // 10 minutes for initial model download
      },

      essential: true,
      stopTimeout: Duration.seconds(120),
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: 8000,
      hostPort: 8000,
      protocol: ecs.Protocol.TCP,
    });

    // Add ulimits for better GPU performance
    container.addUlimits({
      name: ecs.UlimitName.MEMLOCK,
      softLimit: -1,
      hardLimit: -1,
    });

    // Add mount points for model cache persistence (using host volume)
    container.addMountPoints({
      containerPath: '/app/models',
      sourceVolume: 'model-cache',
      readOnly: false,
    });

    // Add host volume for model cache
    taskDefinition.addVolume({
      name: 'model-cache',
      host: {
        sourcePath: '/mnt/ecs-data/models',
      },
    });

    return taskDefinition;
  }

  private configureServiceAutoScaling(minCapacity: number, maxCapacity: number): void {
    // Configure service auto scaling
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity,
      maxCapacity,
    });

    // Scale based on custom CloudWatch metric (GPU utilization)
    scalableTarget.scaleOnMetric('GpuUtilization', {
      metric: this.targetGroup.metricRequestCount({
        period: Duration.minutes(1),
        statistic: 'sum',
      }),
      scalingSteps: [
        { upper: 10, change: -1 },
        { lower: 50, change: +1 },
        { lower: 100, change: +2 },
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(5),
    });

    // Scale based on ALB request count
    scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 100,
      targetGroup: this.targetGroup,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
  }
}

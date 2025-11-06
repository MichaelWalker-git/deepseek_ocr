import * as cdk from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { DeepSeekOcrEcrConstruct } from '../constructs/deepseek-ocr-ecr';

export class EcrStack extends cdk.Stack {
  public readonly repository: Repository;

  constructor(scope: Construct, id: string ) {
    super(scope, id);

    const ecrConstruct = new DeepSeekOcrEcrConstruct(this, 'DeepSeek-OCR-ECR');
    this.repository = ecrConstruct.repository;
  }
}

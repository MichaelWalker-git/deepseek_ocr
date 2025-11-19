#!/bin/bash
# Automated deployment script for DeepSeek OCR updates
# This script handles the complete deployment pipeline:
# 1. Uploads Docker source to S3
# 2. Triggers CodeBuild to build and push to ECR
# 3. Updates ECS service with the new image

set -e

# Configuration
PROJECT_NAME="deepseek-ocr-docker-build"
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID:-098305555551}
AWS_PROFILE=${AWS_PROFILE:-miketran+SA}
S3_BUCKET="dev-deepseek-ocr-files-bucket"
S3_KEY="codebuild-source/docker-source.zip"
ECS_CLUSTER="dev-deepseek-ocr-gpu-cluster"
ECS_SERVICE="dev-deepseek-ocr-gpu-service"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting DeepSeek OCR Deployment Pipeline${NC}"

# Step 1: Create source bundle
echo -e "\n${YELLOW}📦 Step 1: Preparing source code for upload...${NC}"
cd docker
TEMP_DIR=$(mktemp -d)
zip -r ${TEMP_DIR}/docker-source.zip . -x "*.git*" "*.DS_Store"

# Step 2: Upload to S3
echo -e "\n${YELLOW}📤 Step 2: Uploading source to S3...${NC}"
aws s3 cp ${TEMP_DIR}/docker-source.zip s3://${S3_BUCKET}/${S3_KEY} --profile ${AWS_PROFILE}

# Step 3: Update CodeBuild project
echo -e "\n${YELLOW}🔧 Step 3: Updating CodeBuild project to use S3 source...${NC}"
aws codebuild update-project \
  --name ${PROJECT_NAME} \
  --source "type=S3,location=${S3_BUCKET}/${S3_KEY}" \
  --region ${AWS_REGION} \
  --profile ${AWS_PROFILE} > /dev/null

# Step 4: Start CodeBuild
echo -e "\n${YELLOW}🔨 Step 4: Starting CodeBuild...${NC}"
BUILD_ID=$(aws codebuild start-build \
  --project-name ${PROJECT_NAME} \
  --region ${AWS_REGION} \
  --profile ${AWS_PROFILE} \
  --query 'build.id' \
  --output text)

echo -e "Build started: ${BUILD_ID}"

# Step 5: Wait for build to complete
echo -e "\n${YELLOW}⏳ Step 5: Waiting for build to complete...${NC}"
echo "This typically takes 5-10 minutes for the Docker image build."

while true; do
  BUILD_STATUS=$(aws codebuild batch-get-builds \
    --ids ${BUILD_ID} \
    --profile ${AWS_PROFILE} \
    --query 'builds[0].buildStatus' \
    --output text)
  
  echo -ne "\rBuild status: ${BUILD_STATUS}    "
  
  if [ "$BUILD_STATUS" = "SUCCEEDED" ]; then
    echo -e "\n${GREEN}✅ Build completed successfully!${NC}"
    break
  elif [ "$BUILD_STATUS" = "FAILED" ] || [ "$BUILD_STATUS" = "FAULT" ] || [ "$BUILD_STATUS" = "TIMED_OUT" ] || [ "$BUILD_STATUS" = "STOPPED" ]; then
    echo -e "\n${RED}❌ Build failed with status: ${BUILD_STATUS}${NC}"
    echo "Check the build logs: https://console.aws.amazon.com/codesuite/codebuild/projects/${PROJECT_NAME}/build/${BUILD_ID##*/}"
    exit 1
  fi
  
  sleep 10
done

# Step 6: Force new ECS deployment
echo -e "\n${YELLOW}🚀 Step 6: Updating ECS service with new image...${NC}"
aws ecs update-service \
  --cluster ${ECS_CLUSTER} \
  --service ${ECS_SERVICE} \
  --force-new-deployment \
  --profile ${AWS_PROFILE} \
  --query 'service.serviceName' \
  --output text > /dev/null

echo -e "${GREEN}✅ ECS service update initiated${NC}"

# Step 7: Monitor deployment
echo -e "\n${YELLOW}📊 Step 7: Monitoring ECS deployment...${NC}"
echo "Waiting for new tasks to start..."

# Wait for deployment to stabilize
DEPLOYMENT_COMPLETE=false
MAX_WAIT_TIME=600 # 10 minutes
ELAPSED_TIME=0

while [ "$DEPLOYMENT_COMPLETE" = false ] && [ $ELAPSED_TIME -lt $MAX_WAIT_TIME ]; do
  DEPLOYMENT_STATUS=$(aws ecs describe-services \
    --cluster ${ECS_CLUSTER} \
    --services ${ECS_SERVICE} \
    --profile ${AWS_PROFILE} \
    --query 'services[0].deployments[0].{Status:status,Running:runningCount,Desired:desiredCount,RolloutState:rolloutState}' \
    --output json)
  
  RUNNING_COUNT=$(echo $DEPLOYMENT_STATUS | jq -r '.Running')
  DESIRED_COUNT=$(echo $DEPLOYMENT_STATUS | jq -r '.Desired')
  ROLLOUT_STATE=$(echo $DEPLOYMENT_STATUS | jq -r '.RolloutState')
  
  echo -ne "\rDeployment: Running=$RUNNING_COUNT Desired=$DESIRED_COUNT State=$ROLLOUT_STATE    "
  
  if [ "$ROLLOUT_STATE" = "COMPLETED" ] && [ "$RUNNING_COUNT" = "$DESIRED_COUNT" ] && [ "$DESIRED_COUNT" != "0" ]; then
    DEPLOYMENT_COMPLETE=true
    echo -e "\n${GREEN}✅ Deployment completed successfully!${NC}"
  elif [ "$ROLLOUT_STATE" = "FAILED" ]; then
    echo -e "\n${RED}❌ Deployment failed!${NC}"
    exit 1
  fi
  
  sleep 10
  ELAPSED_TIME=$((ELAPSED_TIME + 10))
done

if [ "$DEPLOYMENT_COMPLETE" = false ]; then
  echo -e "\n${YELLOW}⚠️  Deployment is taking longer than expected. Check ECS console for details.${NC}"
fi

# Step 8: Health check
echo -e "\n${YELLOW}🏥 Step 8: Running health check...${NC}"
LOAD_BALANCER_URL="http://dev-deepseek-ocr-gpu-lb-1737323494.us-east-1.elb.amazonaws.com"

# Wait a bit for the service to stabilize
sleep 30

HEALTH_CHECK=$(curl -s ${LOAD_BALANCER_URL}/health | jq -r '.status' 2>/dev/null || echo "failed")

if [ "$HEALTH_CHECK" = "healthy" ]; then
  echo -e "${GREEN}✅ Service is healthy!${NC}"
  echo -e "\n${GREEN}🎉 Deployment completed successfully!${NC}"
  echo -e "Service endpoint: ${LOAD_BALANCER_URL}"
else
  echo -e "${YELLOW}⚠️  Health check returned: ${HEALTH_CHECK}${NC}"
  echo "The service may still be starting up. Check the endpoint manually:"
  echo "${LOAD_BALANCER_URL}/health"
fi

# Cleanup
rm -rf ${TEMP_DIR}
cd ..

echo -e "\n${GREEN}📝 Summary:${NC}"
echo "- Docker image built and pushed to ECR"
echo "- ECS service updated with new image"
echo "- Service endpoint: ${LOAD_BALANCER_URL}"
echo ""
echo "Next steps:"
echo "1. Test the OCR endpoint with: curl -X POST ${LOAD_BALANCER_URL}/ocr/image -F 'file=@your_image.png'"
echo "2. Monitor logs: aws logs tail /aws/ecs/deepseek-ocr-gpu --profile ${AWS_PROFILE} --follow"

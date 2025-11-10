import { getLambdaResponse } from '../../../../shared/cdk-helpers';
import { ClientError, errorHandler } from '../../../../shared/services/Errors';
import { getFileAsBuffer } from '../../../../shared/services/S3';
import { LambdaHandlerEvent } from '../../../../shared/types';
import { processImage, processPdf, processBatch } from '../helpers';

const FILES_BUCKET = process.env.FILES_BUCKET || '';

export const handler = async (event: LambdaHandlerEvent) => {
  try {
    console.log('Event:', JSON.stringify(event, null, 2));

    // Parse request body
    const body = JSON.parse(event.body);
    const {
      s3Key,
      s3Keys,
      prompt = '<image>',
      grounded = false,
      temperature,
      top_p,
      max_tokens,
    } = body;

    // Validate input
    if (!s3Key && !s3Keys) {
      throw new ClientError('Required s3Key or s3Keys is missing', 400);
    }

    console.log(`Grounded OCR mode: ${grounded}`);

    // Log sampling parameters if provided
    if (temperature !== undefined || top_p !== undefined || max_tokens !== undefined) {
      console.log(`Sampling parameters - temperature: ${temperature}, top_p: ${top_p}, max_tokens: ${max_tokens}`);
    }

    // Handle batch processing if multiple keys provided
    if (s3Keys && Array.isArray(s3Keys)) {
      console.log(`Processing batch of ${s3Keys.length} files`);

      const files = await Promise.all(
        s3Keys.map(async (key: string) => {
          const buffer = await getFileAsBuffer(FILES_BUCKET, key);
          const isPdf = key.toLowerCase().endsWith('.pdf');
          const contentType = isPdf ? 'application/pdf' : 'image/jpeg';

          return {
            buffer,
            filename: key.split('/').pop() || key,
            contentType,
          };
        }),
      );

      const result = await processBatch(files, prompt, grounded, temperature, top_p, max_tokens);
      console.log('Batch result:', JSON.stringify(result, null, 2));

      return getLambdaResponse(result);
    }

    // Single file processing
    if (!s3Key) {
      throw new ClientError('s3Key is required for single file processing', 400);
    }

    // Determine file type
    const lowerKey = s3Key.toLowerCase();
    const isPdf = lowerKey.endsWith('.pdf');
    const isImage = lowerKey.endsWith('.jpg') ||
      lowerKey.endsWith('.jpeg') ||
      lowerKey.endsWith('.png') ||
      lowerKey.endsWith('.gif') ||
      lowerKey.endsWith('.webp');

    console.log(`Processing file: ${s3Key}`);
    console.log(`File type - PDF: ${isPdf}, Image: ${isImage}`);
    console.log(`Using prompt: ${prompt}`);
    console.log(`Grounded mode: ${grounded}`);

    // Get file from S3
    const buffer = await getFileAsBuffer(FILES_BUCKET, s3Key);
    console.log(`Retrieved file from S3, size: ${buffer.length} bytes`);

    let result;

    if (isPdf) {
      // Process PDF
      console.log('Processing as PDF...');
      result = await processPdf(buffer, prompt, grounded, temperature, top_p, max_tokens);
    } else if (isImage) {
      // Process Image
      console.log('Processing as image...');
      result = await processImage(buffer, prompt, grounded, temperature, top_p, max_tokens);
    } else {
      throw new ClientError(
        `Unsupported file type for ${s3Key}. Supported types: .pdf, .jpg, .jpeg, .png, .gif, .webp`,
        400,
      );
    }

    console.log('OCR result:', JSON.stringify(result, null, 2));

    return getLambdaResponse(result);
  } catch (e) {
    console.error('Handler error:', e);
    return errorHandler(e as Error);
  }
};

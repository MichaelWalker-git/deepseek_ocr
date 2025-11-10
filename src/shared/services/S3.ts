import { Readable } from 'stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand, GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Environment variables
const region = process.env.REGION || 'us-east-1';

// Error types
type S3ErrorType =
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'BUCKET_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'INVALID_INPUT'
  | 'UNKNOWN_ERROR';

// Custom error class
class S3ServiceError extends Error {
  constructor(
    public readonly type: S3ErrorType,
    message: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'S3ServiceError';
  }
}

// Initialize S3 client once
const s3Client = new S3Client({ region });

// Pure function to format error response
const formatS3Error = (error: any): S3ServiceError => {
  if (!error) {
    return new S3ServiceError('UNKNOWN_ERROR', 'Unknown error occurred');
  }

  const errorMessage = error.message || 'Unknown error occurred';

  if (error.name === 'NoSuchKey') {
    return new S3ServiceError('FILE_NOT_FOUND', `File not found: ${errorMessage}`, error);
  }

  if (error.name === 'AccessDenied') {
    return new S3ServiceError('PERMISSION_DENIED', `Access denied: ${errorMessage}`, error);
  }

  if (error.name === 'NoSuchBucket') {
    return new S3ServiceError('BUCKET_NOT_FOUND', `Bucket not found: ${errorMessage}`, error);
  }

  if (error.name === 'NetworkError') {
    return new S3ServiceError('NETWORK_ERROR', `Network error: ${errorMessage}`, error);
  }

  return new S3ServiceError('UNKNOWN_ERROR', errorMessage, error);
};

// Validate inputs
const validateInputs = (bucketName: string, key: string): void => {
  if (!bucketName) {
    throw new S3ServiceError('INVALID_INPUT', 'S3 bucket name is not configured');
  }

  if (!key) {
    throw new S3ServiceError('INVALID_INPUT', 'File key is required');
  }
};

/**
 * Lists all files in a folder (prefix) in S3
 * @param bucketName
 * @param folderPath The folder prefix (e.g., 'text/filename/')
 * @param maxKeys Maximum number of keys to return (default: 1000)
 * @returns Promise with array of file keys
 */
export const listFilesInFolder = async (
  bucketName: string,
  folderPath: string,
  maxKeys: number = 1000,
): Promise<string[]> => {
  try {
    if (!bucketName) {
      throw new S3ServiceError('INVALID_INPUT', 'S3 bucket name is not configured');
    }

    if (!folderPath) {
      throw new S3ServiceError('INVALID_INPUT', 'Folder path is required');
    }

    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: folderPath,
      MaxKeys: maxKeys,
    });

    const response = await s3Client.send(command);

    if (!response.Contents) {
      return [];
    }

    // Filter out the folder itself (if it exists as an object) and return only file keys
    return response.Contents
      .filter(obj => obj.Key && obj.Key !== folderPath && !obj.Key.endsWith('/'))
      .map(obj => obj.Key!)
      .sort(); // Sort for consistent ordering

  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Lists all files in a folder with pagination support
 * @param bucketName
 * @param folderPath The folder prefix (e.g., 'text/filename/')
 * @param continuationToken Token for pagination (optional)
 * @param maxKeys Maximum number of keys to return per page (default: 1000)
 * @returns Promise with array of file keys and pagination info
 */
export const listFilesInFolderPaginated = async (
  bucketName: string,
  folderPath: string,
  continuationToken?: string,
  maxKeys: number = 1000,
): Promise<{ keys: string[]; nextContinuationToken?: string; isTruncated: boolean }> => {
  try {
    if (!bucketName) {
      throw new S3ServiceError('INVALID_INPUT', 'S3 bucket name is not configured');
    }

    if (!folderPath) {
      throw new S3ServiceError('INVALID_INPUT', 'Folder path is required');
    }

    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: folderPath,
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    const keys = response.Contents
      ? response.Contents
        .filter(obj => obj.Key && obj.Key !== folderPath && !obj.Key.endsWith('/'))
        .map(obj => obj.Key!)
        .sort()
      : [];

    return {
      keys,
      nextContinuationToken: response.NextContinuationToken,
      isTruncated: response.IsTruncated || false,
    };

  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Gets a file from S3 as a string
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @returns Promise with file content as string
 */
export const getFile = async (bucketName: string, key: string): Promise<GetObjectCommandOutput> => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error('Image data not found in the input bucket');
  }

  return response;
};

/**
 * Gets a file from S3 as a buffer
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @returns Promise with file buffer
 */
export const getFileAsBuffer = async (bucketName: string, key: string): Promise<Buffer> => {
  try {
    validateInputs(bucketName, key);

    const response = await getFile(bucketName, key);

    // Convert stream to buffer
    const responseStream = response.Body as Readable;
    const chunks: Buffer[] = [];

    return await new Promise<Buffer>((resolve, reject) => {
      responseStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      responseStream.on('error', (err) => reject(formatS3Error(err)));
      responseStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Gets a file from S3 as a string
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @returns Promise with file content as string
 */
export const getFileAsString = async (bucketName: string, key: string): Promise<string> => {
  const buffer = await getFileAsBuffer(bucketName, key);
  return buffer.toString('utf-8');
};

/**
 * Gets a file from S3 as JSON
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @returns Promise with parsed JSON
 */
export const getFileAsJson = async <T>(bucketName: string, key: string): Promise<T> => {
  const content = await getFileAsString(bucketName, key);
  try {
    return JSON.parse(content) as T;
  } catch (error: any) {
    throw new S3ServiceError('INVALID_INPUT', `Invalid JSON file content: ${error.message}`, error);
  }
};

/**
 * Gets all files from a bucket (or folder prefix) and parses them as JSON
 * @param bucketName The S3 bucket name
 * @param prefix Optional folder prefix to filter files (e.g., 'data/')
 * @param maxKeys Maximum number of files to retrieve (default: 1000)
 * @returns Promise with array of parsed JSON objects
 */
export const getAllFilesFromBucketAsJSON = async (
  bucketName: string,
  prefix: string = '',
  maxKeys: number = 1000,
): Promise<Record<string, any>> => {
  try {
    if (!bucketName) {
      throw new S3ServiceError('INVALID_INPUT', 'S3 bucket name is not configured');
    }

    // List all files in the bucket/folder
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      MaxKeys: maxKeys,
    });

    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      return {};
    }

    // Filter out folders and get only file keys
    const fileKeys = response.Contents
      .filter(obj => obj.Key && !obj.Key.endsWith('/'))
      .map(obj => obj.Key!);

    // Fetch and parse all files as JSON
    const jsonPromises = fileKeys.map(async (key) => {
      try {
        const content = await getFileAsJson(bucketName, key);
        return { key, content };
      } catch (error: any) {
        console.warn(`Failed to parse JSON for file ${key}:`, error.message);
        return null;
      }
    });

    const results = await Promise.all(jsonPromises);

    // Build object with keys mapping to parsed content
    const resultObject: Record<string, any> = {};
    results.forEach((result) => {
      if (result !== null) {
        resultObject[result.key] = result.content;
      }
    });

    return resultObject;
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Gets a file from S3 as a Base64 encoded string
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @returns Promise with file content as Base64 string
 */
export const getFileAsBase64 = async (bucketName: string, key: string): Promise<string> => {
  try {
    const buffer = await getFileAsBuffer(bucketName, key);
    return buffer.toString('base64');
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Generates a pre-signed URL to download a file from S3
 * @param bucketName
 * @param key The file key (path) in the bucket
 * @param expiresIn Expiration time in seconds (default: 3600)
 * @returns Promise with the pre-signed URL
 */
export const getFileAsPresignedUrl = async (
  bucketName: string,
  key: string,
  expiresIn: number = 3600,
): Promise<string> => {
  try {
    validateInputs(bucketName, key);

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Uploads a file to S3
 * @param key The file key (path) in the bucket
 * @param content The file content (Buffer, string, or object for JSON)
 * @param contentType Optional MIME type
 * @returns Promise with upload result
 */
export const uploadFile = async (
  bucketName: string,
  key: string,
  content: Buffer | string | object,
  contentType?: string,
): Promise<{ key: string; url: string }> => {
  try {
    validateInputs(bucketName, key);

    // Convert content to proper format
    let bodyContent: Buffer;
    let finalContentType = contentType;

    if (Buffer.isBuffer(content)) {
      bodyContent = content;
    } else if (typeof content === 'string') {
      bodyContent = Buffer.from(content);
      finalContentType = finalContentType || 'text/plain';
    } else {
      // Assuming it's an object to be JSON serialized
      bodyContent = Buffer.from(JSON.stringify(content));
      finalContentType = finalContentType || 'application/json';
    }

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: bodyContent,
      ContentType: finalContentType,
    });

    await s3Client.send(command);

    // Generate a temporary URL for the uploaded file
    const getCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

    return { key, url };
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Deletes a file from S3
 * @param key The file key (path) in the bucket
 * @returns Promise indicating success
 */
export const deleteFile = async (bucketName: string, key: string): Promise<void> => {
  try {
    validateInputs(bucketName, key);

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await s3Client.send(command);
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Moves a file from one bucket to another
 * @param sourceBucketName The source bucket name
 * @param sourceKey The source file key (path)
 * @param destinationBucketName The destination bucket name
 * @param destinationKey The destination file key (path) - optional, defaults to source key
 * @param preserveMetadata Whether to preserve original metadata (default: true)
 * @returns Promise with move result
 */
export const moveFileToBucket = async (
  sourceBucketName: string,
  sourceKey: string,
  destinationBucketName: string,
  destinationKey?: string,
  preserveMetadata: boolean = true,
): Promise<{ sourceKey: string; destinationKey: string; destinationUrl: string }> => {
  try {
    validateInputs(sourceBucketName, sourceKey);

    if (!destinationBucketName) {
      throw new S3ServiceError('INVALID_INPUT', 'Destination bucket name is required');
    }

    const finalDestinationKey = destinationKey || sourceKey;

    // First, get the source object metadata if we need to preserve it
    let metadata: Record<string, string> | undefined;
    let contentType: string | undefined;

    if (preserveMetadata) {
      try {
        const getCommand = new GetObjectCommand({
          Bucket: sourceBucketName,
          Key: sourceKey,
        });
        const sourceObject = await s3Client.send(getCommand);
        metadata = sourceObject.Metadata;
        contentType = sourceObject.ContentType;
      } catch (error) {
        // If we can't get metadata, continue without it
        console.warn('Could not retrieve source object metadata:', error);
      }
    }

    // Copy the file to the destination bucket
    const copyCommand = new CopyObjectCommand({
      Bucket: destinationBucketName,
      Key: finalDestinationKey,
      CopySource: `${sourceBucketName}/${sourceKey}`,
      Metadata: metadata,
      ContentType: contentType,
      MetadataDirective: preserveMetadata ? 'REPLACE' : 'COPY',
    });

    await s3Client.send(copyCommand);

    // Delete the source file
    const deleteCommand = new DeleteObjectCommand({
      Bucket: sourceBucketName,
      Key: sourceKey,
    });

    await s3Client.send(deleteCommand);

    // Generate a temporary URL for the moved file
    const getCommand = new GetObjectCommand({
      Bucket: destinationBucketName,
      Key: finalDestinationKey,
    });
    const destinationUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

    return {
      sourceKey,
      destinationKey: finalDestinationKey,
      destinationUrl,
    };
  } catch (error) {
    throw formatS3Error(error);
  }
};

/**
 * Moves a file to another folder within the same bucket
 * @param bucketName The bucket name
 * @param sourceKey The source file key (path)
 * @param destinationFolder The destination folder path (e.g., 'new-folder/')
 * @param newFileName Optional new file name (defaults to original filename)
 * @param preserveMetadata Whether to preserve original metadata (default: true)
 * @returns Promise with move result
 */
export const moveFileToFolder = async (
  bucketName: string,
  sourceKey: string,
  destinationFolder: string,
  newFileName?: string,
  preserveMetadata: boolean = true,
): Promise<{ sourceKey: string; destinationKey: string; destinationUrl: string }> => {
  try {
    validateInputs(bucketName, sourceKey);

    if (!destinationFolder) {
      throw new S3ServiceError('INVALID_INPUT', 'Destination folder is required');
    }

    // Ensure destination folder ends with '/'
    const normalizedDestinationFolder = destinationFolder.endsWith('/')
      ? destinationFolder
      : `${destinationFolder}/`;

    // Extract original filename from source key
    const originalFileName = sourceKey.split('/').pop() || '';
    const finalFileName = newFileName || originalFileName;

    if (!finalFileName) {
      throw new S3ServiceError('INVALID_INPUT', 'Could not determine filename from source key');
    }

    const destinationKey = `${normalizedDestinationFolder}${finalFileName}`;

    // Check if source and destination are the same
    if (sourceKey === destinationKey) {
      throw new S3ServiceError('INVALID_INPUT', 'Source and destination keys are identical');
    }

    // First, get the source object metadata if we need to preserve it
    let metadata: Record<string, string> | undefined;
    let contentType: string | undefined;

    if (preserveMetadata) {
      try {
        const getCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: sourceKey,
        });
        const sourceObject = await s3Client.send(getCommand);
        metadata = sourceObject.Metadata;
        contentType = sourceObject.ContentType;
      } catch (error) {
        // If we can't get metadata, continue without it
        console.warn('Could not retrieve source object metadata:', error);
      }
    }

    // Copy the file to the new location
    const copyCommand = new CopyObjectCommand({
      Bucket: bucketName,
      Key: destinationKey,
      CopySource: `${bucketName}/${sourceKey}`,
      Metadata: metadata,
      ContentType: contentType,
      MetadataDirective: preserveMetadata ? 'REPLACE' : 'COPY',
    });

    await s3Client.send(copyCommand);

    // Delete the source file
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: sourceKey,
    });

    await s3Client.send(deleteCommand);

    // Generate a temporary URL for the moved file
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: destinationKey,
    });
    const destinationUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });

    return {
      sourceKey,
      destinationKey,
      destinationUrl,
    };
  } catch (error) {
    throw formatS3Error(error);
  }
};

import axios, { AxiosError } from 'axios';
import FormData from 'form-data';

const getBaseUrl = (): string => {
  const raw = process.env.ALB_URL;
  if (!raw) {
    throw new Error('ALB_URL environment variable is not set');
  }
  return raw.startsWith('http://') || raw.startsWith('https://')
    ? raw.replace(/\/+$/, '')
    : `http://${raw.replace(/\/+$/, '')}`;
};

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

// ---- Shared types (aligned with start_server.py) ----

export interface OcrResponse {
  success: boolean;
  result?: string;
  error?: string;
  page_count?: number;
}

export interface BatchOcrResponse {
  success: boolean;
  results: OcrResponse[];
  total_pages: number;
  filename: string;
}

export interface MixedBatchItem {
  filename: string;
  result: OcrResponse | BatchOcrResponse;
}

export interface MixedBatchResponse {
  success: boolean;
  results: MixedBatchItem[];
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_path: string;
  cuda_available: boolean;
  cuda_device_count: number;
}

// ---- Internal helpers ----

const handleAxiosError = (error: unknown): never => {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<any>;
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('DeepSeek OCR request failed', {
      status,
      data,
      message: err.message,
    });
    throw new Error(
      `DeepSeek OCR request failed${status ? ` (status ${status})` : ''}: ${
        typeof data === 'string' ? data : err.message
      }`,
    );
  }

  console.error('DeepSeek OCR unknown error:', error);
  throw error instanceof Error ? error : new Error('Unknown DeepSeek OCR error');
};

const createFormDataWithFile = (
  fieldName: string,
  buffer: Buffer,
  filename: string,
  contentType: string,
  prompt?: string,
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
): FormData => {
  const formData = new FormData();

  formData.append(fieldName, buffer, {
    filename,
    contentType,
  });

  if (prompt) {
    formData.append('prompt', prompt);
  }

  // Add sampling parameters if provided
  if (temperature !== undefined) {
    formData.append('temperature', temperature.toString());
  }

  if (top_p !== undefined) {
    formData.append('top_p', top_p.toString());
  }

  if (max_tokens !== undefined) {
    formData.append('max_tokens', max_tokens.toString());
  }

  return formData;
};

// ---- Public API helpers ----

/**
 * Health check against /health endpoint.
 */
export async function getDeepSeekHealth(): Promise<HealthResponse> {
  const baseUrl = getBaseUrl();

  try {
    const response = await axios.get<HealthResponse>(`${baseUrl}/health`, {
      timeout: 10_000,
    });

    return response.data;
  } catch (error) {
    return handleAxiosError(error);
  }
}

/**
 * Simple ping to root ("/") endpoint.
 */
export async function pingDeepSeek(): Promise<any> {
  const baseUrl = getBaseUrl();

  try {
    const response = await axios.get(`${baseUrl}/`, {
      timeout: 5_000,
    });
    return response.data;
  } catch (error) {
    return handleAxiosError(error);
  }
}

/**
 * Call DeepSeek OCR for single image.
 * Maps to POST /ocr/image
 * @param imageBuffer Buffer containing the image data
 * @param prompt OCR prompt (default: '<image>')
 * @param grounded Whether to use grounded OCR mode with positional information
 * @param temperature Sampling temperature (0.0 to 2.0), controls randomness
 * @param top_p Nucleus sampling parameter (0.0 to 1.0)
 * @param max_tokens Maximum number of tokens to generate (1 to 8192)
 */
export async function processImage(
  imageBuffer: Buffer,
  prompt: string = '<image>',
  grounded: boolean = false,
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
): Promise<OcrResponse> {
  const baseUrl = getBaseUrl();

  // Build the prompt with appropriate tags
  let normalizedPrompt = prompt.includes('<image>') ? prompt : `<image>${prompt}`;

  // Add grounding tag if requested
  if (grounded) {
    normalizedPrompt = `<|grounding|>${normalizedPrompt}`;
    console.log('[helpers.ts] Grounded OCR mode enabled');
  }

  console.log(`[helpers.ts] Processing image with prompt: ${normalizedPrompt}`);
  console.log(`[helpers.ts] Image buffer size: ${imageBuffer.length} bytes`);
  console.log(`[helpers.ts] Grounded mode: ${grounded}`);

  if (temperature !== undefined || top_p !== undefined || max_tokens !== undefined) {
    console.log(`[helpers.ts] Sampling params - temperature: ${temperature}, top_p: ${top_p}, max_tokens: ${max_tokens}`);
  }

  const formData = createFormDataWithFile(
    'file',
    imageBuffer,
    'image.jpg',
    'image/jpeg',
    normalizedPrompt,
    temperature,
    top_p,
    max_tokens,
  );

  try {
    const response = await axios.post<OcrResponse>(
      `${baseUrl}/ocr/image`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: DEFAULT_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );

    console.log(`[helpers.ts] Image OCR response received: ${JSON.stringify(response.data).substring(0, 200)}...`);
    return response.data;
  } catch (error) {
    return handleAxiosError(error);
  }
}

/**
 * Call DeepSeek OCR for single PDF.
 * Maps to POST /ocr/pdf
 * @param pdfBuffer Buffer containing the PDF data
 * @param prompt OCR prompt (default: '<image>')
 * @param grounded Whether to use grounded OCR mode with positional information
 * @param temperature Sampling temperature (0.0 to 2.0), controls randomness
 * @param top_p Nucleus sampling parameter (0.0 to 1.0)
 * @param max_tokens Maximum number of tokens to generate (1 to 8192)
 */
export async function processPdf(
  pdfBuffer: Buffer,
  prompt: string = '<image>',
  grounded: boolean = false,
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
): Promise<BatchOcrResponse> {
  const baseUrl = getBaseUrl();

  // Build the prompt with appropriate tags
  let normalizedPrompt = prompt.includes('<image>') ? prompt : `<image>${prompt}`;

  // Add grounding tag if requested
  if (grounded) {
    normalizedPrompt = `<|grounding|>${normalizedPrompt}`;
    console.log('[helpers.ts] Grounded OCR mode enabled');
  }

  console.log(`[helpers.ts] Processing PDF with prompt: ${normalizedPrompt}`);
  console.log(`[helpers.ts] PDF buffer size: ${pdfBuffer.length} bytes`);
  console.log(`[helpers.ts] Grounded mode: ${grounded}`);

  if (temperature !== undefined || top_p !== undefined || max_tokens !== undefined) {
    console.log(`[helpers.ts] Sampling params - temperature: ${temperature}, top_p: ${top_p}, max_tokens: ${max_tokens}`);
  }

  const formData = createFormDataWithFile(
    'file',
    pdfBuffer,
    'document.pdf',
    'application/pdf',
    normalizedPrompt,
    temperature,
    top_p,
    max_tokens,
  );

  try {
    const response = await axios.post<BatchOcrResponse>(
      `${baseUrl}/ocr/pdf`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: DEFAULT_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );

    console.log(`[helpers.ts] PDF OCR response received, pages: ${response.data.total_pages}`);
    return response.data;
  } catch (error) {
    return handleAxiosError(error);
  }
}

/**
 * Call DeepSeek OCR for a mixed batch of files (images and/or PDFs).
 * Maps to POST /ocr/batch
 *
 * Usage:
 *  await processBatch([
 *    { buffer, filename: 'a.jpg', contentType: 'image/jpeg' },
 *    { buffer, filename: 'b.pdf', contentType: 'application/pdf' },
 *  ], prompt, grounded, temperature, top_p, max_tokens);
 *
 * @param files Array of files with buffer, filename, and contentType
 * @param prompt OCR prompt (default: '<image>')
 * @param grounded Whether to use grounded OCR mode with positional information
 * @param temperature Sampling temperature (0.0 to 2.0), controls randomness
 * @param top_p Nucleus sampling parameter (0.0 to 1.0)
 * @param max_tokens Maximum number of tokens to generate (1 to 8192)
 */
export async function processBatch(
  files: { buffer: Buffer; filename: string; contentType: string }[],
  prompt: string = '<image>',
  grounded: boolean = false,
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
): Promise<MixedBatchResponse> {
  if (!files.length) {
    throw new Error('No files provided for batch processing');
  }

  const baseUrl = getBaseUrl();
  const formData = new FormData();

  // Build the prompt with appropriate tags
  let normalizedPrompt = prompt.includes('<image>') ? prompt : `<image>${prompt}`;

  // Add grounding tag if requested
  if (grounded) {
    normalizedPrompt = `<|grounding|>${normalizedPrompt}`;
    console.log('[helpers.ts] Grounded OCR mode enabled for batch');
  }

  console.log(`[helpers.ts] Processing batch of ${files.length} files with prompt: ${normalizedPrompt}`);
  console.log(`[helpers.ts] Grounded mode: ${grounded}`);

  if (temperature !== undefined || top_p !== undefined || max_tokens !== undefined) {
    console.log(`[helpers.ts] Sampling params - temperature: ${temperature}, top_p: ${top_p}, max_tokens: ${max_tokens}`);
  }

  for (const f of files) {
    console.log(`[helpers.ts] Adding file: ${f.filename}, size: ${f.buffer.length} bytes, type: ${f.contentType}`);
    formData.append('files', f.buffer, {
      filename: f.filename,
      contentType: f.contentType,
    });
  }

  formData.append('prompt', normalizedPrompt);

  // Add sampling parameters if provided
  if (temperature !== undefined) {
    formData.append('temperature', temperature.toString());
  }

  if (top_p !== undefined) {
    formData.append('top_p', top_p.toString());
  }

  if (max_tokens !== undefined) {
    formData.append('max_tokens', max_tokens.toString());
  }

  try {
    const response = await axios.post<MixedBatchResponse>(
      `${baseUrl}/ocr/batch`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: DEFAULT_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );

    console.log(`[helpers.ts] Batch OCR response received, files processed: ${response.data.results.length}`);
    return response.data;
  } catch (error) {
    return handleAxiosError(error);
  }
}

import { APIGatewayProxyResult } from 'aws-lambda';

export class ClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ClientError';
    this.statusCode = statusCode;
  }
}

export class ServerError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ServerError';
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const errorHandler = (error: Error): APIGatewayProxyResult => {
  const headers = { 'Access-Control-Allow-Origin': '*' };

  if (error instanceof NotFoundError) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        error: 'NotFound',
        message: error.message,
      }),
    };
  }

  if (error instanceof ValidationError) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({
        error: 'ValidationError',
        message: error.message,
      }),
    };
  }

  if (error instanceof ClientError) {
    return {
      statusCode: error.statusCode,
      headers,
      body: JSON.stringify({
        error: error.name,
        message: error.message,
      }),
    };
  }

  if (error instanceof ServerError) {
    return {
      statusCode: error.statusCode,
      headers,
      body: JSON.stringify({
        error: error.name,
        message: 'An unexpected error occurred. Please try again later.',
      }),
    };
  }

  // Generic catch-all error handler
  return {
    statusCode: 500,
    headers,
    body: JSON.stringify({
      error: 'InternalServerError',
      message: 'An unexpected error occurred. Please try again later.',
    }),
  };
};

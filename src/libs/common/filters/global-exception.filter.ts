import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

// Stable, status-derived error codes — kept separate from human-readable
// messages so clients can branch on `errorCode` without parsing prose.
const STATUS_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const errorCodeForStatus = (status: number): string =>
  STATUS_ERROR_CODES[status] ?? `HTTP_${status}`;

interface NormalizedError {
  status: number;
  errorCode: string;
  message: string | string[];
}

/**
 * Catches every exception and returns one consistent JSON shape
 * (`statusCode`, `errorCode`, `message`, `timestamp`, `path`, `requestId`).
 * Internal details and stack traces are logged server-side but never leaked to
 * the client; 5xx responses always carry a generic message.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // This filter only shapes REST responses; gateways (ws) manage their own
    // errors, so anything non-HTTP is just logged and left alone.
    if (host.getType() !== 'http') {
      this.logger.error(
        'Non-HTTP exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, errorCode, message } = this.normalize(exception);

    const requestId =
      (request as Request & { id?: string | number }).id ??
      (request.headers['x-request-id'] as string | undefined);

    const logLine = `${request.method} ${request.originalUrl} → ${status} ${errorCode}${
      requestId !== undefined ? ` [req:${requestId}]` : ''
    }`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        logLine,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(logLine);
    }

    response.status(status).json({
      statusCode: status,
      errorCode,
      message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
      requestId: requestId !== undefined ? String(requestId) : undefined,
    });
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ??
            exception.message);
      return { status, errorCode: errorCodeForStatus(status), message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            errorCode: 'CONFLICT',
            message: 'A record with these details already exists',
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            errorCode: 'NOT_FOUND',
            message: 'The requested record was not found',
          };
        default:
          return {
            status: HttpStatus.BAD_REQUEST,
            errorCode: 'BAD_REQUEST',
            message: 'Database request error',
          };
      }
    }

    // Unknown / unexpected — never expose the real error to the client.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    };
  }
}

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { MulterError } from 'multer';
import { GeminiApiException } from '../../domain/exceptions/gemini-api.exception';
import { GeminiBadRequestException } from '../../domain/exceptions/gemini-bad-request.exception';
import { GeminiTimeoutException } from '../../domain/exceptions/gemini-timeout.exception';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';
import { ImageProcessingException } from '../../domain/exceptions/image-processing.exception';
import { UnsupportedMimeTypeException } from '../../domain/exceptions/unsupported-mime-type.exception';
import { TrackedRequest } from '../middleware/request-id.middleware';

interface MappedError {
  status: number;
  code: string;
  message: string;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<TrackedRequest>();
    const response = http.getResponse<Response>();
    const mapped = this.mapException(exception);
    this.logException(exception, mapped, request?.id);
    response.status(mapped.status).json({
      statusCode: mapped.status,
      code: mapped.code,
      message: mapped.message,
      timestamp: new Date().toISOString(),
    });
  }

  // Nunca más un 500 trágado en silencio: errores >= 500 se logean con el
  // stack; 4xx/504 como warn.
  private logException(exception: unknown, mapped: MappedError, requestId?: string): void {
    const requestLabel = requestId ? ` [req=${requestId}]` : '';
    if (mapped.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${mapped.code}${requestLabel}: ${this.messageOf(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${mapped.code}${requestLabel}: ${this.messageOf(exception)}`);
    }
  }

  private mapException(exception: unknown): MappedError {
    if (exception instanceof ImageNotFoundException) {
      return { status: HttpStatus.NOT_FOUND, code: exception.code, message: exception.message };
    }
    if (exception instanceof UnsupportedMimeTypeException) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message };
    }
    // 4xx de Gemini (entrada inválida) → 400; timeout → 504; resto → 502.
    if (exception instanceof GeminiBadRequestException) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message };
    }
    if (exception instanceof GeminiTimeoutException) {
      return {
        status: HttpStatus.GATEWAY_TIMEOUT,
        code: exception.code,
        message: exception.message,
      };
    }
    if (exception instanceof GeminiApiException) {
      return { status: HttpStatus.BAD_GATEWAY, code: exception.code, message: exception.message };
    }
    if (exception instanceof ImageProcessingException) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: exception.code,
        message: exception.message,
      };
    }
    // Multer: LIMIT_FILE_SIZE → 413; cualquier otro (campo, etc.) → 400, no 500.
    if (exception instanceof MulterError) {
      if (exception.code === 'LIMIT_FILE_SIZE') {
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          code: 'FILE_TOO_LARGE',
          message: 'Uploaded file exceeds the size limit',
        };
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'UPLOAD_ERROR',
        message: exception.message || 'Malformed upload',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = this.extractMessage(body, exception.message);
      return { status, code: HttpStatus[status] ?? 'HTTP_ERROR', message };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }

  private messageOf(exception: unknown): string {
    return exception instanceof Error ? exception.message : String(exception);
  }

  private extractMessage(body: unknown, fallback: string): string {
    if (typeof body === 'string') {
      return body;
    }
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      return Array.isArray(message) ? message.join('; ') : String(message);
    }
    return fallback;
  }
}

import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { MulterError } from 'multer';
import { DomainExceptionFilter } from './domain-exception.filter';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';
import { UnsupportedMimeTypeException } from '../../domain/exceptions/unsupported-mime-type.exception';
import { GeminiApiException } from '../../domain/exceptions/gemini-api.exception';
import { GeminiBadRequestException } from '../../domain/exceptions/gemini-bad-request.exception';
import { GeminiTimeoutException } from '../../domain/exceptions/gemini-timeout.exception';

const fakeHost = (): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-test' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
};

describe('DomainExceptionFilter', () => {
  const filter = new DomainExceptionFilter();

  it('mapea ImageNotFoundException a 404', () => {
    const { host, json } = fakeHost();
    filter.catch(new ImageNotFoundException('abc'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'IMAGE_NOT_FOUND' }),
    );
  });

  it('mapea UnsupportedMimeTypeException a 400', () => {
    const { host, json } = fakeHost();
    filter.catch(new UnsupportedMimeTypeException('text/plain'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'UNSUPPORTED_MIME_TYPE' }),
    );
  });

  it('mapea GeminiApiException a 502', () => {
    const { host, json } = fakeHost();
    filter.catch(new GeminiApiException('boom'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 502, code: 'GEMINI_API_ERROR' }),
    );
  });

  it('mapea GeminiBadRequestException a 400 (error del cliente, no del servidor)', () => {
    const { host, json } = fakeHost();
    filter.catch(new GeminiBadRequestException('invalid image'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'GEMINI_BAD_REQUEST' }),
    );
  });

  it('mapea GeminiTimeoutException a 504', () => {
    const { host, json } = fakeHost();
    filter.catch(new GeminiTimeoutException(30_000), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 504, code: 'GEMINI_TIMEOUT' }),
    );
  });

  it('mapea MulterError LIMIT_FILE_SIZE a 413', () => {
    const { host, json } = fakeHost();
    filter.catch(new MulterError('LIMIT_FILE_SIZE'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 413, code: 'FILE_TOO_LARGE' }),
    );
  });

  it('mapea otros MulterError (p.ej. campo inesperado) a 400, no a 500', () => {
    const { host, json } = fakeHost();
    filter.catch(new MulterError('LIMIT_UNEXPECTED_FILE', 'file'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'UPLOAD_ERROR' }),
    );
  });

  it('logea los errores 500 con nivel error y sin tragarse el mensaje', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { host } = fakeHost();
    filter.catch(new Error('secret internals'), host);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('secret internals'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('logea los 4xx como warn', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { host } = fakeHost();
    filter.catch(new ImageNotFoundException('abc'), host);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('IMAGE_NOT_FOUND'));
    warnSpy.mockRestore();
  });

  it('mapea HttpException genérica preservando su status', () => {
    const { host, json } = fakeHost();
    filter.catch(new BadRequestException('Image file is required'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'BAD_REQUEST' }),
    );
  });

  it('mapea errores desconocidos a 500 sin exponer detalles', () => {
    const { host, json } = fakeHost();
    filter.catch(new Error('secret internals'), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, code: 'INTERNAL_ERROR' }),
    );
  });

  it('incluye un timestamp ISO en la respuesta', () => {
    const { host, json } = fakeHost();
    filter.catch(new BadRequestException('x'), host);
    const payload = json.mock.calls[0][0];
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

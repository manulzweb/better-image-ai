import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';

const fakeConfig = {
  get: () => ['valid-key-1', 'valid-key-2'],
} as unknown as ConfigService;

const contextOf = (header?: string | string[]): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-api-key': header } }),
    }),
  }) as unknown as ExecutionContext;

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;

  beforeEach(() => {
    guard = new ApiKeyGuard(fakeConfig as any);
  });

  it('acepta una clave válida', () => {
    expect(guard.canActivate(contextOf('valid-key-1'))).toBe(true);
  });

  it('acepta cualquier clave de la lista rotatoria', () => {
    expect(guard.canActivate(contextOf('valid-key-2'))).toBe(true);
  });

  it('rechaza sin cabecera (401)', () => {
    expect(() => guard.canActivate(contextOf(undefined))).toThrow(UnauthorizedException);
  });

  it('rechaza clave inválida (401)', () => {
    expect(() => guard.canActivate(contextOf('wrong-key'))).toThrow(UnauthorizedException);
  });

  it('soporta cabecera como array (primer valor)', () => {
    expect(guard.canActivate(contextOf(['valid-key-1', 'valid-key-2']))).toBe(true);
  });
});

import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AdmissionGuard } from './admission.guard';
import { AdmissionInterceptor } from '../../presentation/middleware/admission.interceptor';

it('rejects overload before buffering and releases reservations on handler errors', async () => {
  const guard = new AdmissionGuard({ get: () => 1 } as unknown as ConfigService<any, true>);
  const request = {};
  const response = { setHeader: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  expect(guard.canActivate(context)).toBe(true);
  expect(() => guard.canActivate(context)).toThrow(ServiceUnavailableException);
  expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  const interceptor = new AdmissionInterceptor();
  await expect(
    lastValueFrom(
      interceptor.intercept(context, {
        handle: () => throwError(() => new Error('upload failed')),
      }),
    ),
  ).rejects.toThrow('upload failed');
  expect(guard.canActivate(context)).toBe(true);
  await lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }));
});

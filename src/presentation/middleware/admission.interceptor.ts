import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs/operators';

@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ releaseAdmission?: () => void }>();
    return next.handle().pipe(
      finalize(() => {
        request.releaseAdmission?.();
        request.releaseAdmission = undefined;
      }),
    );
  }
}

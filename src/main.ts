import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { EnvConfig } from './config/config.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.enableShutdownHooks();

  const config = app.get(ConfigService<EnvConfig, true>);
  const port = config.get('PORT', { infer: true });
  const trustProxy = config.get('TRUST_PROXY', { infer: true });

  // Fix del rate limit por IP detrás de proxy (Nginx/LB): sin esto `req.ip` es
  // la IP del proxy y todos los clientes comparten una única cuota.
  if (trustProxy !== false) {
    const server = app.getHttpAdapter().getInstance() as {
      set?(key: string, value: boolean | number): void;
    };
    server.set?.('trust proxy', trustProxy);
  }

  await app.listen(port);
  new Logger('Bootstrap').log(`better-image-ai listening on port ${port}`);
}

void bootstrap();

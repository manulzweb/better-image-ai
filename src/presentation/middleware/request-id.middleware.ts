import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export type TrackedRequest = Request & { id?: string };

// Asigna (o respeta) un X-Request-Id por petición y lo devuelve en la respuesta;
// el exception filter lo incluye en los logs.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private static readonly MAX_ID_LENGTH = 64;

  use(req: TrackedRequest, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(incoming)
        ? incoming.slice(0, RequestIdMiddleware.MAX_ID_LENGTH)
        : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);
    next();
  }
}

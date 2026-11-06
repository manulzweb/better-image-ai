# AGENTS.md

Contexto para agentes que trabajen en este repo.

## Qué es

API (NestJS + TypeScript) que centra productos en imágenes con fondo consistente usando **Gemini 3.1 Flash Lite Image** (`gemini-3.1-flash-lite-image`, Nano Banana). Deduplica por **sha256**: si la imagen ya fue procesada, devuelve el resultado cacheado sin llamar a Gemini.

## Stack y decisiones clave

- **Node >= 22.13**: se usa `node:sqlite` (DatabaseSync) embebido en vez de `better-sqlite3` → cero dependencias nativas. Por eso los scripts de arranque usan `--disable-warning=ExperimentalWarning`.
- **Validación con Zod** (`src/config/config.schema.ts`): toda la config/env pasa por un único schema. **No hay `class-validator` ni `ValidationPipe` global** (ValidationPipe requiere class-validator; no instalarlo).
- **Sin CSRF**: consumo servidor-a-servidor con `X-API-Key`. Documentado en README; si algún día hay clientes browser con cookies, añadir `csrf-csrf`.
- **Una sola estrategia de optimización**: Gemini. El wiring por token (`IMAGE_OPTIMIZER`) permite añadir otra strategy (p.ej. Sharp) sin tocar el caso de uso.

## Arquitectura (hexagonal)

```
src/
├── domain/            # entidades + excepciones + image-signatures (sniffing magic bytes, sin deps)
├── application/
│   ├── ports/         # interfaces + tokens de DI (IMAGE_OPTIMIZER, IMAGE_REPOSITORY, STORAGE, HASH_SERVICE)
│   ├── services/      # KeyedLock (mutex por hash, en proceso)
│   └── use-cases/     # OptimizeImageUseCase, GetProcessedImageUseCase (solo orquestan)
├── infrastructure/    # adapters: Gemini (@google/genai), SQLite (node:sqlite), FS, crypto, ApiKeyGuard, StorageGarbageCollector
├── presentation/      # controllers, pipes, filter, DTOs, RequestIdMiddleware
├── config/            # config.schema.ts (zod) — única fuente de verdad de env
├── images.module.ts   # feature module: wiring de tokens → adapters + HealthController + GC
└── app.module.ts      # ConfigModule global, ThrottlerModule, APP_GUARD/APP_FILTER, RequestIdMiddleware
```

Reglas:

- El dominio no importa nada de Nest ni de infraestructura.
- Los casos de uso solo conocen **ports** (inyectados por token `Symbol`).
- Cambiar de proveedor (S3, Postgres, otro modelo) = nuevo adapter + cambiar el `useClass` en `images.module.ts`. Nada más.
- **No meter try/catch de fallback ni lógica de proveedor en los use cases.**

## Flujo de dedup

1. `ApiKeyGuard` valida `X-API-Key` (timing-safe).
2. `CryptoHashService` computa sha256 del buffer.
3. `SqliteImageRepository.findByHash` → hit: responde `cached: true`.
4. Miss: `KeyedLock.runExclusive(hash)` (mutex por hash; evita doble llamada a Gemini por concurrencia) → **re-check** del repo dentro del lock → `GeminiImageOptimizerAdapter.optimize` (timeout `GEMINI_TIMEOUT_MS` + reintentos `GEMINI_MAX_RETRIES` con backoff; 4xx≠429 → `GEMINI_BAD_REQUEST`, no reintenta) → `LocalFileStorageAdapter.save` (atómico: tmp+rename) → `repository.save` → responde `cached: false`.

Otros detalles del pipeline:

- El upload se valida por **magic bytes** (`domain/image-signatures.ts`), no solo por el Content-Type declarado.
- La MIME de salida se detecta también por firma; si no se reconoce → `INVALID_OPTIMIZED_IMAGE` (500).
- SQLite arranca con `PRAGMA journal_mode=WAL` + `busy_timeout=5000`.
- `StorageGarbageCollector` corre al arranque y cada `GC_INTERVAL_MINUTES`: borra ficheros sin fila en DB y temporales `*.tmp-*` (reconciliación storage↔DB).
- `/health` lleva `@SkipThrottle()` y comprueba DB (`SELECT 1`) + storage escribible; fallo → 503.
- `RequestIdMiddleware` propaga/crea `X-Request-Id` en todas las rutas; el exception filter lo incluye en los logs.
- Todos los errores 5xx se logean (stack incluido) en `DomainExceptionFilter`; 4xx/504 como warn.
- `TRUST_PROXY` activa `app.set('trust proxy', …)` en main.ts — necesario detrás de Nginx para que el throttler use la IP real.

## Prompt de Gemini

Vive en `gemini-image-optimizer.adapter.ts` (`CENTER_PRODUCT_PROMPT`). Es restrictivo a propósito: solo re-posicionar el producto, sin tocar fondo/colores/forma. Cambiarlo con cuidado — es la garantía de "no cambiarle muchas cosas".

## Comandos

```bash
npm test            # unitarios (jest, co-localizados *.spec.ts)
npm run test:e2e    # e2e (test/e2e, Gemini mockeado vía jest.mock)
npm run build       # nest build → dist/
npm run lint        # eslint + prettier
npm run start:dev   # watch
```

## Convenciones

- **TDD**: nueva funcionalidad = test primero (o junto). Unitarios co-localizados (`*.spec.ts` junto al archivo); e2e en `test/e2e/`.
- Excepciones de dominio llevan `code` propio; `DomainExceptionFilter` las mapea a HTTP (`404/400/502/500`). Formato de error: `{ statusCode, code, message, timestamp }`.
- Tipado estricto (`strict: true`). Imports relativos cortos (sin path aliases).
- Nuevas env vars: añadirlas al schema zod **y** a `.env.example`.
- E2E: la env se fija **antes** de importar `AppModule` (import dinámico en `beforeAll`), porque `ConfigModule.forRoot` valida en tiempo de importación.

## Límites conocidos

- Upload máx. 7MB (límite inline de Gemini); MIME permitidos: jpeg/png/webp/heic/heif (validados por magic bytes).
- Rate limit por IP (no por API key) con storage en memoria — en multi-instancia usar un storage compartido (Redis) para el throttler. El mutex de dedup (`KeyedLock`) también es por proceso.
- `GET /v1/images/:hash` también requiere API key; hacerlo público = quitar el guard de esa ruta.
- Sin estrategia de migraciones de esquema: solo `CREATE TABLE IF NOT EXISTS`.
- Directorio de storage plano (sin sharding) — valorar `ab/cd/hash` si crece mucho.


## Jobs y créditos (implementación actual)

- Hay cola persistente SQLite para una sola instancia: crear `/v1/jobs` (hasta 100), subir partes en `/:id/items`, cerrar con `/:id/submit`, consultar/cancelar. No usar PM2 cluster ni réplicas sobre la misma DB.
- Todos los clientes empiezan sin saldo. `CREDITS` es un port obligatorio de OptimizeImageUseCase: reserva antes de Gemini y confirma metadata + captura en una transacción. Caché/errores liberan reservas; no añadir rutas que eviten el control de créditos.
- `SqliteCommerceRepository` implementa `JOBS` y `CREDITS`; `JobWorker` recupera trabajos y drena antes de cerrar conexiones. Los repos SQLite cierran en `onApplicationShutdown`.
- `PURCHASES` y `PAYMENT_GATEWAY` separan compras de Mercado Pago. Webhooks: firma + consulta autoritativa + validación de vendedor/modo/importe/moneda/referencia + acreditación idempotente. No confiar en el body ni en retornos del navegador.
- Recargas manuales requieren `X-Admin-Key` contra `ADMIN_API_KEY_HASH`, distinto de las API keys de clientes. Reembolsos/contracargos suspenden nuevas generaciones y requieren conciliación administrativa.
- Mercado Pago permanece desactivado sin configuración. No ejecutar cobros reales ni insertar créditos de producción durante pruebas.
- Contrato y operación: `docs/jobs-and-credits.md`. E2E de jobs/pagos usa proveedores simulados y directorios temporales.

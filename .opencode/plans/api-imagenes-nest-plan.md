# Plan: better-image-ai — API de optimización de imágenes de productos (NestJS)

## Decisiones acordadas

- **Stack:** NestJS (Node + TypeScript)
- **Procesamiento:** Strategy con `gemini-edit` (primario) + `opencv-fallback` (determinista)
- **Cache/dedup:** Filesystem + SQLite (better-sqlite3)
- **Auth:** API Key (`X-API-Key`), CSRF documentado como no aplicable

## Investigación Gemini (resumen)

- **Modelo recomendado:** `gemini-2.5-flash-image` (Nano Banana) — edición por prompt, alta velocidad.
- **Alternativa premium:** Nano Banana Pro `gemini-3-pro-image` (mayor calidad, más caro).
- SDK Node oficial: `@google/genai`. Salida con `responseModalities: ['IMAGE', 'TEXT']`.
- Prompt de centrado: instruction de edición; el modelo respeta fondo y producto (consistency).
- Costo aprox.: Nano Banana ~$0.039/imagen (1290 output tokens); Pro ~$0.134/imagen.

## Arquitectura Hexagonal (Ports & Adapters) + NestJS

```
src/
├── domain/
│   ├── entities/
│   │   ├── image-process-result.entity.ts
│   │   └── processed-image.entity.ts
│   └── exceptions/
│       ├── image-processing.exception.ts
│       └── unsupported-mime.exception.ts
├── application/
│   ├── ports/                                   # Interfaces (contratos)
│   │   ├── image-optimizer.port.ts              # optimize(buffer): Promise<Result>
│   │   ├── image-repository.port.ts             # findByHash / save
│   │   ├── hash-service.port.ts                 # compute(buffer): sha256
│   │   └── storage.port.ts                      # save/outputPath
│   └── use-cases/
│       └── optimize-image.use-case.ts           # Orquesta dedup + procesamiento
├── infrastructure/
│   ├── persistence/
│   │   └── sqlite-image.repository.ts           # Adapter (better-sqlite3)
│   ├── storage/
│   │   └── local-file-storage.adapter.ts        # Adapter filesystem
│   ├── hashing/
│   │   └── crypto-hash.service.ts
│   ├── providers/
│   │   ├── gemini-image-optimizer.adapter.ts    # Adapter: SDK @google/genai
│   │   └── sharp-image-optimizer.adapter.ts     # Adapter: centrado determinista (sharp)
│   └── auth/
│       ├── api-key.guard.ts
│       └── api-key.strategy.ts
├── config/
│   ├── configuration.ts                         # env parse + validación (joi)
│   └── constants.ts
└── presentation/
    ├── controllers/
    │   ├── image.controller.ts
    │   └── health.controller.ts
    ├── dto/
    │   └── optimize-response.dto.ts
    └── filters/
        └── http-exception.filter.ts
└── main.ts                                      # bootstrap: helmet, throttler, ValidationPipe
```

## Endpoints

| Método | Ruta                  | Descripción                                    |
| ------ | --------------------- | ---------------------------------------------- |
| POST   | `/v1/images/optimize` | multipart `file` → optimiza (o devuelve cache) |
| GET    | `/v1/images/:hash`    | sirve imagen procesada por hash                |
| GET    | `/health`             | liveness                                       |

Response optimizar:

```json
{
  "hash": "a3f1...",
  "cached": true,
  "strategy": "gemini-edit | opencv-fallback",
  "url": "/v1/images/a3f1...",
  "processingTimeMs": 1234
}
```

## Flujo de dedup (clave del requerimiento)

1. Guard `ApiKeyGuard` valida `X-API-Key`.
2. `HashService` computa sha256 del buffer entrante.
3. `ImageRepository.findByHash(hash)` → si existe, retorna resultado persistido (`cached: true`).
4. Si no existe, `ImageOptimizer` (strategy) procesa y `Storage` guarda.
5. Persistir metadata en SQLite y responder.

## Strategy Pattern

Interfaz única `IImageOptimizer` implementada por:

- `GeminiImageOptimizerAdapter` — llama `@google/genai` edit con prompt de centrado.
- `SharpImageOptimizerAdapter` — recorte determinista por bounding-box de píxeles no-fondo (producto centrado, fondo intacto, sin IA).

Selección vía `OPTIMIZER_STRATEGY=gemini|sharp` en configuración. El fallback se activa si Gemini falla (try/catch guardado dentro del use case → registra y cae a `sharp`).

## Adapter Pattern

Los adaptadores aíslan detalles de terceros: SDK Gemini y filesystem/SQLite. Cambiar S3/GCS o Postgres solo implica nuevos adaptadores sin tocar dominio/aplicación.

## Seguridad

- `helmet` (headers seguros) registrado globalmente.
- `@nestjs/throttler` rate limit (p.ej. 60 req/min por API key).
- `ApiKeyGuard` con validación de `X-API-Key` contra env `API_KEYS` (lista rotatoria).
- Validación de upload: MIME `image/*`, tamaño máx. 7MB (límite Gemini), sanitización de nombre.
- CSRF: consumo servidor-a-servidor por header → no aplica; documentado en README + AGENTS.md. Si en el futuro hay clientes browser con cookie, integrar `csrf-csrf` con token doble-submit.

## Dependencias principales

`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/throttler`, `helmet`, `@google/genai`, `sharp`, `better-sqlite3`, `joi`, `class-validator`. Dev: `@nestjs/cli`, `@types/multer`, `jest`.

## Configuración (`.env`)

```
PORT=3000
API_KEYS=key1,key2
OPTIMIZER_STRATEGY=gemini|sharp
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-image
RATE_LIMIT_PER_MINUTE=60
STORAGE_DIR=storage/processed
DB_PATH=storage/better-image.db
MAX_FILE_SIZE_MB=7
```

## Prompt Gemini (centrado mínimo)

```
Center the product within the frame, keeping the original background and the
product's colors/shape unmodified. Recompose only the position. Output a square
image preserving resolution.
```

`responseModalities: ['IMAGE']`, `mimeType` de entrada = MIME original.

## Pasos de implementación

1. Bootstrap `nest new` base + configuración helmet/throttler.
2. Dominio/ports + UseCase `OptimizeImageUseCase`.
3. Adapters: Hash, Storage, Repository SQLite.
4. Adapter Gemini + Adapter Sharp (fallback).
5. Guard API key + controlador + DTOs + filtro errores.
6. Tests unitarios (use case con ports mock) + e2e endpoint.
7. README/AGENTS.md (stack, seguridad, CSRF explicado, estrategias, ejemplos curl).

## Verificación

- `npm test` unit; e2e con imagen fixture (hash duplicado → `cached:true` en 2ª llamada).
- Verificar rate limit respondiendo 429 tras exceder límite.
- Simular `OPTIMIZER_STRATEGY=sharp` para fallback determinista.

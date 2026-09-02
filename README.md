# better-image-ai

API para optimizar imágenes de productos (centrado del producto sobre su fondo original) usando **Gemini 2.5 Flash Image** (Nano Banana), con deduplicación por hash para no reprocesar imágenes ya optimizadas.

Arquitectura **hexagonal** (ports & adapters) con patrones **Adapter** y **Strategy**, sobre **NestJS + TypeScript**.

## Requisitos

- Node.js >= 22.13 (usa `node:sqlite` embebido; sin dependencias nativas)
- API key de Gemini (AI Studio): https://aistudio.google.com/apikey

## Quick start

```bash
cp .env.example .env          # edita GEMINI_API_KEY y API_KEYS
npm ci
npm run start:dev             # desarrollo con watch
# o
npm run build && npm start    # producción local
```

Con Docker:

```bash
docker compose up --build -d
docker compose ps        # healthcheck incluido
docker compose logs -f
```

## Despliegue en producción

La imagen es multi-stage (~150MB), usuario non-root, healthcheck en `/health` (sin rate limit; comprueba DB + storage escribible, devuelve 503 si algo falla).

**Checklist antes de desplegar:**

- [ ] `NODE_ENV=production`
- [ ] `API_KEYS` con claves fuertes generadas: `openssl rand -hex 32` (no las de `.env.example`)
- [ ] Volumen persistente en `./storage` (sin él, el cache/dedup se pierde al redeploy)
- [ ] `GEMINI_API_KEY` con billing activo (Nano Banana es de pago por uso)
- [ ] `TRUST_PROXY=1` si va detrás de Nginx/LB (si no, el rate limit agrupa todos los clientes bajo la IP del proxy)

**Recomendado delante de la API (Nginx, Caddy o LB del cloud):**

- TLS (HTTPS) — la API key viaja en header, sin TLS es interceptable
- `client_max_body_size 8m;` en Nginx para que el 413 lo devuelva el proxy
- Timeouts generosos en `/v1/images/optimize` (Gemini tarda 2-10s): `proxy_read_timeout 90s;` (> `GEMINI_TIMEOUT_MS` × intentos)

**Límites a tener en cuenta:**

- Rate limit en memoria y por IP — si escala a varias instancias detrás de un LB, migrar el throttler a storage compartido (Redis).
- Estado en disco local (SQLite + filesystem) — 1 sola instancia, o migrar storage a S3/GCS y DB a Postgres (la arquitectura de ports permite cambiar solo el adapter).
- El dedup tiene mutex por hash **en proceso**: con una sola instancia no hay llamadas duplicadas a Gemini por concurrencia.

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/health` | No | Liveness + DB/storage (sin rate limit) |
| `POST` | `/v1/images/optimize` | `X-API-Key` | Optimiza (o devuelve cache) |
| `GET` | `/v1/images/:hash` | `X-API-Key` | Sirve la imagen procesada |

Todas las respuestas incluyen `X-Request-Id` (echo del header entrante o UUID generado).

### Optimizar una imagen

```bash
curl -X POST http://localhost:3000/v1/images/optimize \
  -H "X-API-Key: dev-key-1" \
  -F "file=@producto.png;type=image/png"
```

Respuesta:

```json
{
  "hash": "a3f1c9...",
  "cached": false,
  "url": "/v1/images/a3f1c9...",
  "strategy": "gemini",
  "processingTimeMs": 1234
}
```

Si la misma imagen (mismo contenido binario) se envía de nuevo, responde `cached: true` **sin llamar a Gemini**.

### Descargar la imagen procesada

```bash
curl http://localhost:3000/v1/images/a3f1c9... -H "X-API-Key: dev-key-1" -o out.png
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP |
| `GEMINI_API_KEY` | — | **Requerida**. API key de Gemini |
| `GEMINI_MODEL` | `gemini-2.5-flash-image` | Modelo de edición |
| `GEMINI_TIMEOUT_MS` | `30000` | Timeout por llamada a Gemini |
| `GEMINI_MAX_RETRIES` | `2` | Reintentos ante fallos transitorios (429/5xx/red/timeout) |
| `API_KEYS` | — | **Requerida**. Claves válidas separadas por coma |
| `RATE_LIMIT_PER_MINUTE` | `60` | Límite de requests por IP/minuto |
| `TRUST_PROXY` | `false` | `true` o nº de hops si va detrás de proxy |
| `STORAGE_DIR` | `storage/processed` | Directorio de imágenes procesadas |
| `DB_PATH` | `storage/better-image.db` | Ruta de la base SQLite |
| `GC_INTERVAL_MINUTES` | `720` | Barrido de ficheros huérfanos (0 = solo al arranque) |
| `MAX_FILE_SIZE_MB` | `7` | Tamaño máximo de upload (límite inline de Gemini) |

La configuración se valida al arranque con **Zod** (`src/config/config.schema.ts`); si falta algo, la app falla rápido con un mensaje claro.

## Errores

Todas las respuestas de error siguen el mismo formato:

```json
{ "statusCode": 400, "code": "UNSUPPORTED_MIME_TYPE", "message": "...", "timestamp": "..." }
```

| Código | HTTP | Causa |
|--------|------|-------|
| `BAD_REQUEST` | 400 | Falta el archivo |
| `UNSUPPORTED_MIME_TYPE` | 400 | MIME no permitido, o la firma binaria no coincide (jpeg/png/webp/heic/heif) |
| `UPLOAD_ERROR` | 400 | Multipart mal formado (campo, etc.) |
| `GEMINI_BAD_REQUEST` | 400 | Gemini rechazó la imagen (4xx) |
| `UNAUTHORIZED` | 401 | API key ausente o inválida |
| `IMAGE_NOT_FOUND` | 404 | Hash inexistente o mal formado |
| `FILE_TOO_LARGE` | 413 | Supera `MAX_FILE_SIZE_MB` |
| `TOO_MANY_REQUESTS` | 429 | Rate limit excedido |
| `GEMINI_API_ERROR` | 502 | Fallo de la API de Gemini (reintentos agotados) |
| `GEMINI_TIMEOUT` | 504 | Gemini no respondió en `GEMINI_TIMEOUT_MS` (reintentos agotados) |
| `INVALID_OPTIMIZED_IMAGE` | 500 | El optimizador devolvió algo sin firma de imagen |

## Tests

```bash
npm test          # unitarios (79)
npm run test:e2e  # e2e con Gemini mockeado (13)
npm run test:cov  # cobertura
npm run lint      # eslint + prettier
```

## Seguridad

- **helmet**: cabeceras seguras (CSP, nosniff, frameguard, etc.)
- **Rate limit**: `@nestjs/throttler` por IP
- **API key**: header `X-API-Key` con comparación timing-safe; lista rotatoria vía `API_KEYS`
- **CSRF**: no aplica — el consumo es servidor-a-servidor con API key por cabecera (sin cookies de sesión). Si en el futuro se expone a navegadores con cookies, añadir `csrf-csrf` con double-submit token.

# better-image-ai

API para editar imágenes de productos con perfiles por cliente usando **Gemini 3.1 Flash Lite Image** (Nano Banana), con deduplicación por hash para no reprocesar imágenes ya optimizadas.

Arquitectura **hexagonal** (ports & adapters) con patrones **Adapter** y **Strategy**, sobre **NestJS + TypeScript**.

**Estado:** cola persistente de hasta 100 fotos, créditos prepagados y Mercado Pago implementados para una sola instancia. Falta configurar y verificar el checkout real/sandbox de tu cuenta y validar la calidad visual. Consulta la [guía de jobs, créditos y pagos](docs/jobs-and-credits.md) y la [investigación inicial](docs/production-review.md).

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

La imagen es multi-stage, usuario non-root, healthcheck en `/health` (sin rate limit; comprueba DB + storage escribible, devuelve 503 si algo falla).

**Checklist antes de desplegar:**

- [ ] `NODE_ENV=production`
- [ ] `API_KEYS` vacío y `CLIENTS_JSON` con tenants y hashes de claves aleatorias (ver abajo)
- [ ] Volumen persistente en `./storage` (sin él, el cache/dedup se pierde al redeploy)
- [ ] `GEMINI_API_KEY` con billing activo (Nano Banana es de pago por uso)
- [ ] `TRUST_PROXY=1` si va detrás de Nginx/LB (si no, el rate limit agrupa todos los clientes bajo la IP del proxy)

**Recomendado delante de la API (Nginx, Caddy o LB del cloud):**

- TLS (HTTPS) — la API key viaja en header, sin TLS es interceptable
- Límite de cuerpo del proxy acorde al lote: con 5 archivos de 7 MiB, dejar margen para multipart (por ejemplo 36 MiB)
- Timeouts del proxy acordes a espera en el semáforo, cantidad de archivos, `GEMINI_TIMEOUT_MS`, intentos y backoff. La latencia real no se ha medido; para trabajos largos usar una cola persistente

**Límites a tener en cuenta:**

- Rate limit en memoria y por IP — si escala a varias instancias detrás de un LB, migrar el throttler a storage compartido (Redis).
- Estado en disco local (SQLite + filesystem) — 1 sola instancia, o migrar storage a S3/GCS y DB a Postgres (la arquitectura de ports permite cambiar solo el adapter).
- El dedup tiene mutex por hash **en proceso**: con una sola instancia no hay llamadas duplicadas a Gemini por concurrencia.

## Jobs, créditos y compra

Los clientes nuevos empiezan con **cero créditos**. Para desarrollo o recargas manuales, configurar `ADMIN_API_KEY_HASH` y usar la ruta administrativa documentada en la [guía de integración](docs/jobs-and-credits.md). Procesar imágenes nuevas sin saldo devuelve 402; una descarga o caché no consume créditos.

| Método | Ruta | Función |
|---|---|---|
| POST | `/v1/jobs` | Crear un lote de 1–100 fotos y reservar créditos |
| POST | `/v1/jobs/:id/items` | Cargar por partes de hasta 5 archivos por defecto |
| POST | `/v1/jobs/:id/submit` | Cerrar carga y procesar en background (202) |
| GET | `/v1/jobs/:id` | Progreso y resultados por archivo |
| POST | `/v1/jobs/:id/cancel` | Cancelar pendientes y liberar reservas |
| GET | `/v1/credits` | Saldo disponible y reservado |
| POST | `/v1/payments/checkout` | Crear compra del paquete configurado |
| GET | `/v1/payments/:id` | Consultar compra propia |
| POST | `/v1/payments/:id/reconcile` | Verificar pago contra Mercado Pago |
| POST | `/v1/payments/webhook` | Notificación firmada por Mercado Pago |
| POST | `/v1/admin/clients/:tenant/credits` | Recarga auditada con clave administrativa |

Jobs, partes, compras y recargas usan `Idempotency-Key`. Se conserva el progreso al reiniciar. Los errores y duplicados liberan reservas; los resultados nuevos consumen un crédito. Ver reglas de cancelación, expiración y reversión en la guía.

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/health` | No | Liveness + DB/storage (sin rate limit) |
| `POST` | `/v1/images/optimize` | `X-API-Key` | Optimiza (o devuelve cache) |
| `POST` | `/v1/images/batch` | `X-API-Key` | Lote pequeño, resultado individual por archivo |
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

Si la misma imagen con el mismo cliente, instrucciones y versión del optimizador se envía de nuevo, responde `cached: true` **sin llamar a Gemini**.

### Descargar la imagen procesada

```bash
curl http://localhost:3000/v1/images/a3f1c9... -H "X-API-Key: dev-key-1" -o out.png
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP |
| `GEMINI_API_KEY` | — | **Requerida**. API key de Gemini |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite-image` | Modelo de edición |
| `GEMINI_TIMEOUT_MS` | `30000` | Timeout por llamada a Gemini |
| `GEMINI_MAX_RETRIES` | `2` | Reintentos ante fallos transitorios (429/5xx/red/timeout) |
| `API_KEYS` | vacío | Solo desarrollo: todas pertenecen al tenant `legacy` |
| `CLIENTS_JSON` | `[]` | Tenants, hashes de claves y perfiles; obligatorio en producción |
| `MAX_ACTIVE_REQUESTS` | `4` | Cargas/procesamientos simultáneos admitidos |
| `GEMINI_CONCURRENCY` | `2` | Máximo de operaciones Gemini simultáneas, incluyendo reintentos |
| `MAX_BATCH_FILES` | `5` | Archivos por lote (máximo configurable: 20) |
| `RATE_LIMIT_PER_MINUTE` | `60` | Límite de requests por IP/minuto |
| `TRUST_PROXY` | `false` | `true` o nº de hops si va detrás de proxy |
| `STORAGE_DIR` | `storage/processed` | Directorio de imágenes procesadas |
| `DB_PATH` | `storage/better-image.db` | Ruta de la base SQLite |
| `GC_INTERVAL_MINUTES` | `720` | Barrido de ficheros huérfanos (0 = solo al arranque) |
| `MAX_FILE_SIZE_MB` | `7` | Tamaño máximo de upload (límite de esta API) |

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
| `GEMINI_BAD_REQUEST` | 400 | Gemini rechazó la imagen/instrucciones (400/422) |
| `UNAUTHORIZED` | 401 | API key ausente o inválida |
| `IMAGE_NOT_FOUND` | 404 | Hash inexistente o mal formado |
| `FILE_TOO_LARGE` | 413 | Supera `MAX_FILE_SIZE_MB` |
| `TOO_MANY_REQUESTS` | 429 | Rate limit excedido |
| `GEMINI_API_ERROR` | 502 | Fallo de la API de Gemini (reintentos agotados) |
| `SERVICE_UNAVAILABLE` | 503 | Capacidad de procesamiento agotada; respetar `Retry-After` |
| `GEMINI_TIMEOUT` | 504 | Gemini no respondió en `GEMINI_TIMEOUT_MS` (reintentos agotados) |
| `INVALID_OPTIMIZED_IMAGE` | 500 | El optimizador devolvió algo sin firma de imagen |

## Tests

```bash
npm test          # unitarios
npm run test:e2e  # e2e con Gemini mockeado
npm run test:cov  # cobertura
npm run lint      # eslint + prettier
```

## Seguridad

- **helmet**: cabeceras seguras (CSP, nosniff, frameguard, etc.)
- **Rate limit**: `@nestjs/throttler` por IP
- **API key**: header `X-API-Key` con comparación timing-safe; rotación de hashes por tenant vía `CLIENTS_JSON` en producción
- **CSRF**: no aplica — el consumo es servidor-a-servidor con API key por cabecera (sin cookies de sesión). Si en el futuro se expone a navegadores con cookies, añadir `csrf-csrf` con double-submit token.

## Clientes y perfiles

Genera una clave aleatoria y su hash en tu entorno seguro. Entrega la clave al cliente una sola vez; almacena solo el hash en configuración. Ejemplo de comando local:

```bash
node -e 'const c=require("node:crypto");const key=c.randomBytes(32).toString("hex");console.log({key,hash:c.createHash("sha256").update(key).digest("hex")})'
```

Configura `API_KEYS=` y `CLIENTS_JSON` (JSON en una sola línea; reemplaza el marcador por el hash real de 64 caracteres):

```dotenv
CLIENTS_JSON=[{"id":"tienda-1","keyHashes":["HASH_SHA256_DE_LA_CLAVE"],"profiles":{"default":"Center product on white background, square composition.","catalogo":"Center product on light gray background with a subtle shadow."}}]
```

Sin `profile`, se usa el perfil `default` del cliente o el prompt original de centrado. Un perfil desconocido devuelve 400. Los perfiles solo se editan en configuración del servidor y requieren reinicio; los cambios generan nuevas entradas de caché.

```bash
curl http://localhost:3000/v1/images/optimize \
  -H "X-API-Key: $CLIENT_API_KEY" \
  -F 'profile=catalogo' -F 'file=@producto.png;type=image/png'

curl http://localhost:3000/v1/images/batch \
  -H "X-API-Key: $CLIENT_API_KEY" \
  -F 'profile=catalogo' \
  -F 'files=@producto-1.png;type=image/png' \
  -F 'files=@producto-2.png;type=image/png'
```

El lote responde `201` con `{ "results": [...] }`. Cada elemento tiene `index`, `status: "succeeded"` y los campos de optimización, o `status: "failed", code: "PROCESSING_FAILED"`. Un 201 no significa que todos los archivos hayan tenido éxito. Todos se validan antes de realizar llamadas facturables.

Los resultados son privados: solo otra clave del mismo tenant puede descargarlos. La rotación conserva el id del tenant y añade/elimina hashes. No compartir ids entre empresas.

**Migración:** respalda SQLite y storage. Se añade `tenant_id` y se asignan registros antiguos a `legacy`; no se reasignan automáticamente a clientes nuevos. Los hashes de resultado cambian con esta versión. Se ha actualizado a NestJS 11 y Zod 4; instalar con `npm ci`.

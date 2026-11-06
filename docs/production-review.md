# Revisión inicial para lanzamiento — 6 de noviembre de 2026

> Actualización: la cola persistente, el ledger de créditos y Checkout Pro de Mercado Pago ya están implementados. Este documento conserva el diagnóstico inicial; el contrato vigente y los límites operativos están en [jobs-and-credits.md](jobs-and-credits.md). La implementación actual usa SQLite en una sola instancia; Redis/PostgreSQL siguen siendo una evolución para múltiples instancias.

## Dictamen

La API tiene una base hexagonal útil, pero no equivale todavía a un SaaS listo para cobrar. Esta revisión implementa aislamiento de clientes, perfiles de edición configurados por el operador, deduplicación correcta, lotes pequeños y controles de capacidad. No se ha desplegado ni se han hecho llamadas facturables a Gemini. La calidad visual, latencia y coste efectivo requieren un piloto real.

El alcance verificable es una instancia de Node, un volumen persistente local y SQLite. No ejecutar réplicas ni workers compartiendo este directorio: los locks, el semáforo y el rate limit son locales al proceso.

## Hallazgos y correcciones

| Riesgo inicial | Cambio |
|---|---|
| Cualquier clave podía descargar cualquier imagen conociendo su hash | Propiedad por tenant, comprobación en descarga y 404 si pertenece a otro cliente |
| Caché por archivo ignoraba las instrucciones y el modelo | Identificador derivado de tenant, hash original, MIME, instrucciones y versión del optimizador |
| Claves compartidas en texto plano | En producción se requieren hashes SHA-256 de claves aleatorias; id estable para rotación |
| Un caché compartido podía servir imágenes privadas | `Cache-Control: private, no-store` |
| GC podía borrar un archivo entre escritura y commit | Exclusión compartida para persistencia y snapshot/borrado del GC |
| Cargas y llamadas simultáneas sin presupuesto global | Admisión antes de Multer, límites multipart y semáforo para Gemini |
| Cada reintento podía sincronizarse con otros clientes | Backoff con jitter; no reintentar errores permanentes |
| Errores de autenticación del proveedor se atribuían al consumidor | 401/403 del proveedor se clasifican como fallo de integración, sin exponer su respuesta |
| GC borraba archivos ajenos y probes con nombre compartido | Solo elimina hashes/temporales propios; probes con nombre aleatorio |
| Lecturas ocultaban errores de disco como 404 | Solo ENOENT se convierte a imagen inexistente |

Los límites de firma binaria existentes detectan tipos, no garantizan que un archivo sea decodificable ni que sea una imagen segura/completa. No se ha añadido un decodificador ni detección de dimensiones. Es un requisito para el pipeline de normalización propuesto.

## Producto y calidad

Vendería perfiles reproducibles: fondo, relación de aspecto, ocupación del encuadre, sombra, margen y formato final. El cliente configura un perfil una vez y lo usa por id en cada producto. Ahora los perfiles son prompts guardados en `CLIENTS_JSON`; el endpoint no acepta un prompt arbitrario por upload. Cambiar instrucciones cambia automáticamente la clave de caché. No existe todavía un panel/API de administración de perfiles.

Un prompt no es una garantía de fidelidad. En e-commerce, modificar un logo, una etiqueta, el color o la cantidad de componentes puede falsear el producto. Separaría dos servicios en una evolución futura: composición determinista del producto recortado para fidelidad, y edición generativa para escenas/fondos. Esto es una recomendación de diseño; esta implementación mantiene una sola estrategia Gemini.

Piloto propuesto: 100–200 imágenes representativas de ropa, joyería, envases con texto, transparencias, reflejos y productos con múltiples piezas. Registrar conservación del producto, encuadre, fondo, errores de texto, aceptación humana, latencias p50/p95, reintentos y coste por imagen aceptada. Comparar variantes de prompt/modelo con los mismos originales y revisión ciega. Ningún benchmark de calidad fue ejecutado aquí.

Google documenta limitaciones y marca SynthID en las imágenes generadas. No prometer archivos equivalentes al original ni dimensiones exactas basándose solo en instrucciones de texto. [Generación de imágenes](https://ai.google.dev/gemini-api/docs/image-generation).

## Alcance comercial confirmado

El usuario ha elegido hasta 100 fotos por cliente, espera de minutos y créditos prepagados por imagen. Por eso el camino prioritario es una cola persistente de llamadas normales a Gemini, con reserva de créditos por elemento. La Batch API de 24 horas queda como modalidad económica futura y opcional; no satisface el objetivo de latencia confirmado.

Propuesta de aceptación: admitir 100 elementos de forma incremental sin retener todos sus buffers en RAM, devolver un id consultable y conservar el progreso tras reinicios. No fijar un SLA en minutos sin medir la latencia y cuota real del proyecto. A dos slots, 100 imágenes de 10 segundos tardarían unos 500 segundos sin caché ni reintentos: ejemplo aritmético, no benchmark.

## Masivos: dos niveles

La ruta implementada `POST /v1/images/batch` recibe varios campos `files`, valida el lote completo y procesa secuencialmente dentro del lote; otros requests pueden usar los demás slots de Gemini. Devuelve resultados ordenados con índice, estado y resultado/error por archivo. El máximo predeterminado es 5 archivos. No es un job persistente: mantiene HTTP abierto, y un reinicio pierde el trabajo pendiente. Un reenvío reutiliza los elementos que ya quedaron persistidos. No anunciar soporte de miles de fotos sobre esta ruta.

Para catálogos grandes propongo `POST /v1/jobs` → `202` con id; `GET /v1/jobs/:id` para progreso y resultados paginados. Persistir inputs en almacenamiento de objetos privado, snapshot del perfil y filas por elemento. BullMQ/Redis coordina workers; PostgreSQL conserva estados y el libro de consumo. La integración oficial de Nest soporta BullMQ, workers y eventos de cola. [Colas de Nest](https://docs.nestjs.com/techniques/queues).

Estados propuestos: queued → running → succeeded/failed/cancelled. Reintentos por elemento, leases para recuperar workers, límites por tenant y proveedor, idempotencia por tenant + clave + digest del payload. Una clave repetida con otro payload debe producir 409. Entrega de eventos al menos una vez con outbox y deduplicación. Los webhooks requieren firma, reintentos y protección SSRF, o empezar solo con polling. Esta arquitectura está propuesta, no implementada.

Para trabajos no urgentes, evaluar la Batch API del proveedor: Google describe un descuento del 50% frente a llamadas estándar y una ventana de hasta 24 horas. Confirmar soporte y precio del modelo elegido antes de activar esa modalidad. [Optimización de Gemini](https://ai.google.dev/gemini-api/docs/optimization), [Batch API](https://ai.google.dev/gemini-api/docs/batch-api).

## Costes y cobro

La deduplicación evita llamadas repetidas, pero no constituye contabilidad. Un timeout puede haberse facturado en el proveedor aunque el servidor no reciba el resultado; reintentar puede volver a costar. No prometer exactly-once para llamadas externas.

Medir coste unitario real = (generación + intentos fallidos facturables + almacenamiento + egreso + infraestructura) / resultados aceptados. Definir qué se cobra: recomiendo una unidad por resultado persistido y cero por cache hit, con precio que absorba reintentos y rechazos. Es una propuesta comercial, no una regla implementada. La tabla de Google cambia por modelo, resolución y modalidad; no fijar márgenes con el precio histórico de Gemini 2.5. [Precios oficiales](https://ai.google.dev/gemini-api/docs/pricing).

Antes de cobrar: elegir pasarela/país/moneda; implementar los créditos prepagados elegidos por el usuario, reservas atómicas antes de ejecutar, confirmación de consumo al persistir y liberación en fallos definidos. Ledger append-only con clave única del trabajo, webhooks de pago verificados e idempotentes, conciliación y límites de gasto diarios/mensuales. No existe aún pasarela ni ledger ni cuota económica. El límite de concurrencia reduce picos; no limita el gasto mensual.

## Operación, seguridad y migración

- Usar HTTPS en proxy, secretos fuera del repositorio y claves aleatorias de al menos 32 bytes. SHA-256 es apropiado aquí por la alta entropía de las claves, no para contraseñas humanas.
- La configuración de tenants se carga al arrancar. Para rotar, añadir nuevo hash al mismo id, reiniciar, migrar al cliente y eliminar el hash anterior. Revocación requiere reinicio. Nunca reutilizar el id de un cliente eliminado para otro.
- Se añade `tenant_id` a SQLite sin borrar filas; las antiguas se asignan a `legacy`. Producción deshabilita las claves legacy: esas filas no se entregan a nuevos tenants automáticamente. Respaldar DB y storage antes del upgrade y definir explícitamente su atribución si se desea recuperar acceso.
- Los hashes nuevos no equivalen al SHA-256 del original. Los clientes deben tratarlos como identificadores opacos. El primer envío tras actualizar puede volver a procesarse.
- Hacer backups consistentes con la API de backup de SQLite o una ventana sin escrituras; no copiar solo el archivo principal con WAL activo. Probar restauración y retención.
- Medir cola/slots, solicitudes por tenant, cache-hit ratio, errores por código, latencia y consumo del proveedor. Alertar por saturación, disco lleno, 429/5xx y aumento de gasto. Falta instrumentación de métricas/alertas.
- Configurar límites de cuerpo y tiempos en el proxy. Memoria base máxima de inputs aproximadamente `MAX_ACTIVE_REQUESTS × MAX_BATCH_FILES × MAX_FILE_SIZE_MB`, más base64, resultados, SDK y runtime. Ajustar con pruebas de carga; los defaults no son una garantía de uso de RAM.
- El rate limit por IP sigue siendo en memoria; faltan cuotas persistentes por cliente para una oferta comercial. [Rate limiting de Nest](https://docs.nestjs.com/security/rate-limiting).
- Revisar disponibilidad del modelo en el proyecto real. Las páginas oficiales consultadas ofrecen señales distintas para el ciclo de vida de Gemini 3.1 Flash Lite Image; no se certificó disponibilidad mediante llamada real. Se conserva el modelo configurable para evaluar y migrar con fixtures. [Deprecaciones](https://ai.google.dev/gemini-api/docs/deprecations), [FAQ de Firebase](https://firebase.google.com/docs/ai-logic/faq-and-troubleshooting).

## Criterios antes de lanzar

1. Cerrar auditoría de dependencias de producción y ejecutar CI con instalación reproducible.
2. Aprobar un conjunto visual con el modelo disponible en la cuenta real.
3. Implementar ledger/cuotas y pasarela antes de aceptar dinero.
4. Implementar cola persistente antes de anunciar catálogos masivos.
5. Ensayar carga, caída del proveedor, timeout, disco lleno, reinicio y recuperación.
6. Configurar TLS, secretos, backups/restauración, observabilidad y política de conservación/borrado de originales y resultados.

## Auditoría de dependencias

La instalación inicial mostró 40 avisos (2 críticos). Se actualizaron NestJS a 11, Config a 4, Zod a 4 y Multer a 2.5, y se fijaron versiones corregidas de dependencias transitivas. La auditoría `npm audit --omit=dev` posterior devuelve cero vulnerabilidades conocidas. Esto es una comprobación del catálogo npm en la fecha de ejecución, no una certificación de seguridad. La auditoría completa aún informa avisos en herramientas de desarrollo; no se incluyen en la imagen runtime (`npm ci --omit=dev`).

# Lotes persistentes y créditos prepagados

Implementación para **una instancia** de la API, con SQLite/WAL y volumen persistente. No requiere Redis. Los nuevos ports `JOBS`, `CREDITS`, `PURCHASES` y `PAYMENT_GATEWAY` separan la orquestación de la persistencia y Mercado Pago.

## Reglas de cobro

- Un crédito por imagen nueva persistida correctamente. Caché y errores no consumen créditos.
- `/v1/images/optimize` y `/v1/images/batch` también requieren saldo para generar resultados nuevos. Un cliente sin saldo recibe 402 (en batch, consultar los resultados individuales).
- Crear un job reserva un crédito por archivo declarado; se necesita el saldo completo inicialmente, aunque después aparezcan duplicados.
- Resultado y consumo se confirman en una transacción SQLite. Una interrupción posterior al commit no duplica el consumo. Se conservan movimientos de recarga, reserva, liberación y captura en `credit_ledger`.
- Los timeouts del proveedor pueden tener coste aunque no entreguen imagen. Ese coste lo absorbe el servicio; no hay garantía exactly-once para llamadas externas.
- Todos los clientes empiezan con cero créditos. No existe una clave de cliente que pueda recargarse a sí misma.

## Recarga administrativa

Genera una clave administrativa distinta de las claves de clientes; configura **solo su SHA-256** en `ADMIN_API_KEY_HASH`. La ruta está deshabilitada sin esa variable. Conserva la clave en el servidor de administración, nunca en un navegador ni en la integración del cliente.

```bash
curl -X POST "$API_URL/v1/admin/clients/tienda-1/credits" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H 'Idempotency-Key: recarga-manual-0001' \
  -H 'Content-Type: application/json' \
  -d '{"amount":100}'

curl "$API_URL/v1/credits" -H "X-API-Key: $CLIENT_API_KEY"
```

Repetir una referencia no recarga de nuevo. Usarla con otro importe o cliente devuelve 409. El saldo distingue `available` y `reserved`.

## Procesar hasta 100 fotos

1. Crear un job con el número exacto de fotos y, opcionalmente, un perfil. El servidor guarda una copia de las instrucciones y la versión del optimizador.

```bash
curl -X POST "$API_URL/v1/jobs" \
  -H "X-API-Key: $CLIENT_API_KEY" \
  -H 'Idempotency-Key: catalogo-2026-0001' \
  -H 'Content-Type: application/json' \
  -d '{"count":100,"profile":"catalogo"}'
```

Guardar el `id` de la respuesta como `JOB_ID`. No se procesa ninguna imagen hasta cerrar la carga con `/submit`.

2. Subir las imágenes en partes de hasta `MAX_BATCH_FILES` (5 por defecto), usando una clave de idempotencia diferente para cada parte. Reenviar una parte con la misma clave y archivos no duplica sus elementos. El orden de los archivos forma parte del contenido idempotente. Reutilizar la clave con otros archivos devuelve 409.

```bash
curl -X POST "$API_URL/v1/jobs/$JOB_ID/items" \
  -H "X-API-Key: $CLIENT_API_KEY" \
  -H 'Idempotency-Key: parte-0001' \
  -F 'files=@producto-1.png;type=image/png' \
  -F 'files=@producto-2.png;type=image/png'
```

Continuar hasta completar los 100 archivos. El servidor conserva los originales pendientes como BLOBs en SQLite y valida cada parte completa antes de aceptarla. El perfil no se cambia durante la carga. No enviar 100 fotos en una sola petición.

3. Enviar a la cola y consultar progreso.

```bash
curl -X POST "$API_URL/v1/jobs/$JOB_ID/submit" -H "X-API-Key: $CLIENT_API_KEY"
# HTTP 202
curl "$API_URL/v1/jobs/$JOB_ID" -H "X-API-Key: $CLIENT_API_KEY"
```

La respuesta incluye `status`, `expected`, `uploaded`, `completed`, `failed`, `charged` e `items`. Cada elemento tiene `index`, `status`, `hash` y `code`. Un `hash` exitoso se descarga con la clave del mismo cliente en `/v1/images/:hash`. `completed` en el job significa que no queda trabajo, no que todos los elementos hayan salido bien: revisar `failed`.

Consultar cada 2–5 segundos suele bastar; respetar 429 y `Retry-After` cuando corresponda. El número máximo de elementos hace que una respuesta de progreso sea acotada, sin necesidad de paginación.

```bash
curl -X POST "$API_URL/v1/jobs/$JOB_ID/cancel" -H "X-API-Key: $CLIENT_API_KEY"
```

Cancelar libera lo que aún no empezó. Las imágenes en ejecución terminan y pueden consumir un crédito si se guardan. La cancelación no deshace trabajos completados. Los jobs sin completar la carga expiran a los 60 minutos desde su creación y liberan reservas.

## Recuperación y capacidad

- Estados: `uploading`, `queued`, `running`, `completed`, `cancelled`, `expired`.
- El worker recupera los elementos interrumpidos al arrancar y reconoce resultados ya confirmados. También libera reservas de peticiones síncronas interrumpidas.
- Los bytes de entrada se eliminan lógicamente al terminar o cancelar cada elemento; no forman parte del resultado público. SQLite puede reutilizar sus páginas y conservar bytes en páginas libres/WAL/backups: esto no es borrado seguro. Definir retención, cifrado del volumen y mantenimiento de DB antes de datos sensibles.
- `MAX_PENDING_IMAGES=1000` limita la suma de tamaños declarados de jobs activos. Con archivos de 7 MiB eso puede requerir unos 7 GiB de disco, más WAL, resultados y backups. Medir y dimensionar el volumen.
- `JOB_WORKERS=2` controla los elementos activos. El semáforo `GEMINI_CONCURRENCY` se comparte con las rutas síncronas. La carga incremental limita memoria; no se ha ejecutado un benchmark de 100 imágenes reales de 7 MiB.
- Un despliegue que cambia la versión del optimizador hace fallar con `OPTIMIZER_VERSION_CHANGED` los elementos pendientes de la versión anterior y libera sus créditos. Drenar la cola antes de cambiar modelo/prompt. Los resultados ya confirmados se recuperan sin volver a generar.
- **No usar varias réplicas ni PM2 cluster sobre la misma DB.** La recuperación de trabajo en ejecución presupone una sola instancia. Para escalar: adapters con leases/fencing distribuidos, almacenamiento de objetos y DB/cola compartidas.
- La política actual termina un elemento tras agotar los reintentos del adapter Gemini. No hay un segundo bucle de reintentos ilimitados de generación. Se pueden reenviar los fallidos en un nuevo job.

## Mercado Pago Checkout Pro

El código integra Preferences API. Los secretos y precios se configuran en el servidor; no se aceptan importes ni cantidades de créditos enviados por el comprador.

```dotenv
MP_ACCESS_TOKEN=credencial-de-prueba
MP_WEBHOOK_SECRET=secreto-de-webhooks
MP_COLLECTOR_ID=id-del-vendedor
MP_LIVE_MODE=false
MP_CURRENCY=COP
CREDIT_PACK_SIZE=100
CREDIT_PACK_PRICE=50000
PUBLIC_BASE_URL=https://api.example.com
```

El precio de arriba es **un ejemplo**, no una tarifa acordada. `CREDIT_PACK_PRICE` usa unidades enteras de la moneda (50000 COP = cincuenta mil pesos, no centavos). Todos los valores son obligatorios si se configura el token. Sin token, la API sigue funcionando con recargas manuales, y el checkout responde 503.

```bash
curl -X POST "$API_URL/v1/payments/checkout" \
  -H "X-API-Key: $CLIENT_API_KEY" \
  -H 'Idempotency-Key: compra-creditos-0001'
```

La respuesta contiene `id`, `credits`, `price`, `currency`, `status` y `checkoutUrl`. Redirigir al cliente a esa URL. Las credenciales de prueba y `MP_LIVE_MODE=false` seleccionan el checkout de sandbox. Usar una nueva clave por compra deliberada; mantenerla para reintentos de esa misma compra.

Registrar en Mercado Pago la URL HTTPS **`/v1/payments/webhook`**, notificaciones de **pagos** (`payment`). El endpoint verifica HMAC-SHA256 usando `data.id` de la query, `x-request-id` original y `x-signature`; después consulta `/v1/payments/{id}` con el token del vendedor. No confía en el importe, estado o id del cuerpo ni en parámetros de retorno del navegador. Comprueba cuenta vendedora, modo prueba/real, importe, moneda y referencia de compra.

Solo un pago `approved` puede acreditar el paquete. La transición a pagado y la recarga se ejecutan en la misma transacción, con id de pago único. Las notificaciones repetidas no duplican créditos. Una caída antes de confirmar devuelve error para que Mercado Pago reintente.

```bash
curl "$API_URL/v1/payments/$PURCHASE_ID" -H "X-API-Key: $CLIENT_API_KEY"
# Si la notificación se retrasa, el paymentId del comprobante permite reconciliar:
curl -X POST "$API_URL/v1/payments/$PURCHASE_ID/reconcile" \
  -H "X-API-Key: $CLIENT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"paymentId":"123456789"}'
```

La reconciliación también consulta Mercado Pago y comprueba pertenencia de la compra. Nunca acredita basándose solamente en el id suministrado.

Si se detecta devolución, devolución parcial, contracargo o dos pagos para la misma compra, se registra un incidente y se bloquean nuevas generaciones de la cuenta. **La devolución de dinero y el ajuste de créditos requieren revisión administrativa**; el sistema no devuelve dinero automáticamente ni descuenta a ciegas créditos ya consumidos. Revisar `payment_incidents` y `blocked_accounts`, conciliar con el vendedor y el ledger antes de desbloquear. Las descargas/resultados ya existentes siguen disponibles.

Una interrupción al crear la preferencia puede dejar una preferencia adicional en Mercado Pago al reintentar. Comparten la misma referencia de compra y no dan créditos adicionales; un segundo pago se envía a revisión. No se promete exactly-once de creación externa.

Referencias consultadas: [crear preferencias](https://www.mercadopago.com.co/developers/en/reference/online-payments/checkout-pro-preferences/create-preference/post), [firma y notificaciones](https://www.mercadopago.com.co/developers/en/docs/checkout-pro-preferences/additional-settings/optional-notifications?scope=prod).

## Validación antes de activar cobros

Las pruebas automáticas simulan Mercado Pago y Gemini. No se han creado preferencias reales ni cobrado dinero. Configurar credenciales de prueba, confirmar moneda/precio, completar un checkout de sandbox y comprobar firma, consulta de pago, saldo, reintento y reversión. Solo después pasar a credenciales reales y `MP_LIVE_MODE=true`. Mantener backups consistentes de DB y resultados y probar restauración antes del lanzamiento.

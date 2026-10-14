# HH API

API Node.js 24 + Express, separada de `../hh-app`. Valida usuarios existentes de SQL Server (`hherp.dbo.seg_usuarios`) y permite actualizar la contraseña cuando la cuenta exige cambio obligatorio.

## Desarrollo

```sh
npm ci
cp .env.example .env # Solo si aún no existe .env
# Configurar DB_PASSWORD localmente.
npm run dev
```

En este equipo ya está configurado `.env`, excluido del repositorio y del contexto Docker. Las credenciales SQL nunca deben ponerse en el frontend. API: `http://localhost:3001`. App: Expo en `../hh-app`. Configurar `EXPO_PUBLIC_API_URL` con la IP LAN de este equipo y puerto 3001 para conectar desde el teléfono. El origen web opcional de Expo debe coincidir con `FRONTEND_ORIGIN`.

## Rutas

| Método | Ruta | Función |
| --- | --- | --- |
| GET | `/api/health` | Estado del proceso (no comprueba SQL) |
| POST | `/api/auth/login` | JSON `{ "username": "usuario", "password": "contraseña" }` |
| POST | `/api/auth/change-password` | JSON `{ "username": "usuario", "currentPassword": "actual", "newPassword": "nueva" }` |
| GET | `/api/auth/me` | Usuario de la sesión vigente |
| POST | `/api/auth/logout` | Revoca la sesión y elimina la cookie |
| GET | `/api/mobile/summary` | Resumen del efectivo asignado y bolsas pendientes |
| GET | `/api/deliveries/today` | Bolsas pendientes por entregar, aunque sean de días anteriores |
| GET | `/api/deliveries/history` | Últimas entregas realmente entregadas |
| GET | `/api/cash-cut/today` | Mini corte del efectivo asignado |
| POST | `/api/deliveries/:id/complete` | Registra entrega con importe, receptor, firma y video |
| POST | `/api/deliveries/:id/issue` | Registra no entregado/incidencia |

Login y `/me` devuelven `{ user: { id, username, name, email, requiresPasswordChange } }`. No se devuelve el hash, salt ni la contraseña. El navegador usa `credentials: 'include'`. Android/iOS envían `X-Client: hh-app` al login y reciben además `{ token, expiresIn }`, sin cookie. Guardan el token en Expo SecureStore y lo envían con `Authorization: Bearer <token>` a `/me`, `/logout` y a un nuevo login para rotar la sesión. Un encabezado Authorization inválido no recurre a la cookie.

La validación usa PBKDF2-HMAC-SHA256 con salt binario, iteraciones y longitud de hash de cada registro, contraseña UTF-8 y comparación de tiempo constante. Se verificó que los registros actuales indican ese algoritmo, 150000 iteraciones y hash/salt de 32 bytes. Se confirmó la contraseña del usuario de prueba `operador1`; si la cuenta exige cambio de contraseña, login devuelve 403 con `PASSWORD_CHANGE_REQUIRED`. El frontend muestra una pantalla de nueva contraseña y llama a `/auth/change-password`; si la contraseña actual es correcta, el API genera un nuevo salt/hash, desactiva `RequiereCambioPassword`, actualiza `UltimoCambioPasswordUtc` y entrega sesión normal. Se deniega acceso a cuentas inactivas/bloqueadas.

Se parametrizan todas las consultas. Fuera del cambio obligatorio de contraseña, no se actualizan `IntentosFallidos`, `UltimoLoginUtc` ni otros campos. Se limitan intentos por IP (10 cada 15 minutos); errores de autenticación usan respuesta genérica. El contador se reinicia al reiniciar la API.

Las entregas usan el esquema `efectivo`. `efectivo.entregas` contiene a quién y cuánto entregar. Cada entrega real inserta una fila en `efectivo.entregas_detalle`. La app captura firma en pantalla y video frontal; el API genera un PNG de la firma, guarda su binario en `FirmaContenido`, `image/png` en `FirmaMimeType` y el SHA-256 en `FirmaHashSha256`. Del video se calcula y guarda `VideoId`, extensión, MIME, tamaño y `VideoHashSha256`. La tabla actual no tiene columna para guardar el binario completo del video; si se agrega una columna de contenido de video, se debe mapear en `src/modules/deliveries/repository.js`.

Sesiones opacas de 8 horas por defecto, almacenadas **en memoria** (tokens guardados como SHA-256). En web: cookies HttpOnly y SameSite=Lax; en producción Secure. En Android/iOS: token Bearer, almacenado en el dispositivo con SecureStore. Cerrar sesión revoca el token; `/me` vuelve a comprobar el estado de la cuenta. Un reinicio obliga a iniciar sesión de nuevo. Antes de escalar a varias réplicas, mover sesiones y límites a un almacén compartido como Redis. No hay registro público, recuperación de contraseña ni autorización de módulos todavía.

## Docker

```sh
docker compose up --build -d
docker compose logs -f api
```

Compose usa `.env` en ejecución; la imagen no contiene secretos. El contenedor corre como usuario sin privilegios, con sistema de archivos de solo lectura y healthcheck. Para una prueba Docker local se conserva `NODE_ENV=development` del `.env`.

Para desplegar, configurar `NODE_ENV=production`, `COOKIE_SECURE=true`, `FRONTEND_ORIGIN=https://tu-dominio` y un proxy HTTPS para la API. La app nativa apunta a esa dirección HTTPS; si se usa la vista web, servirla bajo el mismo sitio que la API. Solo configurar `TRUST_PROXY_HOPS=1` si existe exactamente un proxy confiable y no se puede acceder directamente a la API; por defecto es 0. Compose publica el puerto únicamente en loopback. Si el proxy corre en otro contenedor, conectarlo a la misma red Docker.

El servidor SQL actual tiene certificado autofirmado, por eso la configuración local usa `DB_TRUST_SERVER_CERTIFICATE=true`. La conexión está cifrada, pero no verifica la identidad mediante una CA. Con un certificado confiable, usar `false`.

## Verificación

```sh
npm test
```

Las pruebas cubren login, cookies, rotación/revocación/expiración, credenciales incorrectas, cuentas inactivas/bloqueadas, cambio requerido, cambio obligatorio de contraseña, resumen móvil, validación de entrega con firma/video, bloqueo posterior al login, validación de entrada, origen, rate limiting y errores de base de datos. No modifican la base real.

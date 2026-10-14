# Calculadora Laboral

Un solo despliegue con dos calculadoras de finiquito:

| Ruta | Calculadora | Acceso |
|---|---|---|
| `/` | Calculadora de Finiquito — Consultores Donceles | Pública |
| `/baugh/` | Calculadora de Finiquito Baugh (versión ampliada) | Solo equipo de Baugh Abogados |

Las dos se instalan como app en el celular (PWA) y abren sin internet una vez visitadas.

## Estructura

```
server.js                 servidor Express (rutas, sesión, acceso con El Castillo y contraseña)
public/                   calculadora pública de Donceles + manifest, service worker e íconos
private/baugh/            calculadora de Baugh + manifest, service worker e íconos
views/login.html          pantalla de acceso de Baugh
```

## Despliegue en Railway

1. New Project → Deploy from GitHub repo → `baughabogados-hub/Calculadora-Laboral`.
2. Railway detecta Node y ejecuta `npm start`.
3. En **Variables** agrega:

| Variable | Valor |
|---|---|
| `SESSION_SECRET` | Cadena aleatoria de 32+ caracteres, propia de esta app. Obligatoria: sin ella `/baugh/` queda cerrada. |
| `CASTILLO_URL` | URL pública de El Castillo, p. ej. `https://el-castillo-production.up.railway.app` |
| `CASTILLO_API_KEY` | La misma `CASTILLO_API_KEY` que usan El Castillo y las demás apps. |
| `BAUGH_PASSWORD` | Opcional. Contraseña del equipo como respaldo. Si la dejas vacía, solo se entra con El Castillo. |
| `SESSION_HOURS` | Opcional. Horas que dura la sesión (12 por defecto). |
| `CASTILLO_APP_KEY` | Opcional. Clave de la app en El Castillo (`calculadora` por defecto). |

Para generar un secreto: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. Settings → Networking → Generate Domain (o conecta un dominio propio).
5. Healthcheck: `/healthz`.

Para cambiar la contraseña del equipo basta con cambiar `BAUGH_PASSWORD` en Railway. Para cerrar todas las sesiones abiertas, cambia `SESSION_SECRET`.

## Acceso con El Castillo

Sigue el mismo esquema que las demás apps del despacho:

1. La pantalla de acceso muestra los usuarios activos de El Castillo (`/api/usuarios-selector`).
2. La persona elige su nombre y escribe su PIN. Si no tiene, lo crea ahí mismo (`/api/pin/crear`); si ya tiene, se verifica (`/api/pin/verificar`).
3. Antes de aceptar el PIN, la calculadora consulta `/api/permiso?app=calculadora`. Si el nivel es `ninguno`, no entra.
4. Con la sesión abierta, el permiso se vuelve a consultar cada 5 minutos: si se lo quitas en El Castillo, la persona sale al recargar.

Cinco intentos fallidos bloquean 15 minutos, por dispositivo y por usuario.

En El Castillo la app está registrada como `calculadora` (rama `calculadora-finiquito`). Agrega allá `CALCULADORA_URL` con la URL de esta app terminando en `/baugh/` y da permiso desde `/admin` a quien deba usarla.

## Desarrollo local

```
npm install
SESSION_SECRET=$(node -e "console.log('x'.repeat(40))") BAUGH_PASSWORD=prueba CASTILLO_URL=http://localhost:4060 CASTILLO_API_KEY=dev-castillo-key-cambiar-en-produccion npm start
```

Abre http://localhost:3000 (Donceles) y http://localhost:3000/baugh/ (Baugh).

## Notas

- La calculadora de Baugh queda guardada en el celular de quien ya inició sesión, para usarla sin internet. Al cerrar sesión se borra esa copia.
- Este repositorio es público: el código de ambas calculadoras se puede leer en GitHub. La contraseña protege la página publicada, no el código fuente.

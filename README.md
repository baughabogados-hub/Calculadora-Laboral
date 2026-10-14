# Calculadora Laboral

Un solo despliegue con dos calculadoras de finiquito:

| Ruta | Calculadora | Acceso |
|---|---|---|
| `/` | Calculadora de Finiquito — Consultores Donceles | Pública |
| `/baugh/` | Calculadora de Finiquito Baugh (versión ampliada) | Solo equipo de Baugh Abogados |

Las dos se instalan como app en el celular (PWA) y abren sin internet una vez visitadas.

## Estructura

```
server.js                 servidor Express (rutas, sesión, contraseña, SSO de El Castillo)
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
| `SESSION_SECRET` | Cadena aleatoria de 32+ caracteres. Obligatoria: sin ella `/baugh/` queda cerrada. |
| `BAUGH_PASSWORD` | Contraseña del equipo. Si la dejas vacía, solo se entra desde El Castillo. |
| `CASTILLO_SSO_SECRET` | Secreto compartido con El Castillo (el mismo valor en ambos servicios). |
| `SESSION_HOURS` | Opcional. Horas que dura la sesión (12 por defecto). |

Para generar secretos: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. Settings → Networking → Generate Domain (o conecta un dominio propio).
5. Healthcheck: `/healthz`.

Para cambiar la contraseña del equipo basta con cambiar `BAUGH_PASSWORD` en Railway. Para cerrar todas las sesiones abiertas, cambia `SESSION_SECRET`.

## Entrada desde El Castillo (inicio de sesión único)

El Castillo genera un token firmado y redirige al usuario a:

```
https://<dominio-calculadora>/baugh/sso?token=<JWT>
```

Requisitos del token (JWT HS256 firmado con `CASTILLO_SSO_SECRET`):

| Campo | Valor |
|---|---|
| `iss` | `"el-castillo"` |
| `aud` | `"calculadora-baugh"` |
| `sub` | id del usuario en El Castillo |
| `name` | nombre del usuario (opcional) |
| `iat` / `exp` | vigencia máxima de 5 minutos |
| `jti` | id único del token (evita reutilizarlo) |

El Castillo solo debe emitir el token si el usuario tiene el permiso de la calculadora en su matriz de permisos.

Ejemplo para El Castillo en Node (sin dependencias):

```js
const crypto = require('crypto');

function enlaceCalculadoraBaugh(usuario) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    iss: 'el-castillo',
    aud: 'calculadora-baugh',
    sub: String(usuario.id),
    name: usuario.nombre,
    iat: now,
    exp: now + 120,
    jti: crypto.randomUUID(),
  });
  const firma = crypto.createHmac('sha256', process.env.CASTILLO_SSO_SECRET)
    .update(`${header}.${payload}`).digest('base64url');
  return `${process.env.CALCULADORA_URL}/baugh/sso?token=${header}.${payload}.${firma}`;
}

// Ruta en El Castillo, protegida por su propia sesión y permisos:
// app.get('/apps/calculadora', requireAuth, requirePermiso('calculadora'), (req, res) =>
//   res.redirect(enlaceCalculadoraBaugh(req.user)));
```

## Desarrollo local

```
npm install
SESSION_SECRET=$(node -e "console.log('x'.repeat(40))") BAUGH_PASSWORD=prueba npm start
```

Abre http://localhost:3000 (Donceles) y http://localhost:3000/baugh/ (Baugh).

## Notas

- La calculadora de Baugh queda guardada en el celular de quien ya inició sesión, para usarla sin internet. Al cerrar sesión se borra esa copia.
- Este repositorio es público: el código de ambas calculadoras se puede leer en GitHub. La contraseña protege la página publicada, no el código fuente.

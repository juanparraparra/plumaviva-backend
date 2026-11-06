# PlumaViva · API (capa 2) + base de datos (capa 3) + front (capa 1)

| Capa | Qué es | Dónde está |
|------|--------|-----------|
| 1 · Presentación | El front (HTML/JS), **ya conectado a la API** | `public/index.html` + `public/api-client.js` |
| 2 · Lógica / API | Node.js + Express: login, permisos por rol, reglas | `src/` |
| 3 · Datos | MySQL/MariaDB (XAMPP) | `database/schema.sql` |

## Puesta en marcha local

1. Abre **XAMPP** y pulsa **Start** en **MySQL**.
2. Abre una terminal **en la carpeta que contiene `package.json`** (si el zip creó una carpeta dentro de otra, entra a la interior).
3. Ejecuta:
   ```
   npm install
   npm run setup      ← crea .env, la base de datos, las tablas y los usuarios de demostración (no borra datos existentes)
   npm run dev        ← enciende el servidor
   ```
   En Windows también puedes hacer doble clic en **`iniciar.bat`**, que hace los tres pasos y abre el navegador.
4. Abre **<http://localhost:3000>** y entra con `admin@demo.co` / `Demo2026*`.

El servidor, al arrancar, imprime si llegó a la base de datos (`✔ Base de datos conectada`) o qué falta.

## Si no conecta o no deja iniciar sesión

Ejecuta **`npm run diagnostico`**: revisa Node, `.env`, dependencias, MySQL, tablas, usuarios y el ingreso de prueba, y te dice qué hacer.

| Qué ves | Causa probable | Solución |
|---|---|---|
| "No se pudo conectar con el servidor…" | El servidor no está encendido | `npm run dev` y abre `http://localhost:3000` |
| "No hay conexión con la base de datos…" | MySQL apagado, o faltan tablas | Start en MySQL (XAMPP) y `npm run setup` |
| "El servidor no respondió como API (HTTP 404)" | La página se abrió desde otro servidor | Abre `http://localhost:3000` |
| "Correo o contraseña incorrectos" | Usuario o clave mal escritos, o no hay datos | `npm run setup` y usa `admin@demo.co` / `Demo2026*` |
| `npm run setup` dice "versión anterior" | Tablas de la entrega pasada | `npm run setup -- --force` (borra los datos de prueba) |

El front detecta solo la dirección de la API: si lo abres con doble clic o desde otro puerto (Live Server), usa `http://localhost:3000/api`. Si cambiaste `PORT` en `.env`, indícalo en el navegador (consola F12): `localStorage.setItem('pv_api','http://localhost:PUERTO/api')`.

## Cómo se valida el ingreso y la sesión

- **Ingreso** (`src/routes/auth.js`, `POST /api/auth/login`): valida el formato de los datos, busca al usuario, revisa el bloqueo (5 fallos = 15 min), compara la clave con bcrypt, exige cuenta ACTIVA y **envía un código de 6 dígitos al correo** (Brevo/SMTP). El JWT de sesión solo se entrega después de `POST /api/auth/verificar-2fa`. Si la cuenta tiene una clave temporal, el login devuelve `requiere_cambio` y el cambio se hace en `POST /api/auth/cambiar-password-inicial` antes del 2FA. Si el correo no existe compara igual contra un hash de relleno y hay un límite de intentos por equipo (`LIMITE_LOGIN_IP`, 30 cada 15 min).
- **Sesión** (`src/middleware/auth.js`, `requiereSesion`): en **cada** petición verifica la firma y vigencia del token (solo HS256), que sea un token de sesión (no uno temporal de cambio/2FA) y vuelve a consultar la base de datos: si el usuario fue inactivado, eliminado o cambió su clave deja de entrar al instante, y el rol que se usa para los permisos es el actual, no el del momento del ingreso.
- **Permisos:** `requiereRol(...)` en cada ruta; el front solo oculta botones, quien decide es el servidor.
- **Correo:** `MAIL_DRIVER=smtp` usa Brevo (`smtp-relay.brevo.com:587`). En desarrollo se puede usar `MAIL_DRIVER=console`; en producción el servidor no arranca sin SMTP configurado. La clave temporal y el código 2FA se guardan hasheados, nunca en claro.

Para comprobarlo contra tu base de datos real, con el servidor encendido en otra terminal:
```
npm run probar-auth
```
Prueba clave correcta e incorrecta, correo inexistente, que el JWT no salga antes del 2FA, código incorrecto, rutas sin token, token manipulado, permisos por rol, correo obligatorio al crear usuarios, usuario inactivado con la sesión abierta y bloqueo por intentos. Con `MAIL_DRIVER=console` lee el código del buzón de desarrollo; con SMTP usa un JWT firmado para probar las rutas protegidas. También confirma que el `index.html` que sirve el servidor es el conectado a la API.

## Qué se guarda ahora en la base de datos

- Login real (5 intentos fallidos = bloqueo de 15 min), sesión que se mantiene al recargar y cierre de sesión.
- Usuarios: crear, editar, activar/inactivar. Los extras del front (tipo de documento, rol personalizado…) van en una columna JSON.
- Unidades productivas: crear, **editar** (con su historial de cambios), inhabilitar/rehabilitar, especies y galpones. El propietario nuevo creado desde el formulario de unidad se guarda justo antes de la unidad.
- Evaluaciones: programar, autoguardado, finalizar, validar (pasa al histórico), **anular**.
- Parametrización (pesos, importancia de indicadores), **roles personalizados**, notificaciones y control de cambios.
- Ids: el front usa ids provisionales (desde 100000) y los reemplaza por los del servidor al guardar.

### Usuarios nuevos y contraseñas
El servidor genera una **contraseña temporal única** y la envía al correo del usuario; al primer ingreso la plataforma exige cambiarla antes de pedir el código 2FA. El administrador no ve la clave. Para asignar una a mano o activar a alguien:
```
npm run user:password -- correo@ejemplo.co "ClaveNueva*2026" --activar
```
Configure el correo en `.env` (`MAIL_DRIVER=smtp`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`). Con Brevo el remitente debe estar verificado. En desarrollo puede usar `MAIL_DRIVER=console` para ver los correos en la terminal y en `.correos-dev.jsonl`.

## Qué falta o es distinto al prototipo

- **Consultor (CONS):** hoy no recibe datos, porque el prototipo le muestra información agregada y falta un endpoint que la calcule sin exponer granjas concretas.
- **Asistente IA y solicitudes de contacto** (`S.consultas`): siguen en memoria, no se guardan.
- **Verificación en dos pasos:** real por correo (código de 6 dígitos, 10 min, máximo 5 intentos y reenvío con espera). El modo demo conserva el 2FA simulado.
- **Notificaciones:** el personal interno ve todas; productores, tenedores y responsables técnicos solo las que ellos mismos generan.
- **Control de cambios:** el servidor pone usuario, rol y hora (no se pueden falsificar), pero el texto del detalle lo envía el front.
- **Evaluaciones de ejemplo** que el prototipo generaba en memoria ya no aparecen: ahora se programan y se llenan de verdad.
- **El puntaje** de una evaluación lo calcula el front y lo envía al validar. Para la normativa conviene moverlo al servidor más adelante.
- Esta versión se revisó con comprobación de sintaxis, pero no se ejecutó contra una base real: si algo falla al probarla, copia el mensaje de la consola del navegador (F12) o de la terminal.

## Despliegue

- Un solo servicio Node sirve el front y la API desde el mismo dominio.
- Necesitas MySQL/MariaDB en la nube; carga allí `schema.sql` (y el seed solo si quieres datos de demostración).
- Variables de entorno: las del `.env` (`DB_*`, `JWT_SECRET`, `PORT`, `MAIL_*`). Use HTTPS, un usuario de BD propio (no `root`) y borre los usuarios de demostración. `MAIL_FROM` debe ser un remitente verificado en Brevo.
# plumaviva-backend

// Revisa paso a paso por qué podría no conectar o no iniciar sesión.  Uso:  npm run diagnostico
const fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..');
let fallos = 0;
const ok = m => console.log('  ✔ ' + m);
const mal = (m, ayuda) => { fallos++; console.log('  ✘ ' + m); if (ayuda) console.log('      → ' + ayuda); };
const aviso = m => console.log('  • ' + m);

(async () => {
  console.log('\nDiagnóstico de PlumaViva\n');
  Number(process.versions.node.split('.')[0]) >= 18 ? ok(`Node ${process.versions.node}`) : mal(`Node ${process.versions.node} es muy antiguo`, 'Instale Node 18 o superior (nodejs.org).');

  const envPath = path.join(raiz, '.env');
  if (fs.existsSync(envPath)) ok('Archivo .env encontrado'); else mal('No existe el archivo .env', 'Ejecute: npm run setup');
  require('dotenv').config({ path: envPath });
  if (!process.env.JWT_SECRET || /cambia-esto/.test(process.env.JWT_SECRET)) mal('JWT_SECRET vacío o de ejemplo', 'Ejecute: npm run setup'); else ok('JWT_SECRET definido');

  const faltan = ['express', 'mysql2', 'bcryptjs', 'jsonwebtoken', 'cors', 'helmet', 'dotenv', 'nodemailer'].filter(d => { try { require.resolve(d); return false; } catch { return true; } });
  if (faltan.length) { mal('Faltan dependencias: ' + faltan.join(', '), 'Ejecute: npm install   (dentro de la carpeta que contiene package.json)'); return fin(); }
  ok('Dependencias instaladas');

  const mysql = require('mysql2/promise'), bcrypt = require('bcryptjs');
  const nombre = process.env.DB_NAME || 'plumaviva';
  let conn;
  try {
    conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
    ok('Conexión a MySQL');
  } catch (e) {
    mal('No conecta a MySQL (' + (e.code || e.message) + ')', { ECONNREFUSED: 'Encienda MySQL en XAMPP (Start).', ER_ACCESS_DENIED_ERROR: 'Revise DB_USER y DB_PASSWORD en .env.' }[e.code] || 'Revise DB_HOST y DB_PORT en .env.');
    return fin();
  }
  const [bd] = await conn.query('SHOW DATABASES LIKE ?', [nombre]);
  if (!bd.length) { mal(`La base "${nombre}" no existe`, 'Ejecute: npm run setup'); await conn.end(); return fin(); }
  ok(`Base "${nombre}" existe`);

  const [tb] = await conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [nombre]);
  const tablas = tb.map(x => x.t.toLowerCase());
  const esperadas = ['usuarios', 'unidades', 'unidad_especies', 'galpones', 'evaluaciones', 'historico', 'auditoria', 'parametros', 'notificaciones', 'recuperacion', 'codigos_2fa'];
  const sinTabla = esperadas.filter(t => !tablas.includes(t));
  if (sinTabla.length) { mal('Faltan tablas: ' + sinTabla.join(', '), 'Ejecute: npm run setup -- --force   (recrea las tablas; borra los datos de prueba)'); await conn.end(); return fin(); }
  ok('Tablas completas (' + esperadas.length + ')');
  const [c] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'usuarios' AND column_name = 'extra'", [nombre]);
  if (!c[0].n) { mal('Las tablas son de una versión anterior', 'Ejecute: npm run setup -- --force'); await conn.end(); return fin(); }
  const [cols] = await conn.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = 'usuarios'", [nombre]);
  const nombresCols = cols.map(x => x.c);
  const faltanCols = ['debe_cambiar_password', 'sesion_version'].filter(x => !nombresCols.includes(x));
  if (faltanCols.length) aviso('El servidor agregará al arrancar las columnas: ' + faltanCols.join(', '));
  else ok('Columnas de seguridad de acceso presentes');

  // Configuración de correo (Brevo/SMTP o consola en desarrollo)
  const driver = String(process.env.MAIL_DRIVER || 'console').toLowerCase();
  if (driver === 'console') aviso('MAIL_DRIVER=console: los correos se imprimen en consola (solo desarrollo)');
  else if (driver === 'smtp') {
    const faltanMail = ['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS', 'MAIL_FROM'].filter(k => !process.env[k]);
    if (faltanMail.length) mal('Correo SMTP incompleto: faltan ' + faltanMail.join(', '), 'Complete las variables MAIL_* en .env');
    else ok('Correo SMTP configurado (' + process.env.MAIL_HOST + ')');
  } else mal('MAIL_DRIVER inválido: ' + driver, 'Use MAIL_DRIVER=smtp o MAIL_DRIVER=console');

  await conn.query('USE `' + nombre + '`');
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM usuarios');
  if (!n) mal('No hay usuarios', 'Ejecute: npm run db:seed'); else ok(`${n} usuarios registrados`);
  const [[adm]] = await conn.query("SELECT estado, password_hash FROM usuarios WHERE correo = 'admin@demo.co'");
  if (adm) {
    (await bcrypt.compare('Demo2026*', adm.password_hash)) ? ok('admin@demo.co / Demo2026* coincide con la base') : aviso('admin@demo.co existe, pero su contraseña no es Demo2026* (¿se cambió?)');
    if (adm.estado !== 'ACTIVO') mal('admin@demo.co no está ACTIVO', 'npm run user:password -- admin@demo.co "ClaveNueva*2026" --activar');
  } else aviso('No existe admin@demo.co (use un usuario que sí exista)');
  await conn.end();

  // ¿El servidor está encendido y responde como API?
  const puerto = process.env.PORT || 3000, url = `http://localhost:${puerto}`;
  try {
    const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(2500) });
    const j = await r.json().catch(() => null);
    if (!j) mal(`El puerto ${puerto} responde, pero no es esta API`, 'Cierre el otro programa que usa ese puerto o cambie PORT en .env');
    else if (j.ok) {
      ok(`Servidor encendido en ${url} y conectado a la base`);
      // Se prueba con una clave incorrecta para no generar un código 2FA ni enviar correos.
      const l = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correo: 'admin@demo.co', password: 'diagnostico-no-es-clave' }) });
      const lj = await l.json().catch(() => ({}));
      if (l.status === 401) ok('El ingreso responde y valida las credenciales');
      else if (l.status === 429) aviso('El ingreso responde, pero el límite por IP está activo (espere unos minutos)');
      else aviso('Ingreso de prueba: ' + (lj.error || 'HTTP ' + l.status));
    } else mal('El servidor responde pero no llega a la base: ' + (j.detalle || ''), 'Revise lo anterior y reinicie el servidor.');
  } catch { aviso(`El servidor no está encendido en ${url} (normal si aún no lo inicia: npm run dev)`); }
  fin();
})().catch(e => { console.error('Error en el diagnóstico:', e.message); process.exit(1); });

function fin() {
  console.log(fallos ? `\n${fallos} problema(s) por resolver (siga las flechas →).\n` : '\nTodo en orden. Abra http://localhost:' + (process.env.PORT || 3000) + '\n');
  process.exit(fallos ? 1 : 0);
}

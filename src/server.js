require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');
const { requiereSesion } = require('./middleware/auth');
// const { validarConfiguracion } = require('./mail'); // correo desactivado temporalmente

const produccion = process.env.NODE_ENV === 'production';
if (!process.env.JWT_SECRET) {
  if (produccion) { console.error('Falta JWT_SECRET en las variables de entorno.'); process.exit(1); }
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠ No hay JWT_SECRET en .env: se usa uno temporal (las sesiones se cierran al reiniciar). Ejecute "npm run setup" para crearlo.');
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));   // el front usa scripts/estilos en línea
app.use(express.json({ limit: '25mb' }));            // las evaluaciones con respuestas y evidencias pueden ser grandes

// CORS: en desarrollo se aceptan localhost/127.0.0.1 en cualquier puerto (Live Server, etc.) y file://; en producción solo CORS_ORIGINS
const permitidos = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const esLocal = o => o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || permitidos.includes(origin) || (!produccion && esLocal(origin))) }));

// ---------- Capa 2: API ----------
app.get('/api/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, db: 'conectada' }); }
  catch (e) { res.status(503).json({ ok: false, db: 'sin conexión', detalle: e.code || e.message }); }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', requiereSesion, require('./routes/usuarios'));
app.use('/api/unidades', requiereSesion, require('./routes/unidades'));
app.use('/api/evaluaciones', requiereSesion, require('./routes/evaluaciones'));
app.use('/api', requiereSesion, require('./routes/otros'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ---------- Capa 1: front Angular compilado (si existe) y front de referencia ----------
const distAngular = path.join(__dirname, '..', '..', 'PlumaViva_Angular_Final', 'plumaviva', 'dist', 'plumaviva', 'browser');
if (fs.existsSync(path.join(distAngular, 'index.html'))) {
  app.use(express.static(distAngular));
  console.log('✔ Front Angular encontrado en dist: se sirve en el mismo origen.');
}
app.use(express.static(path.join(__dirname, '..', 'public')));

// Errores: los de base de datos se explican; no se filtran detalles internos
const ERRORES_BD = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_ACCESS_DENIED_ERROR', 'PROTOCOL_CONNECTION_LOST'];
app.use((err, _req, res, _next) => {
  console.error(err);
  if (ERRORES_BD.includes(err.code))
    return res.status(503).json({ error: 'No hay conexión con la base de datos. Verifique que MySQL esté encendido (XAMPP) y ejecute "npm run setup".' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Los datos enviados son demasiado grandes' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Migraciones idempotentes para bases creadas con versiones anteriores.
async function prepararBase() {
  const migraciones = [
    [`CREATE TABLE IF NOT EXISTS recuperacion (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expira DATETIME NOT NULL,
      usado TINYINT(1) NOT NULL DEFAULT 0,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (token_hash),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`, 'tabla recuperacion'],
    [`CREATE TABLE IF NOT EXISTS codigos_2fa (
      id CHAR(36) PRIMARY KEY,
      usuario_id INT NOT NULL,
      codigo_hash CHAR(64) NOT NULL,
      expira DATETIME NOT NULL,
      usado TINYINT(1) NOT NULL DEFAULT 0,
      intentos TINYINT NOT NULL DEFAULT 0,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (usuario_id, usado, expira),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`, 'tabla codigos_2fa'],
    ['ALTER TABLE usuarios ADD COLUMN debe_cambiar_password TINYINT(1) NOT NULL DEFAULT 0', 'columna debe_cambiar_password'],
    ['ALTER TABLE usuarios ADD COLUMN sesion_version INT NOT NULL DEFAULT 0', 'columna sesion_version']
  ];
  for (const [sql, nombre] of migraciones) {
    try { await db.query(sql); }
    catch (e) {
      // Las columnas ya existentes producen ER_DUP_FIELDNAME; no es un error de arranque.
      if (e.code !== 'ER_DUP_FIELDNAME') console.error(`No se pudo preparar ${nombre}:`, e.message);
    }
  }
  // Columnas del histórico que guardan el detalle por indicador (bases creadas con una versión anterior).
  for (const [col, def] of [['cap', 'CHAR(2)'], ['sis', 'VARCHAR(20)'], ['det', 'LONGTEXT']]) {
    try { await db.query(`ALTER TABLE historico ADD COLUMN ${col} ${def}`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(`No se pudo preparar histórico.${col}:`, e.message); }
  }
}

// try { validarConfiguracion(); } // correo desactivado temporalmente
// catch (e) {
//   if (produccion) { console.error('✘ Correo:', e.message); process.exit(1); }
//   console.warn('⚠ Correo:', e.message);
// }

const PORT = Number(process.env.PORT || 3000);
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

prepararBase().then(() => {
  const servidor = app.listen(PORT, async () => {
    console.log(`PlumaViva escuchando en http://localhost:${PORT}`);
    try {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM usuarios');
      console.log(`✔ Base de datos conectada (${n} usuarios).`);
      if (!n) console.warn('⚠ No hay usuarios: ejecute "npm run db:seed" para cargar los de demostración.');
    } catch (e) {
      const ayuda = { ECONNREFUSED: 'MySQL no está encendido: ábralo en XAMPP (botón Start de MySQL).',
        ER_ACCESS_DENIED_ERROR: 'Usuario o contraseña de MySQL incorrectos: revise DB_USER y DB_PASSWORD en .env.',
        ER_BAD_DB_ERROR: 'La base de datos no existe: ejecute "npm run setup".',
        ER_NO_SUCH_TABLE: 'Faltan las tablas: ejecute "npm run setup".' }[e.code] || e.message;
      console.error(`✘ Base de datos: ${ayuda}`);
      console.error('  El servidor sigue encendido, pero el ingreso no funcionará hasta resolverlo. Más ayuda: npm run diagnostico');
    }
  });
  servidor.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`El puerto ${PORT} ya está en uso: cierre el otro servidor o cambie PORT en .env`);
    else console.error(e);
    process.exit(1);
  });
}).catch(e => {
  console.error('No se pudo preparar la base de datos:', e.message);
  process.exit(1);
});

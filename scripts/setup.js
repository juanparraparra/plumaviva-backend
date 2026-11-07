// Prepara todo para arrancar: crea .env, la base de datos, las tablas y los datos de demostración.
// Uso:  npm run setup            (seguro: si la base ya tiene datos, no los toca)
//       npm run setup -- --force (recrea las tablas desde cero: BORRA los datos)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const raiz = path.join(__dirname, '..');

// 1. .env
const envPath = path.join(raiz, '.env');
if (!fs.existsSync(envPath)) {
  let t = fs.readFileSync(path.join(raiz, '.env.example'), 'utf8');
  t = t.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(envPath, t);
  console.log('✔ Archivo .env creado (con un JWT_SECRET aleatorio).');
} else if (/^JWT_SECRET=(cambia-esto.*)?\s*$/m.test(fs.readFileSync(envPath, 'utf8'))) {
  const t = fs.readFileSync(envPath, 'utf8').replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(envPath, t);
  console.log('✔ JWT_SECRET de .env era el de ejemplo: se generó uno aleatorio.');
} else console.log('✔ Archivo .env encontrado.');

require('dotenv').config({ path: envPath });
const mysql = require('mysql2/promise');
const force = process.argv.includes('--force');
const nombre = process.env.DB_NAME || 'plumaviva';
if (!/^[A-Za-z0-9_]+$/.test(nombre)) { console.error('✘ DB_NAME solo puede tener letras, números y guion bajo.'); process.exit(1); }

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true, charset: 'utf8mb4'
    });
  } catch (e) {
    const ayuda = { ECONNREFUSED: 'MySQL no está encendido. Abra XAMPP y pulse Start en MySQL.',
      ER_ACCESS_DENIED_ERROR: 'Usuario o contraseña de MySQL incorrectos. Revise DB_USER y DB_PASSWORD en .env (en XAMPP: root y sin contraseña).' }[e.code] || e.message;
    console.error('✘ No se pudo conectar a MySQL: ' + ayuda); process.exit(1);
  }
  console.log(`✔ Conectado a MySQL (${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}).`);

  const [ex] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [nombre, 'usuarios']);
  const [col] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'usuarios' AND column_name = 'extra'", [nombre]);
  if (ex[0].n && !force) {
    if (!col[0].n) { console.error('✘ La base existe pero es de una versión anterior (le faltan columnas). Ejecute: npm run setup -- --force   (recrea las tablas y borra los datos de prueba)'); process.exit(1); }
    console.log('✔ La base de datos ya tiene tablas: no se modifican (use --force para recrearlas).');
  } else {
    let sql = fs.readFileSync(path.join(raiz, 'database', 'schema.sql'), 'utf8')
      .replace('CREATE DATABASE IF NOT EXISTS plumaviva', `CREATE DATABASE IF NOT EXISTS \`${nombre}\``).replace('USE plumaviva;', `USE \`${nombre}\`;`);
    await conn.query(sql);
    console.log(`✔ Base de datos "${nombre}" y tablas creadas.`);
  }
  await conn.end();

  // 3. Datos de demostración (el propio seed.js no repite si ya hay usuarios)
  execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit', cwd: raiz });
  console.log('\nListo. Inicie el servidor con:  npm run dev   y abra http://localhost:' + (process.env.PORT || 3000));
  process.exit(0);
})().catch(e => { console.error('✘ Error:', e.message); process.exit(1); });

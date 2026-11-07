// Deja la base lista para producción tras "npm run setup":
//  - fija la contraseña real del administrador
//  - reemplaza la contraseña de demostración (Demo2026*) de TODOS los demás usuarios por una aleatoria
//    (después se les asigna la clave real con:  npm run user:password -- correo "ClaveNueva*2026")
// Uso:  node scripts/asegurar-produccion.js admin@correo.com "ClaveSegura*2026"
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

(async () => {
  const [correo, clave] = process.argv.slice(2);
  if (!correo || !clave) { console.log('Uso: node scripts/asegurar-produccion.js correo-admin "ClaveSegura*2026"'); process.exit(1); }
  if (clave.length < 10) { console.log('La contraseña debe tener al menos 10 caracteres.'); process.exit(1); }
  const [[admin]] = await db.query('SELECT id, rol FROM usuarios WHERE correo = ?', [correo.toLowerCase()]);
  if (!admin) { console.log('No existe un usuario con ese correo. Correos disponibles:'); const [l] = await db.query('SELECT correo, rol FROM usuarios'); l.forEach(u => console.log('  ' + u.correo + '  (' + u.rol + ')')); process.exit(1); }
  if (admin.rol !== 'ADMIN') { console.log('Ese usuario no es ADMIN.'); process.exit(1); }
  const [otros] = await db.query('SELECT id FROM usuarios WHERE id <> ?', [admin.id]);
  for (const u of otros)
    await db.query('UPDATE usuarios SET password_hash = ?, sesion_version = sesion_version + 1 WHERE id = ?', [await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), u.id]);
  await db.query(
    `UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0, sesion_version = sesion_version + 1,
       intentos_fallidos = 0, bloqueado_hasta = NULL, estado = 'ACTIVO' WHERE id = ?`, [await bcrypt.hash(clave, 10), admin.id]);
  console.log(`Listo: ${correo} tiene su contraseña nueva y ${otros.length} usuarios de demostración quedaron con contraseña aleatoria.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

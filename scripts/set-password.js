// Asigna una contraseña a un usuario y lo activa. Útil para usuarios creados desde el front sin contraseña.
// Uso:  node scripts/set-password.js correo@ejemplo.co "NuevaClave*2026" [--activar]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

(async () => {
  const [correo, clave, ...flags] = process.argv.slice(2);
  if (!correo || !clave) { console.log('Uso: node scripts/set-password.js correo "clave" [--activar]'); process.exit(1); }
  if (clave.length < 10) { console.log('La contraseña debe tener al menos 10 caracteres.'); process.exit(1); }
  const [r] = await db.query(
    `UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0, sesion_version = sesion_version + 1,
       intentos_fallidos = 0, bloqueado_hasta = NULL${flags.includes('--activar') ? ", estado = 'ACTIVO'" : ''} WHERE correo = ?`,
    [await bcrypt.hash(clave, 10), correo.toLowerCase()]);
  console.log(r.affectedRows ? 'Contraseña actualizada.' : 'No existe un usuario con ese correo.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

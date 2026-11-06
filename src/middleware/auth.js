const jwt = require('jsonwebtoken');
const db = require('../db');

/**
 * Firma un token de SESIÓN. Solo estos tokens sirven para las rutas protegidas.
 * `v` permite invalidar sesiones anteriores cuando se cambia la contraseña.
 */
function firmar(usuario) {
  return jwt.sign(
    { id: usuario.id, purpose: 'session', v: Number(usuario.sesion_version) || 0 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES || '8h' }
  );
}

/** Token temporal para un paso concreto (por ejemplo, cambio obligatorio de contraseña). */
function firmarProposito(usuario, purpose, expiresIn = '10m') {
  return jwt.sign(
    { id: usuario.id, purpose, v: Number(usuario.sesion_version) || 0 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn }
  );
}

/** Verifica un token temporal y que su propósito sea el esperado. */
function verificarProposito(token, purpose) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.purpose !== purpose) throw new Error('Token con propósito inválido');
  return payload;
}

// Valida la sesión en CADA petición:
//   1) el token debe venir en "Authorization: Bearer <token>", estar firmado por este servidor (HS256) y no estar vencido;
//   2) debe ser un token de sesión (no un token temporal de cambio/2FA);
//   3) el usuario debe seguir existiendo y estar ACTIVO en la base de datos;
//   4) la versión de sesión debe coincidir (cambiar la contraseña cierra las sesiones anteriores);
//   5) el rol que se usa para los permisos es el actual de la base, no el que tenía cuando inició sesión.
async function requiereSesion(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Sesión requerida' });

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { return res.status(401).json({ error: 'Sesión vencida o inválida' }); }

  if (payload.purpose !== 'session')
    return res.status(401).json({ error: 'Token no válido para una sesión' });

  try {
    const [[u]] = await db.query(
      'SELECT id, nombres, apellidos, rol, estado, sesion_version FROM usuarios WHERE id = ?',
      [payload.id]);
    if (!u || u.estado !== 'ACTIVO')
      return res.status(401).json({ error: 'La cuenta ya no está activa. Inicie sesión de nuevo.' });
    if (Number(payload.v || 0) !== Number(u.sesion_version || 0))
      return res.status(401).json({ error: 'La sesión fue invalidada. Inicie sesión de nuevo.' });

    req.usuario = { id: u.id, rol: u.rol, nombre: `${u.nombres} ${u.apellidos}` };
    next();
  } catch (e) { next(e); }
}

// Exige que el rol del usuario esté en la lista
const requiereRol = (...roles) => (req, res, next) =>
  roles.includes(req.usuario.rol) ? next() : res.status(403).json({ error: 'Sin permiso para esta acción' });

module.exports = { firmar, firmarProposito, verificarProposito, requiereSesion, requiereRol };

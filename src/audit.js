const db = require('./db');

// Registra un cambio en la tabla de auditoría (equivale a audit() del front)
async function auditar(req, accion, objeto, { modulo = 'Sistema', detalle = [], motivo = '' } = {}) {
  const u = req.usuario || {};
  await db.query(
    'INSERT INTO auditoria (usuario_id, rol, usuario, accion, objeto, modulo, detalle, motivo) VALUES (?,?,?,?,?,?,?,?)',
    [u.id || null, u.rol || '', u.nombre || 'Sistema', accion, objeto, modulo, JSON.stringify(detalle), motivo]
  );
}

module.exports = { auditar };

const router = require('express').Router();
const db = require('../db');
const { requiereRol } = require('../middleware/auth');
const { unjson } = require('../util');

// ---- Parametrización (pesos, niveles, muestreo, importancia por indicador, roles personalizados) ----
const PARAMS_EDITABLES = ['pesos', 'niveles', 'muestreo', 'tabla3', 'imp', 'obligatoriedad', 'reincidencia'];

router.get('/parametros', async (_req, res, next) => {
  try {
    const [rows] = await db.query('SELECT clave, valor FROM parametros');
    res.json(Object.fromEntries(rows.map(r => [r.clave, unjson(r.valor, null)])));
  } catch (e) { next(e); }
});

router.put('/parametros/:clave', async (req, res, next) => {
  try {
    const { clave } = req.params, rol = req.usuario.rol;
    const permitido = clave === 'roles' ? rol === 'ADMIN' : (PARAMS_EDITABLES.includes(clave) && ['ADMIN', 'COORD'].includes(rol));
    if (!permitido) return res.status(403).json({ error: 'Sin permiso para modificar este parámetro' });
    if (req.body.valor === undefined) return res.status(400).json({ error: 'Falta el valor' });
    await db.query('INSERT INTO parametros (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      [clave, JSON.stringify(req.body.valor)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Roles personalizados y matriz de permisos (se guarda en parametros.roles) ----
router.get('/roles', async (_req, res, next) => {
  try {
    const [[fila]] = await db.query("SELECT valor FROM parametros WHERE clave = 'roles'");
    const datos = fila ? unjson(fila.valor, {}) : {};
    res.json({ roles: Array.isArray(datos.roles) ? datos.roles : [], perm: datos.perm || {}, siguiente: Number(datos.siguiente) || 0 });
  } catch (e) { next(e); }
});

router.put('/roles', requiereRol('ADMIN'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.roles) || typeof b.perm !== 'object' || b.perm === null)
      return res.status(400).json({ error: 'Datos de roles inválidos' });
    const valor = { roles: b.roles, perm: b.perm, siguiente: Number(b.siguiente) || 0 };
    await db.query('INSERT INTO parametros (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      ['roles', JSON.stringify(valor)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Histórico de evaluaciones cerradas ----
router.get('/historico', requiereRol('ADMIN', 'COORD', 'INSP', 'PROD', 'TEN', 'RT'), async (req, res, next) => {
  try {
    const args = []; const cond = [];
    if (req.query.unidad) { cond.push('h.unidad_id = ?'); args.push(req.query.unidad); }
    if (req.usuario.rol === 'PROD' || req.usuario.rol === 'TEN') { cond.push('un.propietario_id = ?'); args.push(req.usuario.id); }
    if (req.usuario.rol === 'RT') { cond.push('un.rt_id = ?'); args.push(req.usuario.id); }
    const [rows] = await db.query(
      `SELECT h.* FROM historico h JOIN unidades un ON un.id = h.unidad_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY h.fecha`, args);
    res.json(rows.map(r => ({ codigo: r.codigo, unidad: r.unidad_id, fecha: r.fecha, total: Number(r.total),
      cap: r.cap || null, sis: r.sis || null, det: unjson(r.det, null),
      g: { MBR: Number(r.g_mbr), MBA: Number(r.g_mba), MBG: Number(r.g_mbg) } })));
  } catch (e) { next(e); }
});

// ---- Notificaciones ----
// Personal interno ve todas; los demás solo las que generaron ellos mismos (evita mostrar datos de otras granjas)
router.get('/notificaciones', async (req, res, next) => {
  try {
    const interno = ['ADMIN', 'COORD', 'INSP'].includes(req.usuario.rol);
    const [rows] = await db.query(
      `SELECT t, d FROM notificaciones ${interno ? '' : 'WHERE usuario_id = ?'} ORDER BY id DESC LIMIT 50`, interno ? [] : [req.usuario.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/notificaciones', async (req, res, next) => {
  try {
    const b = req.body, t = String(b.t || '').slice(0, 400), d = String(b.d || '').slice(0, 10);
    if (!t) return res.status(400).json({ error: 'Falta el texto' });
    // El personal interno puede dirigir la notificación a otro usuario (por ejemplo, al inspector asignado).
    const puedeDirigir = ['ADMIN', 'COORD', 'INSP'].includes(req.usuario.rol) && b.usuario_id;
    const destino = puedeDirigir ? Number(b.usuario_id) : req.usuario.id;
    await db.query('INSERT INTO notificaciones (usuario_id, t, d) VALUES (?,?,?)', [destino || req.usuario.id, t, d]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Control de cambios ----
// Lectura: solo administrador. Escritura: cualquier sesión; el servidor pone usuario, rol y hora (no se pueden falsificar).
router.get('/auditoria', requiereRol('ADMIN'), async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 300, 1000);
    const [rows] = await db.query('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?', [limite]);
    res.json(rows.map(r => ({ ...r, detalle: unjson(r.detalle, []) })));
  } catch (e) { next(e); }
});

router.post('/auditoria', async (req, res, next) => {
  try {
    const b = req.body, u = req.usuario;
    if (!b.accion || !b.objeto) return res.status(400).json({ error: 'Faltan acción y objeto' });
    await db.query(
      'INSERT INTO auditoria (usuario_id, rol, usuario, accion, objeto, modulo, detalle, motivo) VALUES (?,?,?,?,?,?,?,?)',
      [u.id, u.rol, u.nombre, String(b.accion).slice(0, 60), String(b.objeto).slice(0, 255), String(b.modulo || 'Sistema').slice(0, 60),
       JSON.stringify(Array.isArray(b.detalle) ? b.detalle : []), String(b.motivo || '').slice(0, 255)]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

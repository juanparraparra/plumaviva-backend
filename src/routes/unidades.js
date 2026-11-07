const router = require('express').Router();
const db = require('../db');
const { requiereRol } = require('../middleware/auth');
const { auditar } = require('../audit');
const { n, nn, txt, json, unjson } = require('../util');

const EDITORES = ['ADMIN', 'COORD', 'INSP', 'PROD'];   // quienes pueden registrar/editar unidades (igual que el front)

// ¿Qué unidades ve cada rol? PROD/TEN las suyas, RT las vinculadas, el consultor ninguna (solo datos agregados, pendiente)
function filtroPorRol(u) {
  if (u.rol === 'PROD' || u.rol === 'TEN') return { sql: 'WHERE un.propietario_id = ?', args: [u.id] };
  if (u.rol === 'RT') return { sql: 'WHERE un.rt_id = ?', args: [u.id] };
  if (u.rol === 'CONS') return { sql: 'WHERE 1 = 0', args: [] };
  return { sql: '', args: [] };
}

async function cargarHijos(unidades) {
  if (!unidades.length) return unidades;
  const ids = unidades.map(x => x.id);
  const [esp] = await db.query('SELECT * FROM unidad_especies WHERE unidad_id IN (?)', [ids]);
  const [gal] = await db.query('SELECT * FROM galpones WHERE unidad_id IN (?) ORDER BY id', [ids]);
  return unidades.map(x => ({
    ...x,
    extra: unjson(x.extra),
    especies: esp.filter(e => e.unidad_id === x.id).map(e => ({ sis: e.sis, pastoreo: !!e.pastoreo })),
    galpones: gal.filter(g => g.unidad_id === x.id).map(({ id, unidad_id, extra, ...g }) => ({ ...g, extra: unjson(extra) }))
  }));
}

async function guardarHijos(conn, id, b) {
  await conn.query('DELETE FROM unidad_especies WHERE unidad_id = ?', [id]);
  await conn.query('DELETE FROM galpones WHERE unidad_id = ?', [id]);
  for (const e of b.especies || [])
    await conn.query('INSERT INTO unidad_especies (unidad_id, sis, pastoreo) VALUES (?,?,?)', [id, e.sis, e.pastoreo ? 1 : 0]);
  for (const g of b.galpones || [])
    await conn.query(
      `INSERT INTO galpones (unidad_id, cod, tipo, area, beb, com, ref_b, ref_c, ext, patio, aves, edad, edad_unidad, grupo, extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, g.cod || '', g.tipo || '', n(g.area), n(g.beb), n(g.com), n(g.refB), n(g.refC), n(g.ext), n(g.patio),
       n(g.aves), n(g.edad), g.unidad === 'semanas' ? 'semanas' : 'días', txt(g.grupo), json(g.extra)]);
}

// Orden: nombre, codigo, operario, rt_id, capacidad, gab, gab_vence, depto, mun, vereda, dir, indic, coord_sis, lat, lon, extra
const columnas = b => [b.nombre, b.codigo || 'Por definir', txt(b.operario), b.rt_id || null, n(b.capacidad),
  b.gab ? 1 : 0, txt(b.gab_vence), txt(b.depto), txt(b.mun), txt(b.vereda), txt(b.dir), txt(b.indic),
  b.coord_sis === 'POLAR' ? 'POLAR' : 'GEO', nn(b.lat), nn(b.lon), json(b.extra)];

router.get('/', async (req, res, next) => {
  try {
    const f = filtroPorRol(req.usuario);
    const [rows] = await db.query(`SELECT un.* FROM unidades un ${f.sql} ORDER BY un.id`, f.args);
    res.json(await cargarHijos(rows));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const f = filtroPorRol(req.usuario);
    const where = f.sql ? `${f.sql} AND un.id = ?` : 'WHERE un.id = ?';
    const [rows] = await db.query(`SELECT un.* FROM unidades un ${where}`, [...f.args, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Unidad no encontrada' });
    res.json((await cargarHijos(rows))[0]);
  } catch (e) { next(e); }
});

router.post('/', requiereRol(...EDITORES), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const b = req.body;
    if (!b.nombre) return res.status(400).json({ error: 'El nombre de la unidad es obligatorio' });
    const propietario = req.usuario.rol === 'PROD' ? req.usuario.id : b.propietario_id;   // PROD solo a su nombre
    if (!propietario) return res.status(400).json({ error: 'Falta el propietario' });

    const c = columnas(b);
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO unidades (nombre, codigo, propietario_id, operario, rt_id, capacidad, gab, gab_vence, depto, mun, vereda, dir, indic, coord_sis, lat, lon, extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c[0], c[1], propietario, ...c.slice(2)]);
    await guardarHijos(conn, r.insertId, b);
    await conn.commit();
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'El propietario o el responsable técnico no existe' });
    next(e);
  } finally { conn.release(); }
});

// Editar toda la unidad (datos, especies, galpones, historial). Solo ADMIN cambia el estado (inhabilitar/rehabilitar).
router.put('/:id', requiereRol(...EDITORES), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const [[u]] = await conn.query('SELECT * FROM unidades WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Unidad no encontrada' });
    const esAdmin = req.usuario.rol === 'ADMIN', b = req.body;
    if (req.usuario.rol === 'PROD' && u.propietario_id !== req.usuario.id) return res.status(403).json({ error: 'Esta unidad no es suya' });
    if (u.estado === 'INACTIVA' && !esAdmin) return res.status(409).json({ error: 'La unidad está inhabilitada: un administrador debe rehabilitarla' });

    const propietario = req.usuario.rol === 'PROD' ? u.propietario_id : (b.propietario_id || u.propietario_id);
    const estado = esAdmin && ['ACTIVA', 'INACTIVA'].includes(b.estado) ? b.estado : u.estado;
    const c = columnas(b);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE unidades SET nombre=?, codigo=?, propietario_id=?, operario=?, rt_id=?, capacidad=?, gab=?, gab_vence=?, depto=?, mun=?,
         vereda=?, dir=?, indic=?, coord_sis=?, lat=?, lon=?, extra=?, estado=? WHERE id=?`,
      [b.nombre || u.nombre, c[1], propietario, ...c.slice(2), estado, u.id]);
    if (Array.isArray(b.galpones) || Array.isArray(b.especies)) await guardarHijos(conn, u.id, b);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'El propietario o el responsable técnico no existe' });
    next(e);
  } finally { conn.release(); }
});

// Eliminar un registro duplicado: solo ADMIN y solo si no tiene historial.
router.delete('/:id', requiereRol('ADMIN'), async (req, res, next) => {
  try {
    const [[u]] = await db.query('SELECT * FROM unidades WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Unidad no encontrada' });
    const [[h]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM evaluaciones WHERE unidad_id = ?) +
         (SELECT COUNT(*) FROM historico WHERE unidad_id = ?) AS n`,
      [u.id, u.id]);
    if (h.n > 0) return res.status(409).json({ error: 'La unidad tiene historial (evaluaciones o resultados). Inhabilítela en lugar de eliminarla.' });

    await db.query('DELETE FROM unidades WHERE id = ?', [u.id]);
    await auditar(req, 'Eliminó', 'Unidad productiva ' + u.nombre, { modulo: 'Unidades productivas', motivo: 'Registro duplicado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

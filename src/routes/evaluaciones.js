const router = require('express').Router();
const db = require('../db');
const { requiereRol } = require('../middleware/auth');
const { json, unjson } = require('../util');

const parse = ({ detalle, ...e }) => ({ ...e, detalle: unjson(detalle) });
const EDITABLES = ['BORRADOR', 'EN_PROCESO'];
const ABIERTAS = ['BORRADOR', 'EN_PROCESO', 'FINALIZADA'];

// Visibilidad por rol: INSP las suyas, PROD/TEN las de sus unidades, RT las de sus unidades vinculadas.
// El consultor no ve evaluaciones individuales (solo datos agregados, pendiente).
function filtro(u) {
  switch (u.rol) {
    case 'INSP': return { sql: 'WHERE ev.insp_id = ?', args: [u.id] };
    case 'PROD':
    case 'TEN':  return { sql: 'WHERE un.propietario_id = ?', args: [u.id] };
    case 'RT':   return { sql: 'WHERE un.rt_id = ?', args: [u.id] };
    case 'CONS': return { sql: 'WHERE 1 = 0', args: [] };
    default:     return { sql: '', args: [] };
  }
}

router.get('/', async (req, res, next) => {
  try {
    const f = filtro(req.usuario);
    const [rows] = await db.query(
      `SELECT ev.*, un.nombre AS unidad_nombre FROM evaluaciones ev
       JOIN unidades un ON un.id = ev.unidad_id ${f.sql} ORDER BY ev.id DESC`, f.args);
    res.json(rows.map(parse));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const f = filtro(req.usuario);
    const where = f.sql ? `${f.sql} AND ev.id = ?` : 'WHERE ev.id = ?';
    const [rows] = await db.query(
      `SELECT ev.*, un.nombre AS unidad_nombre FROM evaluaciones ev
       JOIN unidades un ON un.id = ev.unidad_id ${where}`, [...f.args, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Evaluación no encontrada' });
    res.json(parse(rows[0]));
  } catch (e) { next(e); }
});

// Programar (COORD asigna a un inspector; INSP puede crear la suya). Una unidad solo puede tener una evaluación abierta.
router.post('/', requiereRol('COORD', 'INSP', 'ADMIN'), async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.unidad_id || !b.sis) return res.status(400).json({ error: 'Faltan unidad y sistema productivo' });
    const insp = req.usuario.rol === 'INSP' ? req.usuario.id : b.insp_id;
    if (!insp) return res.status(400).json({ error: 'Falta el inspector asignado' });

    const [[un]] = await db.query('SELECT estado FROM unidades WHERE id = ?', [b.unidad_id]);
    if (!un) return res.status(400).json({ error: 'La unidad no existe' });
    if (un.estado !== 'ACTIVA') return res.status(409).json({ error: 'La unidad está inhabilitada' });
    const [[{ ab }]] = await db.query(
      `SELECT COUNT(*) AS ab FROM evaluaciones WHERE unidad_id = ? AND estado IN ('BORRADOR','EN_PROCESO','FINALIZADA')`, [b.unidad_id]);
    if (ab) return res.status(409).json({ error: 'La unidad ya tiene una evaluación abierta' });

    const cap = String(b.sis).startsWith('TRAS') ? 'II' : 'I';
    const anio = new Date().getFullYear();
    const [[{ mx }]] = await db.query('SELECT COUNT(*) AS mx FROM evaluaciones WHERE YEAR(fecha) = ?', [anio]);
    const codigo = `${cap === 'I' ? 'V' : 'T'}-${anio}-${String(300 + mx + 1).padStart(4, '0')}`;

    const [r] = await db.query(
      `INSERT INTO evaluaciones (codigo, unidad_id, sis, cap, insp_id, fecha, hora, orden, pastoreo, detalle)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [codigo, b.unidad_id, b.sis, cap, insp, b.fecha || new Date().toISOString().slice(0, 10),
       b.hora || '08:00', b.orden || 'MBR', b.pastoreo ? 1 : 0, json(b.detalle)]);
    res.status(201).json({ id: r.insertId, codigo });
  } catch (e) { next(e); }
});

// Guardar avance. El inspector dueño (o quien finaliza en su nombre: COORD/ADMIN) y solo mientras no esté finalizada.
router.put('/:id', requiereRol('INSP', 'COORD', 'ADMIN'), async (req, res, next) => {
  try {
    const [[ev]] = await db.query('SELECT * FROM evaluaciones WHERE id = ?', [req.params.id]);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (req.usuario.rol === 'INSP' && ev.insp_id !== req.usuario.id)
      return res.status(403).json({ error: 'Esta evaluación está asignada a otro inspector' });
    if (!EDITABLES.includes(ev.estado))
      return res.status(409).json({ error: `No se puede editar una evaluación en estado ${ev.estado}` });

    const b = req.body;
    // BORRADOR -> EN_PROCESO cuando el front la inicia; nunca se retrocede
    const estado = (ev.estado === 'BORRADOR' && b.estado === 'EN_PROCESO') ? 'EN_PROCESO' : ev.estado;
    await db.query('UPDATE evaluaciones SET estado = ?, consent = ?, obs_gen = ?, hora = ?, orden = ?, detalle = ? WHERE id = ?',
      [estado, b.consent ? 1 : 0, b.obs_gen || '', b.hora || ev.hora, b.orden || ev.orden, json(b.detalle), ev.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/finalizar', requiereRol('INSP', 'COORD', 'ADMIN'), async (req, res, next) => {
  try {
    const [[ev]] = await db.query('SELECT * FROM evaluaciones WHERE id = ?', [req.params.id]);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (req.usuario.rol === 'INSP' && ev.insp_id !== req.usuario.id)
      return res.status(403).json({ error: 'Esta evaluación está asignada a otro inspector' });
    if (ev.estado !== 'EN_PROCESO') return res.status(409).json({ error: 'Solo se finaliza una evaluación en proceso' });
    await db.query('UPDATE evaluaciones SET estado = "FINALIZADA" WHERE id = ?', [ev.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Validar resultados: solo coordinación. Al validar, la evaluación pasa al histórico de la unidad.
router.post('/:id/validar', requiereRol('COORD', 'ADMIN'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const { total, grupos = {}, det = null } = req.body;     // el puntaje lo calcula el front (ver README)
    if (typeof total !== 'number') return res.status(400).json({ error: 'Falta el puntaje total' });
    const [[ev]] = await conn.query('SELECT * FROM evaluaciones WHERE id = ?', [req.params.id]);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (ev.estado !== 'FINALIZADA') return res.status(409).json({ error: 'Solo se valida una evaluación finalizada' });
    const cap = String(ev.sis || '').startsWith('TRAS') ? 'II' : 'I';

    await conn.beginTransaction();
    await conn.query('UPDATE evaluaciones SET estado = "VALIDADA", validada_por = ?, validada_en = NOW() WHERE id = ?',
      [req.usuario.id, ev.id]);
    await conn.query(
      'INSERT INTO historico (codigo, unidad_id, fecha, total, g_mbr, g_mba, g_mbg, cap, sis, det) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [ev.codigo, ev.unidad_id, ev.fecha, total, grupos.MBR || 0, grupos.MBA || 0, grupos.MBG || 0, cap, ev.sis || null, det ? json(det) : null]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); next(e); }
  finally { conn.release(); }
});

// Anular (coordinación o administración): conserva la evaluación con su motivo; la unidad queda libre
router.post('/:id/anular', requiereRol('COORD', 'ADMIN'), async (req, res, next) => {
  try {
    const [[ev]] = await db.query('SELECT * FROM evaluaciones WHERE id = ?', [req.params.id]);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (!ABIERTAS.includes(ev.estado)) return res.status(409).json({ error: `No se puede anular una evaluación en estado ${ev.estado}` });
    const motivo = String(req.body.motivo || '').trim();
    if (motivo.length < 10) return res.status(400).json({ error: 'Indique el motivo (mínimo 10 caracteres)' });
    const detalle = { ...unjson(ev.detalle), anulada: req.body.anulada || { motivo, estadoPrevio: ev.estado } };
    await db.query('UPDATE evaluaciones SET estado = "ANULADA", detalle = ? WHERE id = ?', [json(detalle), ev.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requiereRol } = require('../middleware/auth');
const { publico } = require('./auth');
const { txt, json } = require('../util');
// const { enviarClaveTemporal } = require('../mail'); // correo desactivado temporalmente

const ROLES = ['ADMIN', 'COORD', 'INSP', 'CONS', 'PROD', 'TEN', 'RT'];
const PERSONAL = ['ADMIN', 'COORD', 'INSP'];            // ven los datos completos de los usuarios
const OWNER_ROLES = ['PROD', 'TEN'];                      // roles que cualquiera con acceso a unidades puede registrar

// ADMIN/COORD/INSP: lista completa. Los demás: solo nombres y rol (más su propio registro completo).
router.get('/', async (req, res, next) => {
  try {
    // historial: el front solo permite eliminar usuarios sin historial
    const [rows] = await db.query(
      `SELECT u.*,
         EXISTS(SELECT 1 FROM evaluaciones e WHERE e.insp_id = u.id OR e.validada_por = u.id) AS hist_ev,
         EXISTS(SELECT 1 FROM unidades un WHERE un.propietario_id = u.id OR un.rt_id = u.id) AS hist_un
       FROM usuarios u ORDER BY u.id`);
    if (PERSONAL.includes(req.usuario.rol)) return res.json(rows.map(publico));
    res.json(rows.map(u => u.id === req.usuario.id ? publico(u)
      : ({ id: u.id, nombres: u.nombres, apellidos: u.apellidos, rol: u.rol, estado: u.estado })));
  } catch (e) { next(e); }
});

// Crear. ADMIN cualquier rol; COORD/INSP/PROD solo propietarios (PROD/TEN), desde el formulario de unidades.
router.post('/', requiereRol('ADMIN', 'COORD', 'INSP', 'PROD'), async (req, res, next) => {
  try {
    const b = req.body, esAdmin = req.usuario.rol === 'ADMIN';
    if (!b.nombres || !b.apellidos || !b.doc || !ROLES.includes(b.rol))
      return res.status(400).json({ error: 'Faltan datos obligatorios (nombres, apellidos, documento y rol)' });
    if (!esAdmin && !OWNER_ROLES.includes(b.rol))
      return res.status(403).json({ error: 'Solo un administrador puede crear usuarios con ese rol' });
    // Correo opcional (desactivado temporalmente)
    // if (!b.correo) return res.status(400).json({ error: 'El correo es obligatorio para poder enviar la clave temporal y el código de verificación' });
    const correo = b.correo ? String(b.correo).trim().toLowerCase() : '';
    if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });

    // Contraseña obligatoria (desactivada generación de clave temporal)
    let clave = b.password, debeCambiar = 0;
    if (!clave) return res.status(400).json({ error: 'La contraseña es obligatoria' });
    else if (String(clave).length < 10) return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres' });

    const hash = await bcrypt.hash(clave, 10);
    const [r] = await db.query(
      `INSERT INTO usuarios (nombres, apellidos, doc, correo, tel, rol, estado, seccional, matricula, vence, password_hash, debe_cambiar_password, extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.nombres, b.apellidos, b.doc, correo, txt(b.tel), b.rol,
       esAdmin && b.estado ? b.estado : 'PENDIENTE', txt(b.seccional), txt(b.matricula), txt(b.vence), hash, 0, json(b.extra)]
    );

    res.status(201).json({ id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    next(e);
  }
});

// Editar. ADMIN todo. Los demás: solo datos de contacto de propietarios (PROD/TEN); PROD solo el suyo.
router.put('/:id', requiereRol('ADMIN', 'COORD', 'INSP', 'PROD'), async (req, res, next) => {
  try {
    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const esAdmin = req.usuario.rol === 'ADMIN', b = req.body;
    if (!esAdmin) {
      if (!OWNER_ROLES.includes(u.rol)) return res.status(403).json({ error: 'Sin permiso para editar este usuario' });
      if (req.usuario.rol === 'PROD' && u.id !== req.usuario.id) return res.status(403).json({ error: 'Solo puede editar su propio registro' });
    }
    if (esAdmin && b.rol && !ROLES.includes(b.rol)) return res.status(400).json({ error: 'Rol inválido' });
    if (b.correo !== undefined && !txt(b.correo))
      return res.status(400).json({ error: 'El correo es obligatorio para poder enviar el código de verificación' });
    const correoNuevo = b.correo !== undefined ? String(b.correo).trim().toLowerCase() : u.correo;
    if (correoNuevo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correoNuevo))
      return res.status(400).json({ error: 'El correo no tiene un formato válido' });

    // Regla del front: debe quedar al menos un administrador activo
    if (esAdmin && u.rol === 'ADMIN' && ((b.rol !== undefined && b.rol !== 'ADMIN') || (b.estado !== undefined && b.estado !== 'ACTIVO'))) {
      const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM usuarios WHERE rol='ADMIN' AND estado='ACTIVO' AND id <> ?", [u.id]);
      if (n === 0) return res.status(409).json({ error: 'Debe existir al menos un administrador activo' });
    }
    const campos = {
      nombres: b.nombres ?? u.nombres, apellidos: b.apellidos ?? u.apellidos, doc: b.doc ?? u.doc,
      correo: correoNuevo,
      tel: b.tel !== undefined ? txt(b.tel) : u.tel,
      rol: esAdmin ? (b.rol ?? u.rol) : u.rol,
      estado: esAdmin ? (b.estado ?? u.estado) : u.estado,
      seccional: esAdmin && b.seccional !== undefined ? txt(b.seccional) : u.seccional,
      matricula: esAdmin && b.matricula !== undefined ? txt(b.matricula) : u.matricula,
      vence: esAdmin && b.vence !== undefined ? txt(b.vence) : u.vence,
      extra: b.extra !== undefined ? json({ ...JSON.parse(u.extra || '{}'), ...b.extra }) : u.extra
    };
    await db.query(
      `UPDATE usuarios SET nombres=?, apellidos=?, doc=?, correo=?, tel=?, rol=?, estado=?, seccional=?, matricula=?, vence=?, extra=? WHERE id=?`,
      [campos.nombres, campos.apellidos, campos.doc, campos.correo, campos.tel, campos.rol, campos.estado,
       campos.seccional, campos.matricula, campos.vence, campos.extra, u.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    next(e);
  }
});

// Eliminar: solo ADMIN y solo si no tiene historial (regla del front).
router.delete('/:id', requiereRol('ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.usuario.id) return res.status(409).json({ error: 'No puede eliminar su propia cuenta.' });
    const [[u]] = await db.query('SELECT id FROM usuarios WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const [[h]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM evaluaciones WHERE insp_id = ? OR validada_por = ?) +
         (SELECT COUNT(*) FROM unidades WHERE propietario_id = ? OR rt_id = ?) +
         (SELECT COUNT(*) FROM auditoria WHERE usuario_id = ?) +
         (SELECT COUNT(*) FROM notificaciones WHERE usuario_id = ?) AS n`,
      [id, id, id, id, id, id]);
    if (h.n > 0) return res.status(409).json({ error: 'El usuario tiene historial (accesos, visitas o registros). Inactívelo en lugar de eliminarlo.' });

    await db.query('DELETE FROM usuarios WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// El administrador asigna una contraseña temporal nueva; llega por correo y obliga cambio al ingresar.
router.post('/:id/password', requiereRol('ADMIN'), async (req, res, next) => {
  try {
    const [[u]] = await db.query('SELECT id, nombres, apellidos, correo, estado FROM usuarios WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!u.correo) return res.status(400).json({ error: 'El usuario no tiene correo registrado; regístrele uno antes de enviar la clave temporal' });

    const temporal = claveTemporal();
    await db.query(
      `UPDATE usuarios
          SET password_hash = ?, debe_cambiar_password = 1, sesion_version = sesion_version + 1,
              intentos_fallidos = 0, bloqueado_hasta = NULL
        WHERE id = ?`,
      [await bcrypt.hash(temporal, 10), u.id]);

    let correoEnviado = false, aviso = '';
    try {
      await enviarClaveTemporal(u, temporal);
      correoEnviado = true;
    } catch (e) {
      aviso = 'La clave temporal fue generada, pero no se pudo enviar por correo. Revise la configuración de correo.';
      console.error('No se pudo enviar la clave temporal a', u.correo, e.message);
    }
    res.json({ ok: true, correo_enviado: correoEnviado, ...(aviso ? { aviso } : {}) });
  } catch (e) { next(e); }
});

module.exports = router;

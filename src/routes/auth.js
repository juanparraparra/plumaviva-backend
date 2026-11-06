const crypto = require('crypto');
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { firmar, firmarProposito, verificarProposito, requiereSesion } = require('../middleware/auth');
const { auditar } = require('../audit');
const { unjson } = require('../util');
const {
  // enviarCodigo2fa, enviarConfirmacionCambio, enviarRecuperacion, enmascararCorreo, DRIVER: MAIL_DRIVER
} = require('../mail'); // correo y 2FA desactivados temporalmente

const MAX_INTENTOS = 5;          // intentos de contraseña antes de bloquear 15 min
const BLOQUEO_MIN = 15;
const OTP_MINUTOS = 10;          // vigencia del código 2FA
const OTP_MAX_INTENTOS = 5;
const OTP_ESPERA_MS = 60 * 1000;
const OTP_MAX_ENVIOS_HORA = 10;

// Hash de relleno: si el correo no existe se compara igual contra este, para que la respuesta tarde lo mismo
// y no se pueda saber por el tiempo qué correos están registrados.
const HASH_RELLENO = bcrypt.hashSync('relleno-no-es-una-clave-real', 10);

// Límite por IP (en memoria): frena el ataque de probar muchas cuentas desde un mismo equipo
const VENTANA_MS = 15 * 60 * 1000, MAX_POR_IP = Number(process.env.LIMITE_LOGIN_IP || 30), intentosIP = new Map();
function limitarPorIP(req, res, next) {
  const ahora = Date.now(), ip = req.ip || 'desconocida';
  const reg = (intentosIP.get(ip) || []).filter(t => ahora - t < VENTANA_MS);
  if (reg.length >= MAX_POR_IP) return res.status(429).json({ error: 'Demasiados intentos desde este equipo. Espere unos minutos.' });
  reg.push(ahora); intentosIP.set(ip, reg);
  if (intentosIP.size > 5000) for (const [k, v] of intentosIP) if (!v.some(t => ahora - t < VENTANA_MS)) intentosIP.delete(k);
  next();
}

const POLITICA = v => typeof v === 'string' && v.length >= 10 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);
const correoNormal = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const nombreUsuario = u => `${u.nombres || ''} ${u.apellidos || ''}`.trim();
// Solo en desarrollo con MAIL_DRIVER=console se devuelve el código para poder automatizar pruebas.
const datosDesarrollo = codigo => MAIL_DRIVER === 'console' && process.env.NODE_ENV !== 'production'
  ? { codigo_desarrollo: codigo } : {};

function hashCodigo(desafio, codigo) {
  return crypto.createHmac('sha256', process.env.OTP_SECRET || process.env.JWT_SECRET)
    .update(`${desafio}:${codigo}`).digest('hex');
}

function compararHash(a, b) {
  const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Crea un desafío 2FA, lo guarda hasheado y envía el código al correo. */
async function crearDesafio(usuario) {
  if (!usuario.correo) throw Object.assign(new Error('La cuenta no tiene un correo registrado.'), { status: 409 });

  // Limpieza de desafíos viejos (no se guardan códigos en claro).
  await db.query(
    'DELETE FROM codigos_2fa WHERE usuario_id = ? AND (expira < NOW() OR (usado = 1 AND creado_en < DATE_SUB(NOW(), INTERVAL 1 DAY)))',
    [usuario.id]);

  const [[{ n }]] = await db.query(
    'SELECT COUNT(*) AS n FROM codigos_2fa WHERE usuario_id = ? AND creado_en > DATE_SUB(NOW(), INTERVAL 1 HOUR)',
    [usuario.id]);
  if (n >= OTP_MAX_ENVIOS_HORA)
    throw Object.assign(new Error('Se enviaron demasiados códigos. Espere unos minutos e intente de nuevo.'), { status: 429 });

  const [[ultimo]] = await db.query(
    'SELECT creado_en FROM codigos_2fa WHERE usuario_id = ? ORDER BY creado_en DESC LIMIT 1',
    [usuario.id]);
  if (ultimo && Date.now() - new Date(ultimo.creado_en).getTime() < OTP_ESPERA_MS)
    throw Object.assign(new Error('Espere un minuto antes de solicitar otro código.'), { status: 429 });

  const desafio = crypto.randomUUID();
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query('UPDATE codigos_2fa SET usado = 1 WHERE usuario_id = ? AND usado = 0', [usuario.id]);
  await db.query(
    'INSERT INTO codigos_2fa (id, usuario_id, codigo_hash, expira) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
    [desafio, usuario.id, hashCodigo(desafio, codigo), OTP_MINUTOS]);

  try {
    await enviarCodigo2fa(usuario, codigo, OTP_MINUTOS);
  } catch (e) {
    await db.query('DELETE FROM codigos_2fa WHERE id = ?', [desafio]).catch(() => {});
    throw Object.assign(new Error('No se pudo enviar el código de verificación. Intente de nuevo.'), { status: 503, causa: e });
  }
  return { desafio, expira_en: OTP_MINUTOS * 60, codigo };
}

router.post('/login', limitarPorIP, async (req, res, next) => {
  try {
    const cuerpo = req.body || {};
    const correo = correoNormal(cuerpo.correo);
    const password = typeof cuerpo.password === 'string' ? cuerpo.password : '';
    if (!correo || !password) return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });

    const [[u]] = await db.query('SELECT * FROM usuarios WHERE correo = ?', [correo]);
    // mismo mensaje exista o no el usuario, para no revelar cuentas
    const credencialesMal = () => res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    if (!u) { await bcrypt.compare(password, HASH_RELLENO); return credencialesMal(); }

    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date())
      return res.status(423).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos. Intente más tarde o contacte al administrador.' });

    const ok = await bcrypt.compare(password, u.password_hash || HASH_RELLENO) && !!u.password_hash;
    if (!ok) {
      const intentos = u.intentos_fallidos + 1;
      if (intentos >= MAX_INTENTOS) {
        await db.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [BLOQUEO_MIN, u.id]);
      } else {
        await db.query('UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?', [intentos, u.id]);
      }
      return credencialesMal();
    }
    if (u.estado !== 'ACTIVO') return res.status(403).json({ error: 'La cuenta no está activa' });

    await db.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?', [u.id]);
    req.usuario = { id: u.id, rol: u.rol, nombre: nombreUsuario(u) };

    await auditar(req, 'Inició sesión', `Usuario ${u.correo}`, { modulo: 'Acceso' });
    res.json({ token: firmar(u), usuario: publico(u) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* 2FA y recuperación de contraseña desactivados temporalmente
/** Cambio obligatorio de la clave temporal. No entrega sesión: después exige el código 2FA.
router.post('/cambiar-password-inicial', limitarPorIP, async (req, res, next) => {
  try {
    const b = req.body || {};
    const token = typeof b.token_cambio === 'string' ? b.token_cambio : '';
    const actual = typeof b.actual === 'string' ? b.actual : '';
    const nueva = typeof b.nueva === 'string' ? b.nueva : '';
    const confirmar = typeof b.confirmar === 'string' ? b.confirmar : '';
    if (!token || !actual || !nueva || !confirmar)
      return res.status(400).json({ error: 'La contraseña actual, la nueva y su confirmación son obligatorias' });

    let payload;
    try { payload = verificarProposito(token, 'cambio_password'); }
    catch { return res.status(401).json({ error: 'El proceso de cambio venció. Inicie sesión de nuevo.' }); }

    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [payload.id]);
    if (!u || u.estado !== 'ACTIVO') return res.status(401).json({ error: 'La cuenta no está activa' });
    if (!u.debe_cambiar_password) return res.status(409).json({ error: 'La contraseña de esta cuenta ya fue cambiada. Inicie sesión de nuevo.' });
    if (!(await bcrypt.compare(actual, u.password_hash)))
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    if (!POLITICA(nueva))
      return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres, mayúscula, minúscula, número y carácter especial' });
    if (nueva !== confirmar)
      return res.status(400).json({ error: 'Las contraseñas nuevas no coinciden' });
    if (await bcrypt.compare(nueva, u.password_hash))
      return res.status(400).json({ error: 'La contraseña nueva debe ser diferente de la temporal' });

    await db.query(
      `UPDATE usuarios
          SET password_hash = ?, debe_cambiar_password = 0, sesion_version = sesion_version + 1,
              intentos_fallidos = 0, bloqueado_hasta = NULL
        WHERE id = ?`,
      [await bcrypt.hash(nueva, 10), u.id]);

    req.usuario = { id: u.id, rol: u.rol, nombre: nombreUsuario(u) };
    await auditar(req, 'Cambió contraseña inicial', `Usuario ${u.correo}`, { modulo: 'Acceso' });
    enviarConfirmacionCambio(u).catch(e => console.warn('No se pudo enviar la confirmación de contraseña:', e.message));

    const actualizado = { ...u, debe_cambiar_password: 0 };
    try {
      const desafio = await crearDesafio(actualizado);
      res.json({
        ok: true,
        requiere_2fa: true,
        desafio: desafio.desafio,
        expira_en: desafio.expira_en,
        correo_enmascarado: enmascararCorreo(actualizado.correo),
        ...datosDesarrollo(desafio.codigo)
      });
    } catch (e) {
      res.json({
        ok: true,
        requiere_2fa: false,
        aviso: 'Contraseña actualizada. No se pudo enviar el código de verificación; inicie sesión de nuevo para solicitar uno.'
      });
    }
  } catch (e) { next(e); }
});

/** Verifica el código enviado por correo y solo entonces emite el JWT de sesión.
router.post('/verificar-2fa', limitarPorIP, async (req, res, next) => {
  try {
    const b = req.body || {};
    const desafio = typeof b.desafio === 'string' ? b.desafio : '';
    const codigo = typeof b.codigo === 'string' ? b.codigo.replace(/\s/g, '') : '';
    if (!desafio || !/^\d{6}$/.test(codigo))
      return res.status(400).json({ error: 'Escriba el código de 6 dígitos' });

    const [[fila]] = await db.query('SELECT * FROM codigos_2fa WHERE id = ? LIMIT 1', [desafio]);
    if (!fila || fila.usado || new Date(fila.expira) <= new Date())
      return res.status(400).json({ error: 'El código venció o ya fue usado. Inicie sesión de nuevo.' });
    if (fila.intentos >= OTP_MAX_INTENTOS) {
      await db.query('UPDATE codigos_2fa SET usado = 1 WHERE id = ?', [fila.id]);
      return res.status(429).json({ error: 'Se agotaron los intentos. Inicie sesión de nuevo.' });
    }

    if (!compararHash(hashCodigo(desafio, codigo), fila.codigo_hash)) {
      const intentos = fila.intentos + 1;
      await db.query('UPDATE codigos_2fa SET intentos = ?, usado = ? WHERE id = ?',
        [intentos, intentos >= OTP_MAX_INTENTOS ? 1 : 0, fila.id]);
      const restantes = Math.max(0, OTP_MAX_INTENTOS - intentos);
      return res.status(401).json({
        error: restantes
          ? `Código incorrecto. Intentos restantes: ${restantes}.`
          : 'Se agotaron los intentos. Inicie sesión de nuevo.'
      });
    }

    await db.query('UPDATE codigos_2fa SET usado = 1 WHERE id = ?', [fila.id]);
    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [fila.usuario_id]);
    if (!u || u.estado !== 'ACTIVO')
      return res.status(401).json({ error: 'La cuenta ya no está activa. Inicie sesión de nuevo.' });

    req.usuario = { id: u.id, rol: u.rol, nombre: nombreUsuario(u) };
    await auditar(req, 'Inició sesión', `Usuario ${u.correo}`, { modulo: 'Acceso' });
    res.json({ token: firmar(u), usuario: publico(u) });
  } catch (e) { next(e); }
});

router.post('/reenviar-2fa', limitarPorIP, async (req, res, next) => {
  try {
    const desafio = typeof (req.body || {}).desafio === 'string' ? req.body.desafio : '';
    if (!desafio) return res.status(400).json({ error: 'Falta el desafío de verificación' });
    const [[fila]] = await db.query('SELECT * FROM codigos_2fa WHERE id = ? LIMIT 1', [desafio]);
    if (!fila || fila.usado || new Date(fila.expira) <= new Date())
      return res.status(400).json({ error: 'La verificación venció. Inicie sesión de nuevo.' });
    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [fila.usuario_id]);
    if (!u || u.estado !== 'ACTIVO')
      return res.status(401).json({ error: 'La cuenta no está activa' });

    const nuevo = await crearDesafio(u);
    res.json({
      ok: true,
      desafio: nuevo.desafio,
      expira_en: nuevo.expira_en,
      correo_enmascarado: enmascararCorreo(u.correo),
      ...datosDesarrollo(nuevo.codigo)
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/me', requiereSesion, async (req, res, next) => {
  try {
    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(publico(u));
  } catch (e) { next(e); }
});

// Cierre de sesión: el JWT es sin estado; se registra el evento para el control de cambios.
router.post('/logout', requiereSesion, async (req, res, next) => {
  try {
    await auditar(req, 'Cerró sesión', `Usuario ${req.usuario.nombre}`, { modulo: 'Acceso' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Recuperación de contraseña ----
// Por seguridad siempre responde lo mismo. En desarrollo (no producción) devuelve el token
// para poder probar el flujo sin servidor de correo. En producción el enlace llega por correo.
router.post('/recuperar', limitarPorIP, async (req, res, next) => {
  try {
    const correo = correoNormal((req.body || {}).correo);
    const generico = { ok: true, mensaje: 'Si el correo existe, recibirá un enlace válido por 30 minutos.' };
    if (!correo) return res.json(generico);

    const [[u]] = await db.query('SELECT id, nombres, apellidos, correo, estado FROM usuarios WHERE correo = ?', [correo]);
    if (!u || u.estado !== 'ACTIVO' || !u.correo) return res.json(generico);

    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query('DELETE FROM recuperacion WHERE usuario_id = ? OR expira < NOW()', [u.id]);
    await db.query('INSERT INTO recuperacion (usuario_id, token_hash, expira) VALUES (?,?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))', [u.id, hash]);

    enviarRecuperacion(u, token, 30).catch(e => console.warn('No se pudo enviar el correo de recuperación:', e.message));
    if (process.env.NODE_ENV !== 'production') return res.json({ ...generico, token });
    res.json(generico);
  } catch (e) { next(e); }
});

router.post('/restablecer', limitarPorIP, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token y contraseña son obligatorios' });
    if (!POLITICA(password))
      return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres, mayúscula, minúscula, número y carácter especial' });

    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [[fila]] = await db.query(
      'SELECT id, usuario_id FROM recuperacion WHERE token_hash = ? AND usado = 0 AND expira > NOW() LIMIT 1', [hash]);
    if (!fila) return res.status(400).json({ error: 'El enlace venció o ya fue usado. Solicite uno nuevo.' });

    const [[u]] = await db.query('SELECT id, nombres, apellidos, correo, rol FROM usuarios WHERE id = ?', [fila.usuario_id]);
    await db.query(
      `UPDATE usuarios
          SET password_hash = ?, debe_cambiar_password = 0, sesion_version = sesion_version + 1,
              intentos_fallidos = 0, bloqueado_hasta = NULL
        WHERE id = ?`,
      [await bcrypt.hash(password, 10), fila.usuario_id]);
    await db.query('UPDATE recuperacion SET usado = 1 WHERE id = ?', [fila.id]);
    await db.query(
      'INSERT INTO auditoria (usuario_id, rol, usuario, accion, objeto, modulo, detalle, motivo) VALUES (?,?,?,?,?,?,?,?)',
      [fila.usuario_id, u?.rol || '', u ? nombreUsuario(u) : 'Recuperación', 'Restableció contraseña', 'Contraseña', 'Acceso', '[]', '']);
    if (u?.correo) enviarConfirmacionCambio(u).catch(e => console.warn('No se pudo enviar la confirmación de contraseña:', e.message));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

*/

router.get('/me', requiereSesion, async (req, res, next) => {
  try {
    const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(publico(u));
  } catch (e) { next(e); }
});

// Cierre de sesión
router.post('/logout', requiereSesion, async (req, res, next) => {
  try {
    await auditar(req, 'Cerró sesión', `Usuario ${req.usuario.nombre}`, { modulo: 'Acceso' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function publico(u) {
  const { password_hash, intentos_fallidos, bloqueado_hasta, extra, hist_ev, hist_un, ...resto } = u;
  const datos = unjson(extra);
  return { ...resto, extra: datos, historial: !!(datos.historial || hist_ev || hist_un) };
}

module.exports = router;
module.exports.publico = publico;

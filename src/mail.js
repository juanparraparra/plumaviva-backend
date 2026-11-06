// Envío de correos transaccionales de PlumaViva.
// En desarrollo se puede usar MAIL_DRIVER=console: el correo se imprime y se guarda en un
// archivo temporal para que las pruebas puedan leer el código. En producción se exige SMTP.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const DRIVER = String(process.env.MAIL_DRIVER || 'console').toLowerCase();
const APP_URL = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const FROM = process.env.MAIL_FROM || process.env.MAIL_USER || 'no-reply@localhost';
const OUTBOX = process.env.MAIL_OUTBOX || path.join(__dirname, '..', '.correos-dev.jsonl');
let transporte = null;

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Enmascara el correo para mostrarlo en pantalla sin revelar la cuenta completa. */
function enmascararCorreo(correo) {
  const texto = String(correo || '').trim();
  const arroba = texto.indexOf('@');
  if (arroba <= 0) return texto ? '***' : '';
  const usuario = texto.slice(0, arroba);
  const dominio = texto.slice(arroba);
  if (usuario.length <= 2) return usuario[0] + '***' + dominio;
  return usuario[0] + '***' + usuario[usuario.length - 1] + dominio;
}

function configurado() {
  if (DRIVER === 'console') return true;
  return DRIVER === 'smtp' && !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);
}

/** Falla rápido al arrancar en producción si el correo no está configurado. */
function validarConfiguracion() {
  if (DRIVER === 'console') {
    if (process.env.NODE_ENV === 'production')
      throw new Error('MAIL_DRIVER=console no está permitido en producción. Configure MAIL_DRIVER=smtp.');
    return;
  }
  if (DRIVER !== 'smtp')
    throw new Error(`MAIL_DRIVER "${DRIVER}" no es válido. Use "smtp" o "console".`);
  const faltan = ['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS', 'MAIL_FROM'].filter(k => !process.env[k]);
  if (faltan.length) throw new Error('Faltan variables de correo: ' + faltan.join(', '));
}

function getTransporte() {
  if (transporte) return transporte;
  const puerto = Number(process.env.MAIL_PORT || 587);
  transporte = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: puerto,
    secure: String(process.env.MAIL_SECURE || '').toLowerCase() === 'true' || puerto === 465,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
  return transporte;
}

function htmlBase(titulo, contenido) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title></head>
<body style="margin:0;background:#f4f7f5;font-family:Arial,Helvetica,sans-serif;color:#1f2d27">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe8e2;border-radius:12px;overflow:hidden">
        <tr><td style="background:#1f5c43;color:#ffffff;padding:18px 24px;font-size:20px;font-weight:bold">PlumaViva</td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 12px;font-size:22px;color:#1f5c43">${esc(titulo)}</h1>
          ${contenido}
          <p style="margin:24px 0 0;font-size:12px;color:#6b7c73">Este mensaje fue enviado automáticamente por PlumaViva. No responda a este correo.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function guardarEnConsola(mensaje) {
  const registro = {
    creado_en: new Date().toISOString(),
    to: mensaje.to,
    subject: mensaje.subject,
    text: mensaje.text,
    html: mensaje.html
  };
  try {
    fs.appendFileSync(OUTBOX, JSON.stringify(registro) + '\n', 'utf8');
  } catch (e) {
    console.warn('No se pudo escribir el buzón de desarrollo:', e.message);
  }
  console.log(`\n[correo:consola] Para: ${mensaje.to} | ${mensaje.subject}\n${mensaje.text}\n`);
}

async function enviar(mensaje) {
  const to = String(mensaje.to || '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    throw new Error('El destinatario del correo no es válido.');
  const datos = {
    from: FROM,
    to,
    subject: String(mensaje.subject || 'PlumaViva'),
    text: String(mensaje.text || ''),
    html: mensaje.html || htmlBase(mensaje.subject || 'PlumaViva', `<p>${esc(mensaje.text || '')}</p>`)
  };
  if (DRIVER === 'console') {
    guardarEnConsola(datos);
    return { simulado: true, to };
  }
  if (DRIVER !== 'smtp') throw new Error('MAIL_DRIVER no configurado.');
  return getTransporte().sendMail(datos);
}

async function enviarClaveTemporal(usuario, clave) {
  const nombre = `${usuario.nombres || ''} ${usuario.apellidos || ''}`.trim() || 'usuario';
  const enlace = `${APP_URL}/#/login`;
  const text = [
    `Hola ${nombre}:`,
    '',
    'Se creó (o restableció) su acceso a PlumaViva.',
    `Correo registrado: ${usuario.correo}`,
    `Clave temporal: ${clave}`,
    '',
    'Por seguridad, al ingresar deberá cambiar esta clave temporal por una propia.',
    `Ingrese en: ${enlace}`,
    '',
    'Si no solicitó este acceso, contacte al administrador.'
  ].join('\n');
  const html = htmlBase('Clave temporal de acceso', `
    <p>Hola <b>${esc(nombre)}</b>:</p>
    <p>Se creó (o restableció) su acceso a PlumaViva.</p>
    <p style="margin:18px 0;padding:14px;background:#f1f8f4;border:1px solid #cfe3d7;border-radius:8px;text-align:center">
      <span style="display:block;font-size:12px;color:#5b7066;margin-bottom:6px">Clave temporal</span>
      <b style="font-size:22px;letter-spacing:1px;color:#1f5c43">${esc(clave)}</b>
    </p>
    <p>Al ingresar deberá cambiar esta clave por una propia.</p>
    <p><a href="${esc(enlace)}" style="display:inline-block;background:#1f5c43;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px">Ingresar a PlumaViva</a></p>
    <p style="font-size:13px;color:#5b7066">Si no solicitó este acceso, contacte al administrador.</p>
  `);
  return enviar({ to: usuario.correo, subject: 'PlumaViva · Clave temporal de acceso', text, html });
}

async function enviarCodigo2fa(usuario, codigo, minutos = 10) {
  const nombre = `${usuario.nombres || ''} ${usuario.apellidos || ''}`.trim() || 'usuario';
  const text = [
    `Hola ${nombre}:`,
    '',
    `Su código de verificación de PlumaViva es: ${codigo}`,
    `Vence en ${minutos} minutos y solo se puede usar una vez.`,
    '',
    'Si no intentó ingresar, cambie su contraseña y contacte al administrador.'
  ].join('\n');
  const html = htmlBase('Código de verificación', `
    <p>Hola <b>${esc(nombre)}</b>:</p>
    <p>Use este código para completar su ingreso:</p>
    <p style="margin:18px 0;padding:16px;background:#f1f8f4;border:1px solid #cfe3d7;border-radius:8px;text-align:center">
      <b style="font-size:32px;letter-spacing:8px;color:#1f5c43">${esc(codigo)}</b>
    </p>
    <p>Vence en <b>${minutos} minutos</b> y solo se puede usar una vez.</p>
    <p style="font-size:13px;color:#5b7066">Si no intentó ingresar, cambie su contraseña y contacte al administrador.</p>
  `);
  return enviar({ to: usuario.correo, subject: 'PlumaViva · Código de verificación', text, html });
}

async function enviarConfirmacionCambio(usuario) {
  const nombre = `${usuario.nombres || ''} ${usuario.apellidos || ''}`.trim() || 'usuario';
  const text = [
    `Hola ${nombre}:`,
    '',
    'La contraseña de su cuenta PlumaViva fue actualizada correctamente.',
    'Si usted no realizó este cambio, contacte de inmediato al administrador.'
  ].join('\n');
  const html = htmlBase('Contraseña actualizada', `
    <p>Hola <b>${esc(nombre)}</b>:</p>
    <p>La contraseña de su cuenta PlumaViva fue actualizada correctamente.</p>
    <p>Si usted no realizó este cambio, contacte de inmediato al administrador.</p>
  `);
  return enviar({ to: usuario.correo, subject: 'PlumaViva · Contraseña actualizada', text, html });
}

async function enviarRecuperacion(usuario, token, minutos = 30) {
  const nombre = `${usuario.nombres || ''} ${usuario.apellidos || ''}`.trim() || 'usuario';
  const enlace = `${APP_URL}/#/restablecer?token=${encodeURIComponent(token)}`;
  const text = [
    `Hola ${nombre}:`,
    '',
    'Recibimos una solicitud para restablecer su contraseña de PlumaViva.',
    `Abra este enlace (válido por ${minutos} minutos):`,
    enlace,
    '',
    'Si no solicitó el cambio, ignore este mensaje.'
  ].join('\n');
  const html = htmlBase('Restablecer contraseña', `
    <p>Hola <b>${esc(nombre)}</b>:</p>
    <p>Recibimos una solicitud para restablecer su contraseña.</p>
    <p><a href="${esc(enlace)}" style="display:inline-block;background:#1f5c43;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px">Crear nueva contraseña</a></p>
    <p style="font-size:13px;color:#5b7066">El enlace vence en ${minutos} minutos y solo se puede usar una vez. Si no solicitó el cambio, ignore este mensaje.</p>
  `);
  return enviar({ to: usuario.correo, subject: 'PlumaViva · Restablecer contraseña', text, html });
}

module.exports = {
  DRIVER,
  configurado,
  validarConfiguracion,
  enviar,
  enviarClaveTemporal,
  enviarCodigo2fa,
  enviarConfirmacionCambio,
  enviarRecuperacion,
  enmascararCorreo,
  APP_URL
};

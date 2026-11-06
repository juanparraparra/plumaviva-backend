// Prueba de humo del ingreso (clave + 2FA por correo) contra una base real.  Uso:  npm run probar-auth
// Requiere el servidor encendido (npm run dev) en el puerto de .env (PORT, por defecto 3000).
// Si MAIL_DRIVER=console, lee el código del buzón de desarrollo (.correos-dev.jsonl).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const OUTBOX = path.join(__dirname, '..', process.env.MAIL_OUTBOX || '.correos-dev.jsonl');
let fallos = 0;
const ok = (m, extra) => console.log('  ✔ ' + m + (extra ? ' · ' + extra : ''));
const mal = (m, extra) => { fallos++; console.log('  ✘ ' + m + (extra ? ' · ' + extra : '')); };
const check = (m, cond, extra) => cond ? ok(m, extra) : mal(m, extra);

async function api(metodo, ruta, cuerpo, token) {
  try {
    const r = await fetch(BASE + '/api' + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const texto = await r.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
    return { status: r.status, datos };
  } catch (e) {
    return { status: 0, datos: { error: e.message } };
  }
}

/** Último código 2FA enviado a un correo cuando el servidor usa MAIL_DRIVER=console. */
function codigoDelBuzon(correo) {
  try {
    if (!fs.existsSync(OUTBOX)) return null;
    const lineas = fs.readFileSync(OUTBOX, 'utf8').trim().split(/\r?\n/).reverse();
    for (const linea of lineas) {
      try {
        const m = JSON.parse(linea);
        if (String(m.to || '').toLowerCase() !== correo.toLowerCase()) continue;
        const codigo = String(m.text || '').match(/(?:Su código de verificación de PlumaViva es:|es:)\s*(\d{6})/)?.[1];
        if (codigo) return codigo;
      } catch { /* línea incompleta */ }
    }
  } catch { /* sin buzón */ }
  return null;
}

/** Última clave temporal enviada a un correo cuando el servidor usa MAIL_DRIVER=console. */
function claveTemporalDelBuzon(correo) {
  try {
    if (!fs.existsSync(OUTBOX)) return null;
    const lineas = fs.readFileSync(OUTBOX, 'utf8').trim().split(/\r?\n/).reverse();
    for (const linea of lineas) {
      try {
        const m = JSON.parse(linea);
        if (String(m.to || '').toLowerCase() !== correo.toLowerCase()) continue;
        const clave = String(m.text || '').match(/Clave temporal:\s*(\S+)/)?.[1];
        if (clave) return clave;
      } catch { /* línea incompleta */ }
    }
  } catch { /* sin buzón */ }
  return null;
}

/** Firma un JWT de sesión con la misma forma que usa el servidor (respaldo cuando no hay código a mano). */
async function tokenFirmado(conn, correo) {
  const [[u]] = await conn.query('SELECT id, sesion_version FROM usuarios WHERE correo = ?', [correo]);
  if (!u) return null;
  return jwt.sign({ id: u.id, purpose: 'session', v: Number(u.sesion_version) || 0 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

/** Inicia sesión y completa el 2FA si el código está disponible. Devuelve el JWT de sesión o null. */
async function ingresar(conn, correo, password) {
  const login = await api('POST', '/auth/login', { correo, password });
  if (login.status !== 200) return { login, token: null, error: login.datos?.error };
  if (login.datos?.token) return { login, token: login.datos.token, directo: true };
  if (login.datos?.requiere_cambio) return { login, token: null, requiereCambio: true };

  const codigo = login.datos?.codigo_desarrollo;
  if (!codigo) return { login, token: await tokenFirmado(conn, correo), sinCodigo: true };

  const malo = await api('POST', '/auth/verificar-2fa', { desafio: login.datos.desafio, codigo: '000000' === codigo ? '111111' : '000000' });
  const verifica = await api('POST', '/auth/verificar-2fa', { desafio: login.datos.desafio, codigo });
  return { login, token: verifica.datos?.token || null, verifica, malo };
}

(async () => {
  console.log('\nPrueba de ingreso con 2FA y sesión · ' + BASE + '\n');
  const conecta = await api('GET', '/health');
  if (conecta.status !== 200) {
    mal('El servidor no responde. Enciéndalo con: npm run dev', JSON.stringify(conecta.datos));
    process.exitCode = 1;
    return;
  }
  ok('El servidor responde', 'db=' + conecta.datos?.db);

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'plumaviva'
    });

    // Los códigos pendientes de las cuentas de prueba se limpian para poder repetir la prueba.
    await conn.query(
      "DELETE FROM codigos_2fa WHERE usuario_id IN (SELECT id FROM usuarios WHERE correo IN (?, ?))",
      ['admin@demo.co', 'inspector@demo.co']);
    const correos = [];

    // 1. Ingreso del administrador: el JWT solo puede salir después del 2FA.
    const admin = await ingresar(conn, 'admin@demo.co', 'Demo2026*');
    check('Ingreso con la clave correcta', admin.login.status === 200, JSON.stringify(admin.login.datos));
    check('El login no entrega el JWT antes de verificar', !admin.directo && !admin.login.datos?.token, JSON.stringify(admin.login.datos));
    if (admin.login.datos?.requiere_2fa) {
      check('Se creó un desafío 2FA', !!admin.login.datos.desafio, admin.login.datos.correo_enmascarado);
      if (admin.verifica) {
        check('Un código incorrecto no entrega el JWT', admin.malo?.status === 401, JSON.stringify(admin.malo?.datos));
        check('El código correcto entrega el JWT', admin.verifica.status === 200 && !!admin.token, JSON.stringify(admin.verifica.datos));
      } else {
        console.log('  • No se pudo leer el código (MAIL_DRIVER=smtp): se usa un JWT firmado para probar las rutas protegidas.');
      }
    } else if (admin.login.datos?.requiere_cambio) {
      check('La cuenta pide cambio de clave temporal', !admin.login.datos.token, JSON.stringify(admin.login.datos));
      const temp = await api('GET', '/auth/me', null, admin.login.datos.token_cambio);
      check('El token de cambio no sirve como sesión', temp.status === 401, JSON.stringify(temp.datos));
    }
    const token = admin.token;
    if (!token) { console.log('\nSin sesión no se pueden probar las demás reglas.'); process.exitCode = 1; return; }
    // El servidor está en modo consola si devolvió el código: así se puede leer la clave temporal.
    const sirveConsola = !!admin.login.datos?.codigo_desarrollo;

    // 2. Credenciales incorrectas y correo inexistente: mismo mensaje y 401.
    const mala = await api('POST', '/auth/login', { correo: 'admin@demo.co', password: 'NoEsLaClave*9' });
    check('Clave incorrecta devuelve 401', mala.status === 401, JSON.stringify(mala.datos));
    const inexistente = await api('POST', '/auth/login', { correo: 'nadie-' + Date.now() + '@demo.co', password: 'Demo2026*' });
    check('Correo inexistente devuelve 401', inexistente.status === 401, JSON.stringify(inexistente.datos));
    check('El mensaje no revela si el correo existe', mala.datos?.error === inexistente.datos?.error, mala.datos?.error);

    // 3. Rutas protegidas y token manipulado.
    const sinToken = await api('GET', '/usuarios');
    check('Ruta protegida sin token devuelve 401', sinToken.status === 401, JSON.stringify(sinToken.datos));
    const manipulado = await api('GET', '/usuarios', null, token.slice(0, -3) + 'abc');
    check('Token manipulado devuelve 401', manipulado.status === 401, JSON.stringify(manipulado.datos));

    const me = await api('GET', '/auth/me', null, token);
    check('GET /auth/me con token válido', me.status === 200 && me.datos?.rol === 'ADMIN', me.datos?.correo);

    // 4. Permisos por rol: el inspector no puede leer auditoría.
    const insp = await ingresar(conn, 'inspector@demo.co', 'Demo2026*');
    check('Ingreso del inspector', insp.login.status === 200, JSON.stringify(insp.login.datos));
    if (insp.token) {
      const auditInsp = await api('GET', '/auditoria', null, insp.token);
      check('El inspector no accede a auditoría (403)', auditInsp.status === 403, JSON.stringify(auditInsp.datos));
    }

    // 5. Roles: la matriz completa (incluidos los roles base) se conserva.
    const rolesAntes = await api('GET', '/roles', null, token);
    if (rolesAntes.status === 200) {
      const guardado = await api('PUT', '/roles', {
        roles: rolesAntes.datos.roles, perm: rolesAntes.datos.perm, siguiente: rolesAntes.datos.siguiente
      }, token);
      check('El administrador puede guardar la matriz de roles', guardado.status === 200, JSON.stringify(guardado.datos));
      const rolesDespues = await api('GET', '/roles', null, token);
      check('Los roles guardados se recuperan iguales', JSON.stringify(rolesDespues.datos) === JSON.stringify(rolesAntes.datos));
    }

    // 6. Correo obligatorio al crear usuarios.
    const sinCorreo = await api('POST', '/usuarios', {
      nombres: 'Sin', apellidos: 'Correo', doc: 'CC 8' + String(Date.now()).slice(-8), rol: 'INSP', estado: 'ACTIVO', extra: { tipoDoc: 'CC' }
    }, token);
    check('No se puede crear un usuario sin correo (400)', sinCorreo.status === 400, JSON.stringify(sinCorreo.datos));

    // 7. Clave temporal enviada por correo: login → cambio obligatorio → 2FA → JWT.
    if (sirveConsola) {
      const correoTemp = `prueba_temporal_${Date.now()}@demo.co`;
      correos.push(correoTemp);
      const creado = await api('POST', '/usuarios', {
        nombres: 'Prueba', apellidos: 'Temporal', doc: 'CC 7' + String(Date.now()).slice(-8),
        correo: correoTemp, rol: 'INSP', estado: 'ACTIVO', extra: { tipoDoc: 'CC' }
      }, token);
      check('Crea usuario sin clave y envía la temporal', creado.status === 201 && creado.datos?.correo_enviado === true, JSON.stringify(creado.datos));
      const claveTemp = claveTemporalDelBuzon(correoTemp);
      check('La clave temporal llegó al buzón de desarrollo', !!claveTemp);
      if (claveTemp) {
        const l = await api('POST', '/auth/login', { correo: correoTemp, password: claveTemp });
        check('El primer ingreso pide cambiar la clave temporal', l.status === 200 && l.datos?.requiere_cambio === true && !l.datos?.token, JSON.stringify(l.datos));
        const cambio = await api('POST', '/auth/cambiar-password-inicial', {
          token_cambio: l.datos?.token_cambio, actual: claveTemp, nueva: 'Nueva2026*', confirmar: 'Nueva2026*'
        });
        check('El cambio de clave inicial entrega un desafío 2FA', cambio.status === 200 && !!cambio.datos?.desafio, JSON.stringify(cambio.datos));
        const cod = cambio.datos?.codigo_desarrollo || codigoDelBuzon(correoTemp);
        const fin = cod ? await api('POST', '/auth/verificar-2fa', { desafio: cambio.datos.desafio, codigo: cod }) : null;
        check('Después del cambio, el 2FA entrega el JWT', !!fin && fin.status === 200 && !!fin.datos?.token, JSON.stringify(fin?.datos));
        if (fin?.datos?.token) {
          const quien = await api('GET', '/auth/me', null, fin.datos.token);
          check('La sesión nueva identifica al usuario', quien.status === 200 && quien.datos?.correo === correoTemp, quien.datos?.correo);
        }
      }
    } else {
      console.log('  • Flujo de clave temporal omitido: requiere MAIL_DRIVER=console para leer la clave del buzón.');
    }

    // 8. Cuenta inactivada con la sesión abierta: el token deja de servir de inmediato.
    const sufijo = Date.now();
    const crear = async (rol, etiqueta) => {
      const correo = `prueba_${etiqueta}_${sufijo}@demo.co`;
      correos.push(correo);
      const r = await api('POST', '/usuarios', {
        nombres: 'Prueba', apellidos: etiqueta, doc: 'CC 9' + String(sufijo).slice(-8),
        correo, rol, estado: 'ACTIVO', password: 'Prueba2026*', extra: { tipoDoc: 'CC' }
      }, token);
      return { correo, id: r.datos?.id, status: r.status, datos: r.datos };
    };

    const u = await crear('INSP', 'sesion');
    check('Crea un usuario temporal', u.status === 201 && !!u.id, JSON.stringify(u.datos));
    if (u.id) {
      const lg = await ingresar(conn, u.correo, 'Prueba2026*');
      check('El usuario temporal inicia sesión', lg.login.status === 200, JSON.stringify(lg.login.datos));
      if (lg.token) {
        const off = await api('PUT', '/usuarios/' + u.id, { estado: 'INACTIVA' }, token);
        check('El administrador inactiva la cuenta', off.status === 200, JSON.stringify(off.datos));
        const despues = await api('GET', '/auth/me', null, lg.token);
        check('La sesión abierta deja de servir (401)', despues.status === 401, JSON.stringify(despues.datos));
      }
    }

    // 9. Bloqueo tras 5 intentos fallidos.
    const b = await crear('INSP', 'bloqueo');
    if (b.id) {
      let limiteIP = false;
      for (let i = 0; i < 5; i++) {
        const intento = await api('POST', '/auth/login', { correo: b.correo, password: 'Incorrecta*9' });
        if (intento.status === 429) { limiteIP = true; break; }
      }
      if (limiteIP) {
        console.log('  • Límite por IP activo: reinicie el servidor para volver a comprobar el bloqueo por cuenta.');
      } else {
        const [[estado]] = await conn.query('SELECT intentos_fallidos, bloqueado_hasta FROM usuarios WHERE id = ?', [b.id]);
        check('Tras 5 fallos la cuenta queda bloqueada en la base', !!estado.bloqueado_hasta, 'intentos=' + estado.intentos_fallidos);
        const conClave = await api('POST', '/auth/login', { correo: b.correo, password: 'Prueba2026*' });
        check('La cuenta bloqueada no entra ni con la clave correcta', [423, 429].includes(conClave.status), JSON.stringify(conClave.datos));
      }
    }

    // 10. El front servido es el conectado a la API (Angular compilado o prototipo).
    const html = await fetch(BASE + '/').then(r => r.text()).catch(() => '');
    check('El servidor entrega el front en la raíz', /<app-root>|api-client\.js/.test(html), html.includes('<app-root>') ? 'Angular compilado' : 'prototipo public/');

    // Limpieza de los usuarios temporales y sus rastros (la API no permite borrar con historial).
    for (const correo of correos) {
      const [[u]] = await conn.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
      if (!u) continue;
      await conn.query('DELETE FROM codigos_2fa WHERE usuario_id = ?', [u.id]);
      await conn.query('DELETE FROM recuperacion WHERE usuario_id = ?', [u.id]);
      await conn.query('DELETE FROM notificaciones WHERE usuario_id = ?', [u.id]);
      await conn.query('DELETE FROM auditoria WHERE usuario_id = ?', [u.id]);
      await conn.query('DELETE FROM usuarios WHERE id = ?', [u.id]);
    }
    ok('Limpieza de usuarios temporales');
  } catch (e) {
    mal('No se pudieron probar las reglas con la base de datos', e.message);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }

  console.log('\n' + (fallos ? `Fallaron ${fallos} comprobaciones.` : 'Todas las comprobaciones pasaron.') + '\n');
  process.exitCode = fallos ? 1 : 0;
})();

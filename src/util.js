const crypto = require('crypto');

// Enteros/decimales seguros: '' o texto no numérico -> 0
const n = v => (v === '' || v == null || isNaN(v)) ? 0 : Number(v);
const nn = v => (v === '' || v == null || isNaN(v)) ? null : Number(v);      // o null
const txt = v => (v === '' || v == null) ? null : String(v);
const json = v => JSON.stringify(v && typeof v === 'object' ? v : {});
const unjson = (v, def = {}) => { try { return v ? JSON.parse(v) : def; } catch { return def; } };

// Contraseña temporal que cumple la política del front (10+, mayúscula, minúscula, número, especial)
function claveTemporal() {
  const pick = s => s[crypto.randomInt(s.length)];
  const base = [pick('ABCDEFGHJKLMNPQRSTUVWXYZ'), pick('abcdefghijkmnpqrstuvwxyz'), pick('23456789'), pick('*#$%&!')];
  while (base.length < 12) base.push(pick('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'));
  return base.sort(() => crypto.randomInt(3) - 1).join('');
}

module.exports = { n, nn, txt, json, unjson, claveTemporal };

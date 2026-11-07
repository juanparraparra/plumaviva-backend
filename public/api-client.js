/* Cliente mínimo para hablar con la API desde el front.
   Uso:  await API.login('admin@demo.co', 'Demo2026*');  const u = await API.get('/unidades');

   Dirección de la API (en este orden):
     1. window.PV_API_URL            (si la defines antes de cargar este archivo)
     2. localStorage "pv_api"        (ej.: localStorage.setItem('pv_api', 'http://localhost:4000/api'))
     3. Si la página se abrió con doble clic (file://) o desde otro puerto (Live Server, etc.): http://localhost:3000/api
     4. Si no: /api  (la página la sirve el mismo servidor Node → http://localhost:3000)                          */
const API = (() => {
  const BASE = (() => {
    try {
      if (window.PV_API_URL) return String(window.PV_API_URL).replace(/\/$/, '');
      const guardada = localStorage.getItem('pv_api');
      if (guardada) return guardada.replace(/\/$/, '');
    } catch (e) { /* sin localStorage */ }
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (location.protocol === 'file:' || (local && location.port && location.port !== '3000')) return 'http://localhost:3000/api';
    return '/api';
  })();
  let token = null;
  try { token = sessionStorage.getItem('pv_token'); } catch (e) { /* sin sessionStorage */ }

  async function req(method, ruta, cuerpo) {
    let res;
    try {
      res = await fetch(BASE + ruta, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
      });
    } catch (e) {
      throw Object.assign(new Error(`No se pudo conectar con el servidor (${BASE}). Verifique que esté encendido (npm run dev) y abra la página desde http://localhost:3000`), { status: 0 });
    }
    const datos = await res.json().catch(() => null);
    if (res.status === 401 && token) { API.logout(); try { SES = null; } catch (e) { /* aún no existe */ } location.hash = '#/login'; }
    if (!res.ok) {
      const msg = datos && datos.error ? datos.error
        : `El servidor no respondió como API (HTTP ${res.status}). Abra la página desde http://localhost:3000 con el servidor encendido.`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return datos || {};
  }

  return {
    base: BASE,
    async login(correo, password) {
      const r = await req('POST', '/auth/login', { correo, password });
      token = r.token; try { sessionStorage.setItem('pv_token', token); } catch (e) { /* ignorar */ }
      return r.usuario;
    },
    logout() { token = null; try { sessionStorage.removeItem('pv_token'); } catch (e) { /* ignorar */ } },
    get: r => req('GET', r),
    post: (r, b) => req('POST', r, b),
    put: (r, b) => req('PUT', r, b),
    patch: (r, b) => req('PATCH', r, b)
  };
})();

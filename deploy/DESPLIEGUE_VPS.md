# Despliegue del backend en la VPS (Ubuntu/Debian)

El front vive en Firebase Hosting (`https://pluma-viva-a3369.web.app`); la VPS solo expone la API por HTTPS.

## 0. Requisitos en la VPS
- Node.js 18 o superior, MariaDB/MySQL, puertos **80 y 443** abiertos (además del 22 para SSH).
- El puerto 3000 NO debe quedar abierto a internet: solo lo usa Caddy desde la misma máquina.

## 1. Subir el backend
Copie la carpeta `plumaviva-backend-main` a la VPS (por ejemplo a `/opt/plumaviva`), sin `node_modules`:
```
scp -r plumaviva-backend-main usuario@135.148.46.133:/opt/plumaviva
```

## 2. Base de datos
En la VPS, como administrador de MySQL:
```
sudo mysql -e "CREATE DATABASE IF NOT EXISTS plumaviva CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'plumaviva_app'@'localhost' IDENTIFIED BY 'CLAVE_DEL_ENV';
GRANT ALL PRIVILEGES ON plumaviva.* TO 'plumaviva_app'@'localhost'; FLUSH PRIVILEGES;"
```
`CLAVE_DEL_ENV` debe ser la misma de `DB_PASSWORD` en el `.env`.

## 3. Variables de entorno
Copie `backend.env` como `/opt/plumaviva/.env` (permisos restringidos: `chmod 600 .env`).

## 4. Instalar y crear tablas
```
cd /opt/plumaviva
npm ci --omit=dev
npm run setup
```
`setup` crea las tablas y **carga usuarios de demostración con la clave pública `Demo2026*`**. Asegure la base de inmediato:
```
npm run asegurar:produccion -- admin@demo.co "SuClaveSegura*2026"
```
Esto fija la clave real del administrador y deja a los demás usuarios con claves aleatorias. Para dar acceso a otro usuario:
```
npm run user:password -- correo@ejemplo.com "ClaveNueva*2026"
```

## 5. Dejarlo siempre encendido (pm2)
```
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # ejecute la línea que muestre
```
Comandos útiles: `pm2 logs plumaviva`, `pm2 restart plumaviva`.

## 6. HTTPS con Caddy
```
sudo apt update && sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
Compruebe: `https://135-148-46-133.sslip.io/api/health` debe responder `{"ok":true,"db":"conectada"}`.

## 7. Firewall (ufw)
```
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## Si algo falla
| Síntoma | Qué revisar |
|---|---|
| `health` no responde | `pm2 logs plumaviva`; que el `.env` tenga `DB_PASSWORD` correcta |
| Caddy no obtiene certificado | puertos 80/443 abiertos; `sudo journalctl -u caddy -n 50` |
| En el navegador: error de CORS | `CORS_ORIGINS` en `.env` y `pm2 restart plumaviva --update-env` |
| Login responde 401 | clave del usuario; use `npm run user:password` |
| Login responde 423 | cuenta bloqueada 15 min por intentos fallidos |

## Notas de seguridad
- Este backend tiene desactivados el correo, el 2FA y la recuperación de clave: el login entrega el token directo. Reactívelos antes de un uso real con datos sensibles.
- Haga copias de seguridad periódicas: `mysqldump plumaviva > respaldo.sql`.
- No suba `.env` a GitHub.

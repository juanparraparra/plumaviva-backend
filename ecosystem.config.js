// Procesos de pm2:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'plumaviva',
    script: 'src/server.js',
    env: { NODE_ENV: 'production' },   // el resto de variables se lee de .env
    max_memory_restart: '400M',
    time: true
  }]
};

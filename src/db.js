const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'plumaviva',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,        // fechas como 'YYYY-MM-DD', igual que el front
  charset: 'utf8mb4'
});

module.exports = pool;

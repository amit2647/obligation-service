const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "customer_management",
  user: process.env.DB_USER || "app_user",
  password: process.env.DB_PASSWORD || "app_password",
});

module.exports = pool;

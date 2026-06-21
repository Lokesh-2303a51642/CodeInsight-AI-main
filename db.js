const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP,
      reset_token VARCHAR(255),
      reset_token_expiry TIMESTAMP,
      theme VARCHAR(10) DEFAULT 'dark'
    );

    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      errors_explained INTEGER DEFAULT 0,
      code_analyses INTEGER DEFAULT 0,
      code_reviews INTEGER DEFAULT 0,
      ai_chats INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      input_text TEXT,
      output_text TEXT,
      language VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Database schema ready");
}

module.exports = { pool, initSchema };

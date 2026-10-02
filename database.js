const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'test.db');
let db = null;

// 保存数据库到文件
function save() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch(e) {
    console.error('保存数据库失败:', e.message);
  }
}

// 封装prepare，提供与better-sqlite3兼容的API
function prepare(sql) {
  return {
    get(...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        if (stmt.step()) {
          return stmt.getAsObject();
        }
        return undefined;
      } finally {
        stmt.free();
      }
    },
    all(...params) {
      const stmt = db.prepare(sql);
      const results = [];
      try {
        stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
      } finally {
        stmt.free();
      }
      return results;
    },
    run(...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        stmt.step();
      } catch(e) {
        // 忽略重复插入等错误
      } finally {
        stmt.free();
      }
      save();
      let lastId = 0;
      try {
        const res = db.exec("SELECT last_insert_rowid() as id");
        lastId = res[0]?.values[0]?.[0] || 0;
      } catch(e) {}
      return { lastInsertRowid: lastId, changes: db.getRowsModified() };
    }
  };
}

async function initDatabase() {
  const SQL = await initSqlJs();

  // 确保data目录存在
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 从文件加载或创建新数据库
  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      console.log('数据库已从文件加载');
    } catch(e) {
      console.log('数据库文件损坏，创建新数据库:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log('创建新数据库');
  }

  // 添加兼容方法
  db.prepare = prepare;
  db._save = save;

  // 初始化表
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      questionnaire_key TEXT DEFAULT 'mbti16stage',
      status TEXT DEFAULT 'can_activate',
      device_fingerprint TEXT,
      device_info TEXT,
      activated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      use_count INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS test_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auth_code TEXT NOT NULL,
      questionnaire_key TEXT DEFAULT 'mbti16stage',
      mbti_type TEXT,
      answers TEXT,
      scores TEXT,
      total_score INTEGER,
      stage TEXT,
      device_fingerprint TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      fingerprint TEXT PRIMARY KEY,
      user_agent TEXT,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      test_count INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 创建默认管理员
  const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', hash);
    console.log('默认管理员已创建: admin / admin123');
  }

  // 创建索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_auth_codes_device ON auth_codes(device_fingerprint);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_records_code ON test_records(auth_code);');

  save();
  console.log('数据库初始化完成');
  return db;
}

module.exports = { initDatabase };

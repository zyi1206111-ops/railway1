const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'db.json');
let data = null;

// 加载数据
function load() {
  if (fs.existsSync(dbPath)) {
    try {
      data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch(e) {
      data = getEmptyData();
    }
  } else {
    data = getEmptyData();
  }
}

function getEmptyData() {
  return {
    auth_codes: [],
    test_records: [],
    devices: [],
    admins: [],
    _counters: { auth_codes: 0, test_records: 0, admins: 0 }
  };
}

// 保存数据
function save() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('保存数据失败:', e.message);
  }
}

// 解析WHERE条件
function parseWhere(whereStr, params) {
  if (!whereStr || whereStr.trim() === '1=1') return () => true;
  
  let paramIdx = 0;
  const conditions = [];
  
  // 分割AND（注意不要分割字符串里的AND）
  const parts = whereStr.split(/\s+AND\s+/i);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '1=1') continue;
    
    // LIKE 条件
    const likeMatch = trimmed.match(/^(\w+)\s+LIKE\s+\?$/i);
    if (likeMatch) {
      const col = likeMatch[1];
      const val = params[paramIdx++];
      const pattern = val.replace(/%/g, '.*');
      conditions.push(row => new RegExp('^' + pattern + '$', 'i').test(String(row[col] || '')));
      continue;
    }
    
    // 等于条件 col = ?
    const eqMatch = trimmed.match(/^(\w+)\s*=\s*\?$/);
    if (eqMatch) {
      const col = eqMatch[1];
      const val = params[paramIdx++];
      conditions.push(row => row[col] == val);
      continue;
    }
    
    // 等于条件 col = 'value' 或 col = number
    const eqValMatch = trimmed.match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (eqValMatch) {
      const col = eqValMatch[1];
      const val = eqValMatch[2];
      conditions.push(row => row[col] == val);
      continue;
    }
    
    const eqNumMatch = trimmed.match(/^(\w+)\s*=\s*(\d+)$/);
    if (eqNumMatch) {
      const col = eqNumMatch[1];
      const val = parseInt(eqNumMatch[2]);
      conditions.push(row => row[col] == val);
      continue;
    }
    
    // DATE(col) = ?
    const dateMatch = trimmed.match(/^DATE\((\w+)\)\s*=\s*\?$/i);
    if (dateMatch) {
      const col = dateMatch[1];
      const val = params[paramIdx++];
      conditions.push(row => {
        const d = row[col] ? String(row[col]).split('T')[0].split(' ')[0] : '';
        return d === val;
      });
      continue;
    }
  }
  
  return row => conditions.every(c => c(row));
}

// 解析ORDER BY
function parseOrderBy(orderStr) {
  if (!orderStr) return null;
  const m = orderStr.match(/(\w+)\s*(ASC|DESC)?/i);
  if (m) {
    return { col: m[1], desc: m[2]?.toUpperCase() === 'DESC' };
  }
  return null;
}

// 执行SELECT
function execSelect(sql, params) {
  // 解析 SELECT columns FROM table [WHERE ...] [ORDER BY ...] [LIMIT n] [OFFSET n]
  const fromMatch = sql.match(/FROM\s+(\w+)/i);
  if (!fromMatch) return [];
  const table = fromMatch[1];
  const rows = data[table] || [];
  
  // WHERE
  let filtered = rows;
  const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:ORDER|LIMIT|$)/i);
  if (whereMatch) {
    const filter = parseWhere(whereMatch[1].trim().replace(/\s+/g, ' '), params);
    filtered = rows.filter(filter);
  }
  
  // ORDER BY
  const orderMatch = sql.match(/ORDER\s+BY\s+([\s\S]+?)(?:LIMIT|$)/i);
  if (orderMatch) {
    const order = parseOrderBy(orderMatch[1].trim().replace(/\s+/g, ' '));
    if (order) {
      filtered.sort((a, b) => {
        const va = a[order.col], vb = b[order.col];
        if (va < vb) return order.desc ? 1 : -1;
        if (va > vb) return order.desc ? -1 : 1;
        return 0;
      });
    }
  }
  
  // LIMIT / OFFSET
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
  const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
  if (limitMatch) {
    const limit = parseInt(limitMatch[1]);
    const offset = offsetMatch ? parseInt(offsetMatch[1]) : 0;
    filtered = filtered.slice(offset, offset + limit);
  }
  
  // 处理 COUNT(*)
  if (/COUNT\(\*\)\s+as\s+(\w+)/i.test(sql)) {
    const alias = sql.match(/COUNT\(\*\)\s+as\s+(\w+)/i)[1];
    return [{ [alias]: filtered.length }];
  }
  
  return filtered;
}

// 执行INSERT
function execInsert(sql, params) {
  // INSERT [OR IGNORE|OR REPLACE] INTO table (cols) VALUES (?,?)
  const ignore = /OR\s+IGNORE/i.test(sql);
  const replace = /OR\s+REPLACE/i.test(sql);
  
  const tableMatch = sql.match(/INTO\s+(\w+)/i);
  const colsMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
  if (!tableMatch || !colsMatch) return { changes: 0, lastInsertRowid: 0 };
  
  const table = tableMatch[1];
  const cols = colsMatch[1].split(',').map(c => c.trim());
  
  if (!data[table]) data[table] = [];
  if (!data._counters[table]) data._counters[table] = 0;
  
  // 检查唯一约束（code字段）
  if (ignore && cols.includes('code')) {
    const codeIdx = cols.indexOf('code');
    const codeVal = params[codeIdx];
    if (data[table].some(r => r.code === codeVal)) {
      return { changes: 0, lastInsertRowid: 0 };
    }
  }
  
  // REPLACE：先删旧记录
  if (replace && cols.includes('fingerprint')) {
    const fpIdx = cols.indexOf('fingerprint');
    const fpVal = params[fpIdx];
    data[table] = data[table].filter(r => r.fingerprint !== fpVal);
  }
  
  // 构建新记录
  const row = { id: ++data._counters[table] };
  let paramIdx = 0;
  for (const col of cols) {
    let val = params[paramIdx++];
    // 处理 CURRENT_TIMESTAMP
    if (val === undefined && sql.includes('CURRENT_TIMESTAMP')) {
      // 检查这一列是否有默认值
    }
    row[col] = val;
  }
  
  // 处理默认值 created_at
  if (cols.includes('created_at') && !row.created_at) {
    row.created_at = new Date().toISOString();
  }
  if (!row.created_at && table === 'auth_codes') {
    row.created_at = new Date().toISOString();
  }
  
  // 表特定默认值
  if (table === 'auth_codes') {
    if (!row.status) row.status = 'can_activate';
    if (row.use_count === undefined) row.use_count = 0;
    if (row.revoked === undefined) row.revoked = 0;
    if (!row.questionnaire_key) row.questionnaire_key = 'mbti16stage';
  }
  if (table === 'devices') {
    if (!row.first_seen) row.first_seen = new Date().toISOString();
    if (!row.last_seen) row.last_seen = new Date().toISOString();
    if (row.test_count === undefined) row.test_count = 0;
  }
  if (table === 'test_records') {
    if (!row.created_at) row.created_at = new Date().toISOString();
  }
  
  data[table].push(row);
  save();
  return { changes: 1, lastInsertRowid: row.id };
}

// 执行UPDATE
function execUpdate(sql, params) {
  // UPDATE table SET col = ?, col2 = ? WHERE ...
  const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
  const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
  if (!tableMatch || !setMatch) return { changes: 0 };
  
  const table = tableMatch[1];
  const setStr = setMatch[1].replace(/\s+/g, ' ').trim();
  const whereMatch = sql.match(/WHERE\s+([\s\S]+)$/i);
  
  // 解析SET子句
  const setParts = setStr.split(',').map(s => s.trim());
  const assignments = [];
  let paramIdx = 0;
  
  for (const part of setParts) {
    // col = ?
    const m = part.match(/^(\w+)\s*=\s*\?$/);
    if (m) {
      assignments.push({ col: m[1], value: params[paramIdx++] });
      continue;
    }
    // col = CURRENT_TIMESTAMP
    const tsMatch = part.match(/^(\w+)\s*=\s*CURRENT_TIMESTAMP$/i);
    if (tsMatch) {
      assignments.push({ col: tsMatch[1], value: new Date().toISOString() });
      continue;
    }
    // col = col + 1
    const incMatch = part.match(/^(\w+)\s*=\s*\w+\s*\+\s*(\d+)$/i);
    if (incMatch) {
      assignments.push({ col: incMatch[1], increment: parseInt(incMatch[2]) });
      continue;
    }
    // col = 'value'
    const strMatch = part.match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (strMatch) {
      assignments.push({ col: strMatch[1], value: strMatch[2] });
      continue;
    }
    // col = number
    const numMatch = part.match(/^(\w+)\s*=\s*(\d+)$/);
    if (numMatch) {
      assignments.push({ col: numMatch[1], value: parseInt(numMatch[2]) });
      continue;
    }
  }
  
  // 筛选要更新的行
  let rows = data[table] || [];
  if (whereMatch) {
    const filter = parseWhere(whereMatch[1].trim().replace(/\s+/g, ' '), params.slice(paramIdx));
    rows = rows.filter(filter);
  }
  
  for (const row of rows) {
    for (const a of assignments) {
      if (a.increment) {
        row[a.col] = (row[a.col] || 0) + a.increment;
      } else {
        row[a.col] = a.value;
      }
    }
  }
  
  if (rows.length > 0) save();
  return { changes: rows.length };
}

// prepare兼容层
function prepare(sql) {
  return {
    get(...params) {
      if (/^SELECT/i.test(sql.trim())) {
        const results = execSelect(sql, params);
        return results[0];
      }
      return undefined;
    },
    all(...params) {
      if (/^SELECT/i.test(sql.trim())) {
        return execSelect(sql, params);
      }
      return [];
    },
    run(...params) {
      const trimmed = sql.trim();
      if (/^INSERT/i.test(trimmed)) {
        return execInsert(trimmed, params);
      }
      if (/^UPDATE/i.test(trimmed)) {
        return execUpdate(trimmed, params);
      }
      return { changes: 0, lastInsertRowid: 0 };
    }
  };
}

function exec(sql) {
  // CREATE TABLE / CREATE INDEX 直接忽略，JSON不需要
  return;
}

function initDatabase() {
  load();
  
  // 创建默认管理员
  if (!data.admins || data.admins.length === 0) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    data._counters.admins = (data._counters.admins || 0) + 1;
    data.admins.push({
      id: data._counters.admins,
      username: 'admin',
      password: hash,
      created_at: new Date().toISOString()
    });
    console.log('默认管理员已创建: admin / admin123');
  }
  
  save();
  console.log('数据库初始化完成（JSON文件存储）');
  
  return Promise.resolve({
    prepare,
    exec,
    _save: save
  });
}

module.exports = { initDatabase };

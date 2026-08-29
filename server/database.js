const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 确保数据目录存在
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let _db = null;

/**
 * sql.js 兼容层，模拟 better-sqlite3 的 API
 */
class DatabaseWrapper {
  constructor(sqliteDb) {
    this._db = sqliteDb;
  }

  exec(sql) {
    this._db.run(sql);
  }

  pragma(str) {
    try { this._db.run(`PRAGMA ${str}`); } catch {}
  }

  prepare(sql) {
    const db = this._db;
    // sql.js 不接受 undefined 绑定值，统一转为 null（与 SQLite 语义一致）
    const sanitize = params => params.map(p => (p === undefined ? null : p));
    return {
      get(...rawParams) {
        const params = sanitize(rawParams);
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...rawParams) {
        const params = sanitize(rawParams);
        const results = [];
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run(...rawParams) {
        const params = sanitize(rawParams);
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        stmt.step();
        stmt.free();
        const changes = db.getRowsModified();
        let lastInsertRowid = 0;
        if (changes > 0) {
          const lastId = db.exec("SELECT last_insert_rowid()");
          lastInsertRowid = lastId[0]?.values[0]?.[0] ?? 0;
        }
        return { changes, lastInsertRowid };
      },
    };
  }

  /**
   * 事务支持
   */
  transaction(fn) {
    this._db.run('BEGIN TRANSACTION');
    try {
      const result = fn();
      this._db.run('COMMIT');
      return result;
    } catch (err) {
      this._db.run('ROLLBACK');
      throw err;
    }
  }

  /**
   * 原子化落盘：
   * 1. 先写入同目录临时文件（xxx.db.tmp）
   * 2. 将当前库文件复制一份为 .bak（备份允许短暂撕裂，仅作恢复用）
   * 3. rename 覆盖目标文件（同文件系统上 rename 是原子操作）
   * 断电/强杀最坏情况：目标文件是上一次完整保存的版本，且还有 .bak 可恢复
   */
  save() {
    const data = this._db.export();
    const buffer = Buffer.from(data);
    const tmpPath = config.dbPath + '.tmp';
    const bakPath = config.dbPath + '.bak';
    fs.writeFileSync(tmpPath, buffer);
    try {
      if (fs.existsSync(config.dbPath)) {
        fs.copyFileSync(config.dbPath, bakPath);
      }
      fs.renameSync(tmpPath, config.dbPath);
    } catch (err) {
      // rename 失败（如跨设备）时退化为直接覆盖，尽量保证数据落地
      try {
        fs.writeFileSync(config.dbPath, buffer);
        fs.rmSync(tmpPath, { force: true });
      } catch (inner) {
        throw inner;
      }
      throw err;
    }
  }
}

/**
 * 初始化数据库
 */
async function initDatabase() {
  const SQL = await initSqlJs();

  let sqliteDb;
  if (fs.existsSync(config.dbPath)) {
    const fileBuffer = fs.readFileSync(config.dbPath);
    sqliteDb = new SQL.Database(fileBuffer);
  } else {
    sqliteDb = new SQL.Database();
  }

  _db = new DatabaseWrapper(sqliteDb);
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS storage_configs (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      config      TEXT NOT NULL,
      endpoint    TEXT,
      status      INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT (datetime('now','localtime')),
      updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id              INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      slug            TEXT NOT NULL UNIQUE,
      description     TEXT,
      storage_id      INTEGER NOT NULL,
      storage_path    TEXT NOT NULL,
      status          INTEGER DEFAULT 1,
      cache_ttl       INTEGER DEFAULT 300,
      created_at      DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (storage_id) REFERENCES storage_configs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS images (
      id              INTEGER PRIMARY KEY,
      category_id     INTEGER NOT NULL,
      filename        TEXT NOT NULL,
      storage_key     TEXT NOT NULL,
      url             TEXT NOT NULL,
      size            INTEGER DEFAULT 0,
      width           INTEGER DEFAULT 0,
      height          INTEGER DEFAULT 0,
      mime_type       TEXT,
      created_at      DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_images_category ON images(category_id);
  `);

  // 迁移：对已有 AUTOINCREMENT 的表重建（SQLite 不支持 ALTER TABLE DROP AUTOINCREMENT）
  _migrateRemoveAutoincrement(_db);

  // 迁移：为 (category_id, storage_key) 建唯一约束（配合 INSERT OR IGNORE 防止重复同步）
  _migrateUniqueStorageKey(_db);

  // 索引：大分类随机取图用（按 id 范围定位）
  _db.exec('CREATE INDEX IF NOT EXISTS idx_images_cat_id ON images(category_id, id)');

  return _db;
}

/**
 * 迁移：移除已有表的 AUTOINCREMENT
 * SQLite 不支持 ALTER TABLE DROP AUTOINCREMENT，需要重建表
 * 只在 sqlite_sequence 表存在时执行（说明有旧的 AUTOINCREMENT 表）
 */
function _migrateRemoveAutoincrement(db) {
  try {
    // 检查是否存在 sqlite_sequence（有 AUTOINCREMENT 时才会存在）
    const seqTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
    if (!seqTable) return; // 已经没有 AUTOINCREMENT，跳过

    const tables = ['storage_configs', 'categories', 'images'];
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    for (const table of tables) {
      // 检查建表语句是否包含 AUTOINCREMENT
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!row || !row.sql || !row.sql.includes('AUTOINCREMENT')) continue;

      // 获取表结构
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
      const columnDefs = columns.map(c => {
        let def = `"${c.name}" ${c.type}`;
        if (c.notnull) def += ' NOT NULL';
        if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
        if (c.pk) def += ' PRIMARY KEY'; // 不再带 AUTOINCREMENT
        return def;
      }).join(', ');

      // 获取外键
      const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
      const fkClauses = fks.map(fk => {
        // ON UPDATE 和 ON DELETE
        let clause = `FOREIGN KEY ("${fk.from}") REFERENCES "${fk.table}"("${fk.to}")`;
        if (fk.on_delete && fk.on_delete !== 'NO ACTION') clause += ` ON DELETE ${fk.on_delete}`;
        if (fk.on_update && fk.on_update !== 'NO ACTION') clause += ` ON UPDATE ${fk.on_update}`;
        return clause;
      });

      // 获取索引（排除自动创建的主键索引和内部自动索引）
      const indexes = db.prepare(`PRAGMA index_list("${table}")`).all();
      const indexDefs = [];
      for (const idx of indexes) {
        if (idx.origin === 'pk') continue; // 跳过主键索引
        if (idx.name.startsWith('sqlite_autoindex_')) continue; // 跳过UNIQUE约束自动生成的内部索引
        const idxInfo = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
        const cols = idxInfo.map(c => `"${c.name}"`).join(', ');
        indexDefs.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idx.name}" ON "${table}" (${cols})`);
      }

      // 重建表
      const tempTable = `${table}_old_${Date.now()}`;

      // 1. 重命名旧表
      db.exec(`ALTER TABLE "${table}" RENAME TO "${tempTable}"`);

      // 2. 创建新表（无 AUTOINCREMENT）
      // 需要从原始 CREATE TABLE 语句中提取完整定义
      const origSql = row.sql;
      const newSql = origSql.replace(/AUTOINCREMENT/gi, '');
      db.exec(newSql);

      // 3. 复制数据
      const colNames = columns.map(c => `"${c.name}"`).join(', ');
      db.exec(`INSERT INTO "${table}" (${colNames}) SELECT ${colNames} FROM "${tempTable}"`);

      // 4. 重建索引
      for (const idxSql of indexDefs) {
        db.exec(idxSql);
      }

      // 5. 删除旧表
      db.exec(`DROP TABLE "${tempTable}"`);
    }

    // 清理 sqlite_sequence
    db.exec('DELETE FROM sqlite_sequence');

    db.exec('COMMIT');
    db.pragma('foreign_keys = ON');
    console.log('[DB Migration] AUTOINCREMENT 已移除，ID 现在可复用');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    db.pragma('foreign_keys = ON');
    console.error('[DB Migration] 移除 AUTOINCREMENT 失败（非致命，将继续启动）:', err.message);
  }
}

/**
 * 迁移：为 images(category_id, storage_key) 建唯一索引
 * 老库中若已存在重复数据，先按保留最小 rowid 的策略去重
 */
function _migrateUniqueStorageKey(db) {
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_images_unique_key'").get();
    if (exists) return;

    const dupCount = db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT category_id, storage_key FROM images
        GROUP BY category_id, storage_key HAVING COUNT(*) > 1
      )
    `).get().count;
    if (dupCount > 0) {
      db.exec(`
        DELETE FROM images WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM images GROUP BY category_id, storage_key
        )
      `);
      console.log(`[DB Migration] 已去重 ${dupCount} 组重复图片记录`);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_unique_key ON images(category_id, storage_key)');
    console.log('[DB Migration] 已创建 images(category_id, storage_key) 唯一索引');
  } catch (err) {
    console.error('[DB Migration] 创建唯一索引失败（非致命，将继续启动）:', err.message);
  }
}

function getDb() {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

let _autoSaveTimer = null;

function startAutoSave() {
  // 清除旧定时器（如果有的话）
  if (_autoSaveTimer) {
    clearInterval(_autoSaveTimer);
  }
  const interval = config.autoSaveInterval * 1000;
  _autoSaveTimer = setInterval(() => {
    if (_db) {
      try { _db.save(); } catch (e) { console.error('[DB Save Error]', e.message); }
    }
  }, interval);
  console.log(`[DB] 自动保存已启动，间隔 ${config.autoSaveInterval} 秒`);
}

function stopAutoSave() {
  if (_autoSaveTimer) {
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;
  }
}

module.exports = { initDatabase, getDb, startAutoSave, stopAutoSave };

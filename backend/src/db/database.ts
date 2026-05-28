import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", "..", "data");
const DB_PATH = join(DB_DIR, "interview.db");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

// ─── Persistence helpers ──────────────────────────────────────
let _dirty = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(sqlDb: SqlJsDatabase) {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    flushSave(sqlDb);
  }, 2000);
}

function flushSave(sqlDb: SqlJsDatabase) {
  if (!_dirty) return;
  try {
    const data = sqlDb.export();
    writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch (err) {
    console.error("[DB] Failed to save:", err);
  }
}

// ─── better-sqlite3 compatible wrapper ────────────────────────
interface BetterStmt {
  get: (...args: any[]) => any;
  all: (...args: any[]) => any[];
  run: (...args: any[]) => { changes: number; lastInsertRowid: number };
}

function wrapStmt(sqlDb: SqlJsDatabase, sql: string): BetterStmt {
  return {
    get(...args: any[]): any {
      const stmt = sqlDb.prepare(sql);
      try {
        if (args.length > 0) stmt.bind(args);
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally {
        stmt.free();
      }
    },
    all(...args: any[]): any[] {
      const stmt = sqlDb.prepare(sql);
      try {
        if (args.length > 0) stmt.bind(args);
        const results: any[] = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        return results;
      } finally {
        stmt.free();
      }
    },
    run(...args: any[]) {
      sqlDb.run(sql, args);
      const changes = sqlDb.getRowsModified();
      scheduleSave(sqlDb);
      return { changes, lastInsertRowid: 0 };
    },
  };
}

interface BetterDb {
  prepare: (sql: string) => BetterStmt;
  exec: (sql: string) => void;
  close: () => void;
}

function createProxy(sqlDb: SqlJsDatabase): BetterDb {
  return {
    prepare: (sql: string) => wrapStmt(sqlDb, sql),
    exec: (sql: string) => {
      sqlDb.exec(sql);
      scheduleSave(sqlDb);
    },
    close: () => {
      flushSave(sqlDb);
      sqlDb.close();
    },
  };
}

// ─── Schema SQL ───────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    avatar      TEXT,
    plan        TEXT NOT NULL DEFAULT 'free',
    language    TEXT NOT NULL DEFAULT 'zh_CN',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resumes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    file_path       TEXT,
    parsed_content  TEXT,
    skills          TEXT DEFAULT '[]',
    experience      TEXT DEFAULT '[]',
    parse_status    TEXT NOT NULL DEFAULT 'pending',
    uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company     TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',
    resume_id   TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    transcript  TEXT DEFAULT '[]',
    suggestions TEXT DEFAULT '[]',
    analysis    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`;

// ─── Async initialization ─────────────────────────────────────
async function initDatabase(): Promise<BetterDb> {
  const SQL = await initSqlJs();

  let sqlDb: SqlJsDatabase;
  if (existsSync(DB_PATH)) {
    try {
      const buffer = readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buffer);
      console.log(`[DB] Loaded existing database from ${DB_PATH}`);
    } catch {
      console.log("[DB] Existing database corrupted, creating fresh");
      sqlDb = new SQL.Database();
    }
  } else {
    sqlDb = new SQL.Database();
    console.log(`[DB] Created new database at ${DB_PATH}`);
  }

  sqlDb.exec("PRAGMA foreign_keys = ON");
  sqlDb.exec(SCHEMA_SQL);

  const proxy = createProxy(sqlDb);

  // Save on process exit
  const onExit = () => flushSave(sqlDb);
  process.on("exit", onExit);
  process.on("SIGINT", () => { flushSave(sqlDb); process.exit(); });
  process.on("SIGTERM", () => { flushSave(sqlDb); process.exit(); });

  return proxy;
}

// Module-level promise — importers must await before using db
export const dbReady = initDatabase();

// Synchronous reference, assigned after init.
// Safe to use in Express route handlers (they run after server startup).
export let db: BetterDb = null as any;

dbReady.then((d) => { db = d; });

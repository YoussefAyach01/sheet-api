import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('free','pro','business')),
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      manage_hash TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      owner_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
      plan TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      columns_json TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_key_id);
    CREATE INDEX IF NOT EXISTS projects_exp ON projects(expires_at);
    CREATE TABLE IF NOT EXISTS rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rows_project ON rows(project_id, seq);
  `);
  return db;
}

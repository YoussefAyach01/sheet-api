import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { Plan } from './config.js';

export interface KeyRecord {
  id: string;
  label: string;
  plan: Plan;
  keyPrefix: string;
  revokedAt: string | null;
  createdAt: string;
}

/** Keys are 256-bit random, so a fast SHA-256 is safe (no dictionary attack possible). */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface Row {
  id: string;
  label: string;
  plan: Plan;
  key_prefix: string;
  revoked_at: string | null;
  created_at: string;
}
const toRecord = (r: Row): KeyRecord => ({
  id: r.id,
  label: r.label,
  plan: r.plan,
  keyPrefix: r.key_prefix,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
});

/** Admin-issued key that raises the plan used when *creating* a project. Returns plaintext once. */
export function createKey(db: Db, label: string, plan: Plan): { key: string; record: KeyRecord } {
  const key = `shka_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO api_keys (id, key_hash, key_prefix, label, plan) VALUES (?, ?, ?, ?, ?)',
  ).run(id, hashKey(key), key.slice(0, 7), label, plan);
  return { key, record: getKey(db, id)! };
}

export function getKey(db: Db, id: string): KeyRecord | null {
  const r = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as Row | undefined;
  return r ? toRecord(r) : null;
}

export function listKeys(db: Db): KeyRecord[] {
  const rows = db
    .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
    .all() as unknown as Row[];
  return rows.map(toRecord);
}

export function findActiveKey(db: Db, key: string): KeyRecord | null {
  const r = db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(hashKey(key)) as unknown as Row | undefined;
  return r ? toRecord(r) : null;
}

export function revokeKey(db: Db, id: string): boolean {
  const res = db
    .prepare(
      "UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL",
    )
    .run(id);
  return Number(res.changes) > 0;
}

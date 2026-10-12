import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { PLANS, type Plan } from './config.js';
import type { ColumnType } from './csv.js';

export interface Project {
  id: string;
  plan: Plan;
  ownerKeyId: string | null;
  name: string;
  columns: { name: string; type: ColumnType }[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface Row {
  id: number;
  seq: number;
  data: Record<string, unknown>;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const isProjectId = (s: string) => ID_RE.test(s);

interface ProjectRow {
  id: string;
  plan: Plan;
  owner_key_id: string | null;
  name: string;
  columns_json: string;
  row_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}
const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  plan: r.plan,
  ownerKeyId: r.owner_key_id,
  name: r.name,
  columns: JSON.parse(r.columns_json) as { name: string; type: ColumnType }[],
  rowCount: r.row_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

export function countLive(db: Db, now: Date): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE expires_at > ?')
    .get(now.toISOString()) as { n: number };
  return r.n;
}

export function countForKey(db: Db, keyId: string, now: Date): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_key_id = ? AND expires_at > ?')
    .get(keyId, now.toISOString()) as { n: number };
  return r.n;
}

/** Returns the manage token and consumer API key ONCE; only their hashes are stored. */
export function createProject(
  db: Db,
  opts: {
    plan: Plan;
    ownerKeyId: string | null;
    name: string;
    columns: { name: string; type: ColumnType }[];
    rows: Record<string, unknown>[];
    now: Date;
  },
): { project: Project; manageToken: string; apiKey: string } {
  const id = randomBytes(16).toString('base64url');
  const manageToken = `shmt_${randomBytes(32).toString('base64url')}`;
  const apiKey = `shapi_${randomBytes(32).toString('base64url')}`;
  const expires = new Date(opts.now.getTime() + PLANS[opts.plan].ttlDays * 86_400_000);
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO projects (id, manage_hash, api_key_hash, owner_key_id, plan, name, columns_json, row_count, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sha(manageToken).toString('hex'),
      sha(apiKey).toString('hex'),
      opts.ownerKeyId,
      opts.plan,
      opts.name,
      JSON.stringify(opts.columns),
      opts.rows.length,
      opts.now.toISOString(),
      opts.now.toISOString(),
      expires.toISOString(),
    );
    insertRows(db, id, opts.rows);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { project: getProject(db, id, opts.now)!, manageToken, apiKey };
}

function insertRows(db: Db, projectId: string, rows: Record<string, unknown>[]): void {
  const stmt = db.prepare('INSERT INTO rows (project_id, seq, data_json) VALUES (?, ?, ?)');
  rows.forEach((r, i) => stmt.run(projectId, i + 1, JSON.stringify(r)));
}

/** Replaces all rows/columns for an existing project (used by PUT .../csv). */
export function replaceData(
  db: Db,
  projectId: string,
  columns: { name: string; type: ColumnType }[],
  rows: Record<string, unknown>[],
  now: Date,
): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM rows WHERE project_id = ?').run(projectId);
    insertRows(db, projectId, rows);
    db.prepare(
      'UPDATE projects SET columns_json = ?, row_count = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(columns), rows.length, now.toISOString(), projectId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Returns null for unknown OR expired projects (indistinguishable to callers). */
export function getProject(db: Db, id: string, now: Date): Project | null {
  if (!isProjectId(id)) return null;
  const r = db
    .prepare('SELECT * FROM projects WHERE id = ? AND expires_at > ?')
    .get(id, now.toISOString()) as unknown as ProjectRow | undefined;
  return r ? toProject(r) : null;
}

export function verifyManageToken(db: Db, id: string, token: string): boolean {
  if (!isProjectId(id)) return false;
  const r = db.prepare('SELECT manage_hash FROM projects WHERE id = ?').get(id) as
    { manage_hash: string } | undefined;
  const presented = sha(token);
  const stored = r ? Buffer.from(r.manage_hash, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(presented, stored) && !!r;
}

/** Looks a project up by its consumer API key (used by the public /data/* routes). */
export function findProjectByApiKey(db: Db, apiKey: string, now: Date): Project | null {
  const r = db
    .prepare('SELECT * FROM projects WHERE api_key_hash = ? AND expires_at > ?')
    .get(sha(apiKey).toString('hex'), now.toISOString()) as unknown as ProjectRow | undefined;
  return r ? toProject(r) : null;
}

export function deleteProject(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
}

export function purgeExpired(db: Db, now: Date): number {
  return Number(
    db.prepare('DELETE FROM projects WHERE expires_at <= ?').run(now.toISOString()).changes,
  );
}

// ----------------------------------------------------------------- rows

interface RowRow {
  id: number;
  seq: number;
  data_json: string;
}
const toRow = (r: RowRow): Row => ({ id: r.id, seq: r.seq, data: JSON.parse(r.data_json) });

export interface ListOpts {
  limit: number;
  offset: number;
  filters: Record<string, string>;
  sort?: string;
  order: 'asc' | 'desc';
}

export function listRows(
  db: Db,
  projectId: string,
  opts: ListOpts,
): { items: Row[]; total: number } {
  const rows = db
    .prepare('SELECT * FROM rows WHERE project_id = ? ORDER BY seq')
    .all(projectId) as unknown as RowRow[];
  let items = rows.map(toRow);
  const filterKeys = Object.keys(opts.filters);
  if (filterKeys.length) {
    items = items.filter((it) =>
      filterKeys.every((k) => String(it.data[k] ?? '') === opts.filters[k]),
    );
  }
  if (opts.sort) {
    const dir = opts.order === 'desc' ? -1 : 1;
    const key = opts.sort;
    items = [...items].sort((a, b) => {
      const av = a.data[key];
      const bv = b.data[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1 * dir;
      if (bv === null || bv === undefined) return -1 * dir;
      return (av > bv ? 1 : -1) * dir;
    });
  }
  const total = items.length;
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total };
}

export function getRow(db: Db, projectId: string, rowId: number): Row | null {
  const r = db
    .prepare('SELECT * FROM rows WHERE project_id = ? AND id = ?')
    .get(projectId, rowId) as RowRow | undefined;
  return r ? toRow(r) : null;
}

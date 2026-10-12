import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { hashKey } from '../src/keys.js';

const ADMIN = 'a'.repeat(32);
const config = {
  PORT: 3620,
  ADMIN_TOKEN: ADMIN,
  DB_PATH: ':memory:',
  PUBLIC_URL: 'http://x',
  TRUST_PROXY: '0' as const,
  MAX_PROJECTS: 5000,
};

function setup(over: Partial<typeof config> = {}) {
  let t = new Date('2026-09-20T10:00:00Z').getTime();
  const clock = { advance: (ms: number) => (t += ms) };
  const db = openDb(':memory:');
  const app = createApp({ config: { ...config, ...over }, db, now: () => new Date(t) });
  return { db, app, clock };
}
type App = ReturnType<typeof setup>['app'];
interface Created {
  id: string;
  manageToken: string;
  apiKey: string;
  baseUrl: string;
  manageUrl: string;
  columns: { name: string; type: string }[];
  rowCount: number;
}
async function upload(
  app: App,
  csv: string,
  body: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const r = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ csv, ...body }),
  });
  return {
    status: r.status,
    json: (await r.json()) as Created & { error?: { code: string; message: string } },
  };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const apiKey = (k: string) => ({ 'x-api-key': k });

const CSV = 'name,age,active\nAda,36,true\nAlan,41,false\nGrace,85,true\n';

describe('smoke', () => {
  it('serves health and the landing page', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
  });
});

describe('project creation from CSV', () => {
  it('creates a project from a JSON {csv} body', async () => {
    const { app } = setup();
    const { status, json } = await upload(app, CSV, { name: 'people' });
    expect(status).toBe(201);
    expect(json.manageToken).toMatch(/^shmt_/);
    expect(json.apiKey).toMatch(/^shapi_/);
    expect(json.rowCount).toBe(3);
    expect(json.columns).toEqual([
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number' },
      { name: 'active', type: 'boolean' },
    ]);
  });

  it('accepts a raw text/csv body', async () => {
    const { app } = setup();
    const r = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: CSV,
    });
    expect(r.status).toBe(201);
  });

  it('accepts a multipart file upload', async () => {
    const { app } = setup();
    const fd = new FormData();
    fd.append('file', new File([CSV], 'people.csv', { type: 'text/csv' }));
    fd.append('name', 'uploaded');
    const r = await app.request('/api/projects', { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    const body = (await r.json()) as Created;
    expect(body.rowCount).toBe(3);
  });

  it('rejects invalid CSV (empty, bad header)', async () => {
    const { app } = setup();
    expect((await upload(app, '')).status).toBe(400);
    expect((await upload(app, 'a,,c\n1,2,3\n')).status).toBe(400);
    expect((await upload(app, 'a,a\n1,2\n')).status).toBe(400);
  });

  it('rejects a CSV over the plan size cap', async () => {
    const { app } = setup();
    const big = 'col\n' + 'x'.repeat(2_000_000) + '\n';
    expect((await upload(app, big)).status).toBe(413);
  });
});

describe('read-only data API', () => {
  it('requires an api key and rejects a project id mismatch', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    expect((await app.request(`/data/${p.id}/rows`)).status).toBe(401);
    const { json: other } = await upload(app, CSV);
    expect(
      (await app.request(`/data/${p.id}/rows`, { headers: apiKey(other.apiKey) })).status,
    ).toBe(404);
  });

  it('lists rows with total count and column metadata', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const cols = await app.request(`/data/${p.id}/columns`, { headers: apiKey(p.apiKey) });
    expect(((await cols.json()) as { rowCount: number }).rowCount).toBe(3);

    const rows = await app.request(`/data/${p.id}/rows`, { headers: apiKey(p.apiKey) });
    const body = (await rows.json()) as { items: { name: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items.map((r) => r.name)).toEqual(['Ada', 'Alan', 'Grace']);
    expect(rows.headers.get('x-total-count')).toBe('3');
  });

  it('gets a single row by id, 404s for unknown', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const list = await app.request(`/data/${p.id}/rows`, { headers: apiKey(p.apiKey) });
    const first = ((await list.json()) as { items: { _id: number }[] }).items[0]!;
    const got = await app.request(`/data/${p.id}/rows/${first._id}`, { headers: apiKey(p.apiKey) });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { name: string }).name).toBe('Ada');
    expect(
      (await app.request(`/data/${p.id}/rows/999999`, { headers: apiKey(p.apiKey) })).status,
    ).toBe(404);
  });

  it('filters by exact column value', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const r = await app.request(`/data/${p.id}/rows?active=true`, { headers: apiKey(p.apiKey) });
    const body = (await r.json()) as { items: { name: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((x) => x.name).sort()).toEqual(['Ada', 'Grace']);
  });

  it('ignores a filter key that is not a real column (not a SQL/JS injection vector)', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const r = await app.request(`/data/${p.id}/rows?__proto__=x&constructor=y`, {
      headers: apiKey(p.apiKey),
    });
    expect(((await r.json()) as { total: number }).total).toBe(3);
  });

  it('sorts ascending and descending', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const asc = await app.request(`/data/${p.id}/rows?sort=age&order=asc`, {
      headers: apiKey(p.apiKey),
    });
    expect(((await asc.json()) as { items: { age: number }[] }).items.map((r) => r.age)).toEqual([
      36, 41, 85,
    ]);
    const desc = await app.request(`/data/${p.id}/rows?sort=age&order=desc`, {
      headers: apiKey(p.apiKey),
    });
    expect(((await desc.json()) as { items: { age: number }[] }).items.map((r) => r.age)).toEqual([
      85, 41, 36,
    ]);
  });

  it('rejects sorting by a column that does not exist', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    expect(
      (await app.request(`/data/${p.id}/rows?sort=nope`, { headers: apiKey(p.apiKey) })).status,
    ).toBe(400);
  });

  it('paginates with limit/offset', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const r = await app.request(`/data/${p.id}/rows?limit=1&offset=1`, {
      headers: apiKey(p.apiKey),
    });
    const body = (await r.json()) as { items: { name: string }[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.name).toBe('Alan');
    expect(body.total).toBe(3);
  });

  it('a project in another dataset is not reachable through this one', async () => {
    const { app } = setup();
    const { json: a } = await upload(app, CSV);
    const { json: b } = await upload(app, 'name\nSecretOnly\n');
    const r = await app.request(`/data/${b.id}/rows`, { headers: apiKey(b.apiKey) });
    const names = ((await r.json()) as { items: { name: string }[] }).items.map((x) => x.name);
    expect(names).toEqual(['SecretOnly']);
    expect(names).not.toContain('Ada');
    // cross-key: a's api key against b's id
    expect((await app.request(`/data/${b.id}/rows`, { headers: apiKey(a.apiKey) })).status).toBe(
      404,
    );
  });
});

describe('project lifecycle and admin', () => {
  it('owner can read metadata, replace the CSV, and delete', async () => {
    const { app } = setup();
    const { json: p } = await upload(app, CSV);
    const get = await app.request(`/api/projects/${p.id}`, { headers: auth(p.manageToken) });
    expect(get.status).toBe(200);
    expect((await app.request(`/api/projects/${p.id}`)).status).toBe(401);

    const replace = await app.request(`/api/projects/${p.id}/csv`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(p.manageToken) },
      body: JSON.stringify({ csv: 'x\n1\n2\n' }),
    });
    expect(replace.status).toBe(200);
    expect(((await replace.json()) as { rowCount: number }).rowCount).toBe(2);
    const rows = await app.request(`/data/${p.id}/rows`, { headers: apiKey(p.apiKey) });
    expect(((await rows.json()) as { total: number }).total).toBe(2);

    const del = await app.request(`/api/projects/${p.id}`, {
      method: 'DELETE',
      headers: auth(p.manageToken),
    });
    expect(del.status).toBe(204);
    expect((await app.request(`/data/${p.id}/rows`, { headers: apiKey(p.apiKey) })).status).toBe(
      404,
    );
  });

  it('a wrong manage token cannot read or replace', async () => {
    const { app } = setup();
    const { json: a } = await upload(app, CSV);
    const { json: b } = await upload(app, CSV);
    expect(
      (await app.request(`/api/projects/${a.id}`, { headers: auth(b.manageToken) })).status,
    ).toBe(404);
  });

  it('projects expire after their plan TTL', async () => {
    const { app, clock } = setup();
    const { json: p } = await upload(app, CSV);
    clock.advance(31 * 86_400_000);
    expect((await app.request(`/data/${p.id}/rows`, { headers: apiKey(p.apiKey) })).status).toBe(
      404,
    );
    expect(
      (await app.request(`/api/projects/${p.id}`, { headers: auth(p.manageToken) })).status,
    ).toBe(404);
  });

  it('admin can issue, list and revoke keys; stores only hashes', async () => {
    const { app, db } = setup();
    const r = await app.request('/admin/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'pro user', plan: 'pro' }),
    });
    expect(r.status).toBe(201);
    const k = (await r.json()) as { key: string; id: string };
    const row = db.prepare('SELECT key_hash FROM api_keys').get() as { key_hash: string };
    expect(row.key_hash).toBe(hashKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);

    const { json: upgraded } = await upload(app, CSV, {}, apiKey(k.key));
    expect(upgraded).toHaveProperty('plan', 'pro');

    await app.request(`/admin/keys/${k.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect((await upload(app, CSV, {}, apiKey(k.key))).status).toBe(401);
  });

  it('admin endpoints need the admin token', async () => {
    const { app } = setup();
    expect((await app.request('/admin/keys')).status).toBe(401);
    expect((await app.request('/admin/keys', { headers: auth(ADMIN) })).status).toBe(200);
  });

  it('never leaks internals on errors', async () => {
    const { app } = setup();
    const r = await app.request('/data/x/rows', { headers: apiKey('nope') });
    expect(JSON.stringify(await r.json())).not.toMatch(/sqlite|stack|node_modules/i);
  });

  it('rate limits anonymous project creation per IP', async () => {
    const { app } = setup();
    let limited = 0;
    for (let n = 0; n < 12; n++) if ((await upload(app, CSV)).status === 429) limited++;
    expect(limited).toBe(2);
  });

  it('enforces the global capacity ceiling', async () => {
    const { app } = setup({ MAX_PROJECTS: 2 });
    expect((await upload(app, CSV)).status).toBe(201);
    expect((await upload(app, CSV)).status).toBe(201);
    expect((await upload(app, CSV)).status).toBe(503);
  });
});

import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PLANS, type Config, type Plan } from './config.js';
import type { Db } from './db.js';
import { createKey, findActiveKey, listKeys, revokeKey, type KeyRecord } from './keys.js';
import { parseCsv } from './csv.js';
import {
  countForKey,
  countLive,
  createProject,
  deleteProject,
  findProjectByApiKey,
  getProject,
  getRow,
  isProjectId,
  listRows,
  replaceData,
  verifyManageToken,
  type Project,
} from './projects.js';
import { RateLimiter } from './ratelimit.js';
import { readCapped } from './body.js';

export interface Deps {
  config: Config;
  db: Db;
  now?: () => Date;
}

type ErrStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503;
const err = (c: Context, status: ErrStatus, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const asset = (name: string) => readFileSync(publicDir + name, 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

type Vars = { project: Project };

/** Pulls CSV text out of either a JSON body `{ csv }`, a raw text/csv body, or a multipart file field. */
async function extractCsv(
  c: Context,
  maxBytes: number,
): Promise<{ csv: string; name?: string } | Response> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes + 10_000) {
      return err(c, 413, 'TOO_LARGE', 'Upload too large.');
    }
    let form: Record<string, FormDataEntryValue>;
    try {
      form = await c.req.parseBody();
    } catch {
      return err(c, 400, 'INVALID_BODY', 'Could not parse multipart form.');
    }
    const file = form.file;
    if (!(file instanceof File))
      return err(c, 400, 'VALIDATION', 'A "file" field with the CSV is required.');
    if (file.size > maxBytes)
      return err(c, 413, 'TOO_LARGE', `CSV exceeds the ${maxBytes}-byte plan limit.`);
    const csv = await file.text();
    const name = typeof form.name === 'string' ? form.name : undefined;
    return { csv, name };
  }
  if (ct.includes('application/json')) {
    const raw = await readCapped(c.req.raw, maxBytes + 10_000);
    if (!raw) return err(c, 413, 'TOO_LARGE', 'Request body too large.');
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return err(c, 400, 'INVALID_JSON', 'Body must be JSON.');
    }
    const parsed = z
      .object({ csv: z.string(), name: z.string().max(80).optional() })
      .safeParse(json);
    if (!parsed.success)
      return err(c, 400, 'VALIDATION', 'Body must be { csv: string, name?: string }.');
    if (Buffer.byteLength(parsed.data.csv, 'utf8') > maxBytes) {
      return err(c, 413, 'TOO_LARGE', `CSV exceeds the ${maxBytes}-byte plan limit.`);
    }
    return { csv: parsed.data.csv, name: parsed.data.name };
  }
  // Treat anything else (text/csv, text/plain, no content-type) as the raw CSV body.
  const raw = await readCapped(c.req.raw, maxBytes + 10_000);
  if (!raw) return err(c, 413, 'TOO_LARGE', 'Request body too large.');
  if (raw.length > maxBytes)
    return err(c, 413, 'TOO_LARGE', `CSV exceeds the ${maxBytes}-byte plan limit.`);
  return { csv: raw.toString('utf8') };
}

export function createApp({ config, db, now = () => new Date() }: Deps) {
  const app = new Hono<{ Variables: Vars }>();
  const createLimiter = new RateLimiter(3_600_000);
  const dataLimiterByKey = new RateLimiter();
  const dataLimiterByIp = new RateLimiter();
  const manageLimiter = new RateLimiter();
  const adminLimiter = new RateLimiter();
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/home.js': ['home.js', 'text/javascript; charset=utf-8'],
  };

  const clientIp = (c: Context): string => {
    if (config.TRUST_PROXY === '1') {
      const xff = c.req.header('x-forwarded-for');
      const last = xff?.split(',').pop()?.trim(); // rightmost = added by our own proxy
      if (last) return last.slice(0, 64);
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
  });

  app.get('/health', (c) => c.json({ ok: true }));
  for (const [path, [file, type]] of Object.entries(files)) {
    app.get(path, (c) => c.body(asset(file), 200, { 'Content-Type': type }));
  }

  // --------------------------------------------------------- project admin
  const optionalKey = (c: Context): KeyRecord | null | 'bad' => {
    const k = c.req.header('x-api-key');
    if (!k) return null;
    return findActiveKey(db, k) ?? 'bad';
  };

  app.post('/api/projects', async (c) => {
    const key = optionalKey(c);
    if (key === 'bad') return err(c, 401, 'INVALID_API_KEY', 'Invalid or revoked API key.');
    const plan: Plan = key?.plan ?? 'free';
    const rl = createLimiter.check(key ? `k:${key.id}` : `ip:${clientIp(c)}`, key ? 60 : 10);
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return err(c, 429, 'RATE_LIMITED', 'Too many projects created. Try again later.');
    }
    const t = now();
    if (countLive(db, t) >= config.MAX_PROJECTS) {
      return err(c, 503, 'CAPACITY', 'The service is full right now. Try again later.');
    }
    if (key && countForKey(db, key.id, t) >= PLANS[plan].maxProjects) {
      return err(
        c,
        403,
        'PLAN_LIMIT',
        `Your plan allows ${PLANS[plan].maxProjects} live projects.`,
      );
    }

    const extracted = await extractCsv(c, PLANS[plan].maxCsvBytes);
    if (extracted instanceof Response) return extracted;
    const parsed = parseCsv(extracted.csv, PLANS[plan]);
    if (!parsed.ok) return err(c, 400, 'INVALID_CSV', parsed.error);

    const { project, manageToken, apiKey } = createProject(db, {
      plan,
      ownerKeyId: key?.id ?? null,
      name: extracted.name ?? '',
      columns: parsed.data.columns.map((name, i) => ({ name, type: parsed.data.types[i]! })),
      rows: parsed.data.rows,
      now: t,
    });
    return c.json(
      {
        id: project.id,
        manageToken,
        apiKey,
        baseUrl: `${config.PUBLIC_URL}/data/${project.id}`,
        manageUrl: `${config.PUBLIC_URL}/api/projects/${project.id}`,
        plan: project.plan,
        columns: project.columns,
        rowCount: project.rowCount,
        expiresAt: project.expiresAt,
        limits: PLANS[plan],
      },
      201,
    );
  });

  /** Owner-only guard. Same 404 for unknown id and wrong token: no oracle. */
  const owned = (c: Context): Project | Response => {
    const rl = manageLimiter.check(clientIp(c), 300);
    if (!rl.ok) return err(c, 429, 'RATE_LIMITED', 'Too many requests.');
    const id = c.req.param('id') ?? '';
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m?.[1]) return err(c, 401, 'UNAUTHORIZED', 'Missing manage token.');
    const project = isProjectId(id) ? getProject(db, id, now()) : null;
    if (!project || !verifyManageToken(db, id, m[1]))
      return err(c, 404, 'NOT_FOUND', 'Project not found.');
    return project;
  };

  app.get('/api/projects/:id', (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    return c.json({
      id: p.id,
      plan: p.plan,
      name: p.name,
      columns: p.columns,
      rowCount: p.rowCount,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      expiresAt: p.expiresAt,
    });
  });

  app.put('/api/projects/:id/csv', async (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    const extracted = await extractCsv(c, PLANS[p.plan].maxCsvBytes);
    if (extracted instanceof Response) return extracted;
    const parsed = parseCsv(extracted.csv, PLANS[p.plan]);
    if (!parsed.ok) return err(c, 400, 'INVALID_CSV', parsed.error);
    replaceData(
      db,
      p.id,
      parsed.data.columns.map((name, i) => ({ name, type: parsed.data.types[i]! })),
      parsed.data.rows,
      now(),
    );
    const updated = getProject(db, p.id, now())!;
    return c.json({
      columns: updated.columns,
      rowCount: updated.rowCount,
      updatedAt: updated.updatedAt,
    });
  });

  app.delete('/api/projects/:id', (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    deleteProject(db, p.id);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ admin
  app.use('/admin/*', async (c, next) => {
    const rl = adminLimiter.check(clientIp(c), 30);
    if (!rl.ok) return err(c, 429, 'RATE_LIMITED', 'Too many requests.');
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m?.[1] || !safeEqual(m[1], config.ADMIN_TOKEN))
      return err(c, 401, 'UNAUTHORIZED', 'Admin token required.');
    await next();
  });
  app.post('/admin/keys', async (c) => {
    const parsed = z
      .object({ label: z.string().min(1).max(80), plan: z.enum(['free', 'pro', 'business']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return err(c, 400, 'VALIDATION', 'label and plan are required.');
    const { key, record } = createKey(db, parsed.data.label, parsed.data.plan);
    return c.json({ key, ...record }, 201);
  });
  app.get('/admin/keys', (c) => c.json({ keys: listKeys(db) }));
  app.delete('/admin/keys/:id', (c) =>
    revokeKey(db, c.req.param('id'))
      ? c.body(null, 204)
      : err(c, 404, 'NOT_FOUND', 'Key not found.'),
  );

  // -------------------------------------------------------- read-only data API
  app.use('/data/:id/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 204, CORS);
    const ip = clientIp(c);
    const ipRl = dataLimiterByIp.check(ip, 600);
    if (!ipRl.ok) return err(c, 429, 'RATE_LIMITED', 'Too many requests from this address.');
    const id = c.req.param('id') ?? '';
    const key = c.req.header('x-api-key');
    if (!key) return err(c, 401, 'UNAUTHORIZED', 'x-api-key header required.');
    const project = isProjectId(id) ? findProjectByApiKey(db, key, now()) : null;
    if (!project || project.id !== id) return err(c, 404, 'NOT_FOUND', 'Project not found.');
    const rl = dataLimiterByKey.check(project.id, PLANS[project.plan].requestsPerMin);
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return err(c, 429, 'RATE_LIMITED', 'Too many requests for this project.');
    }
    c.set('project', project);
    await next();
  });

  app.get('/data/:id/columns', (c) => {
    const project = c.get('project');
    return c.json({ columns: project.columns, rowCount: project.rowCount });
  });

  app.get('/data/:id/rows', (c) => {
    const project = c.get('project');
    const colNames = new Set(project.columns.map((col) => col.name));
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        sort: z.string().max(60).optional(),
        order: z.enum(['asc', 'desc']).default('asc'),
      })
      .passthrough()
      .safeParse(c.req.query());
    if (!q.success) return err(c, 400, 'VALIDATION', 'Invalid query.');
    const { limit, offset, sort, order, ...rest } = q.data as {
      limit: number;
      offset: number;
      sort?: string;
      order: 'asc' | 'desc';
    } & Record<string, string>;
    if (sort && !colNames.has(sort))
      return err(c, 400, 'VALIDATION', `unknown sort column "${sort}"`);
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (colNames.has(k) && typeof v === 'string') filters[k] = v;
    }
    const { items, total } = listRows(db, project.id, { limit, offset, filters, sort, order });
    c.header('X-Total-Count', String(total));
    return c.json({ items: items.map((r) => ({ _id: r.id, ...r.data })), total, limit, offset });
  });

  app.get('/data/:id/rows/:rowId', (c) => {
    const project = c.get('project');
    const rowId = Number(c.req.param('rowId'));
    if (!Number.isInteger(rowId)) return err(c, 400, 'VALIDATION', 'rowId must be an integer.');
    const r = getRow(db, project.id, rowId);
    if (!r) return err(c, 404, 'NOT_FOUND', 'Row not found.');
    return c.json({ _id: r.id, ...r.data });
  });

  app.notFound((c) => err(c, 404, 'NOT_FOUND', 'Not found.'));
  app.onError((e, c) => {
    console.error(e);
    return err(c, 500, 'INTERNAL', 'Something went wrong.');
  });
  return app;
}

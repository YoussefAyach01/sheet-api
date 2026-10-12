# sheet-api

Upload a CSV, get a read-only JSON REST API over its rows, with an API key. No account
required for the free tier.

## What it does

- `POST /api/projects` accepts a CSV (as a multipart file upload with a `file` field, a raw
  `text/csv` body, or a JSON body `{ csv, name? }`), parses it with a small
  dependency-free parser (quoted fields, embedded commas/newlines, `""` escapes, CRLF or LF),
  infers a type per column (`string`/`number`/`boolean`, falling back to `string` on any mix),
  and stores every row. Returns a manage token (owner-only, for replacing/deleting the data)
  and a consumer API key (for reading it).
- `GET /data/:id/columns` — column names + inferred types.
- `GET /data/:id/rows?limit=&offset=&sort=&order=&<column>=value` — paginated list, optional
  exact-match filter on any real column, optional sort (only by a column that exists).
- `GET /data/:id/rows/:rowId` — a single row.
- `PUT /api/projects/:id/csv` (owner) — replace the dataset with a new CSV.
- Plans (free/pro/business, raised by an admin-issued `x-api-key` at project-creation time)
  differ in max CSV size, max rows/columns, requests/minute, and how many projects are live.
  Anonymous creation gets the free plan.
- Abuse protection: the CSV parser is a linear character-by-character state machine (not a
  regex scan over the whole file), so a hostile file cannot cause catastrophic backtracking.
  Upload size is capped per plan (declared `Content-Length` and multipart file size both
  checked), rows/columns are capped per plan, query-string filter/sort keys are only ever
  matched against real column names (never used to build a query string, so there is no
  SQL/prototype-pollution injection vector), and both IP and per-project rate limits apply to
  the read API. sheet-api makes no outbound network requests of its own, so there is no SSRF
  surface the way a webhook-delivery product would have.
- Projects expire automatically (TTL per plan) and are purged from disk on a timer, same
  pattern as webhook-inbox and mock-api.

## Run locally

```bash
npm install
cp .env.example .env   # edit ADMIN_TOKEN at minimum
npm run dev             # http://localhost:3620
```

Open `http://localhost:3620` to upload a CSV file from a form and get back the base URL, API
key, and a ready curl command. Or do it directly:

```bash
curl -X POST http://localhost:3620/api/projects -F "file=@people.csv" -F "name=people"
# -> { id, manageToken, apiKey, baseUrl, manageUrl, plan, columns, rowCount, expiresAt, limits }

curl http://localhost:3620/data/<id>/rows -H 'x-api-key: <apiKey>'
curl "http://localhost:3620/data/<id>/rows?active=true&sort=age&order=desc" -H 'x-api-key: <apiKey>'
curl http://localhost:3620/data/<id>/rows/1 -H 'x-api-key: <apiKey>'
```

## Tests

```bash
npm run typecheck
npm run lint
npm test     # vitest: CSV parser (17 unit cases incl. a ReDoS-shape timing check) + full app
```

`tests/csv.test.ts` covers quoting/escaping/CRLF, type inference, empty-cell-to-null, header
validation, row/column caps, and a timing assertion that a 20k-row file and a pathological
single field both parse well under a second (the parser is linear, not regex-backtracking).
`tests/app.test.ts` drives the real Hono app (in-memory SQLite) through all three upload paths
(JSON, raw text/csv, multipart `FormData`/`File`), the full read API (list/filter/sort/paginate/
single row), tenant isolation (one project's api key cannot read another project's id, and
rows never leak across projects), owner CSV replace/delete, plan TTL expiry, rate limiting,
admin keys, and a check that error responses never leak internals.

A live smoke run against a real `node --import tsx src/server.ts` server on `:3620` was done
by hand with curl: health check, multipart upload of a real 3-row CSV, columns, full list,
exact-match filter, sort, 401 with no key, 404 with a wrong key, owner metadata read, and the
landing page (200).

## Deploy

Needs a host with a **persistent disk** (SQLite file) — not a serverless/edge platform like
Vercel. A small VPS, Fly.io, or Railway works. Put a domain + TLS in front of it and set
`PUBLIC_URL` so generated base/manage URLs are correct.

## Known limits / not verified

- Rate limiters are in-memory (per-process) — fine for a single instance, not for a
  multi-process deployment behind a load balancer.
- No signup/billing UI; upgraded API keys are minted manually via `/admin/keys`.
- Type inference is per-column and whole-file (string/number/boolean only); there is no way to
  override an inferred type, and a single stray non-numeric value in an otherwise numeric
  column falls the whole column back to `string`.
- No joins/relations across projects, no full-text search, no CSV re-export endpoint.
- Visual/accessibility review of the landing page was done by eye only (no real-browser
  automated check); not checked on Safari/iOS.

## Accounts needed to go live

None for the code itself. To actually sell/host it: a VPS/PaaS with persistent disk, a domain,
and (optionally) a payment provider if you charge for pro/business plans.

import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { purgeExpired } from './projects.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}
const config = loadConfig();
const db = openDb(config.DB_PATH);
const app = createApp({ config, db });
// Expired projects are already invisible; this reclaims the disk.
setInterval(() => purgeExpired(db, new Date()), 10 * 60_000).unref();
purgeExpired(db, new Date());
serve({ fetch: app.fetch, port: config.PORT }, (i) =>
  console.log(`sheet-api listening on :${i.port}`),
);

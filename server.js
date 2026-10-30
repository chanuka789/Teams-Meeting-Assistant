// APC Interview Assistant - server
// Serves the web app; user accounts, the competency library and case studies (files in the bucket,
// text in Postgres) and the AI routes that proxy OpenRouter, so the API key never reaches the browser.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './lib/db.js';
import { loadUser } from './lib/auth.js';
import { checkStorage, storageKind } from './lib/storage.js';
import { config } from './lib/openrouter.js';
import { router as accountRouter } from './lib/routes/account.js';
import { router as libraryRouter } from './lib/routes/library.js';
import { router as aiRouter } from './lib/routes/ai.js';
import { router as chatRouter } from './lib/routes/chat.js';
import { backfillDocumentText } from './lib/documents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const status = { db: 'starting', storage: 'starting' };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates TLS; needed for secure cookies

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: status.db === 'ok', db: status.db, storage: `${storageKind}: ${status.storage}`, keyConfigured: Boolean(config.openrouterKey) });
});

app.use('/api', express.json({ limit: '10mb' }), loadUser);
app.use('/api', accountRouter);
app.use('/api', libraryRouter);
app.use('/api', aiRouter);
app.use('/api', chatRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Readable JSON errors instead of HTML stack traces
app.use('/api', (err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (max 50 MB).' });
  console.error('[api]', req.method, req.path, err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Server error: ' + err.message });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Client-side routes (#/library etc.) all load the same page
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  if (!pool) {
    status.db = 'DATABASE_URL not set';
    console.error('ERROR: DATABASE_URL is not set.');
  } else {
    try {
      await migrate();
      status.db = 'ok';
      backfillDocumentText().catch((err) => console.error('[backfill]', err.message)); // in the background
    } catch (err) {
      status.db = 'error: ' + err.message;
      console.error('[db] migration failed', err.message);
    }
  }
  try {
    await checkStorage();
    status.storage = 'ok';
  } catch (err) {
    status.storage = 'error: ' + err.message;
    console.error('[storage] check failed', err.message);
  }
  app.listen(port, () => {
    console.log(`APC Interview Assistant listening on :${port} | db ${status.db} | storage ${storageKind} ${status.storage}`);
    console.log(`STT model: ${config.sttModel} | Answer model: ${config.answerModel} | Detect model: ${config.detectModel}`);
    if (!config.openrouterKey) console.warn('WARNING: OPENROUTER_API_KEY is not set.');
  });
}

start();

// server/src/ytdlp/ytdlp-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerYtdlpRoutes } from './ytdlp-routes.js';
import { createDownloadManager } from './download.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';

let db: DB;
let app: FastifyInstance;
beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  app = Fastify({ logger: false });
});
afterEach(async () => { await app.close(); db.close(); });

function makeApp(binPath: string | null, token = 'tok', dm?: ReturnType<typeof createDownloadManager>) {
  return registerYtdlpRoutes(app, {
    db,
    binProvider: async () => ({ path: binPath }),
    downloadManager: dm ?? createDownloadManager(),
    audioDir: 'C:/audio', tempDir: 'C:/tmp', token,
  });
}

describe('POST /api/ytdlp/parse', () => {
  it('url 缺失 → 400', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('bin 缺失 → 409 YTDLP_NOT_FOUND', async () => {
    makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('YTDLP_NOT_FOUND');
  });
});

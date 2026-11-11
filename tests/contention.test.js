import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SQLite only serialises writers across *processes*; inside one Node process
// DatabaseSync is synchronous, so the in-process concurrency tests cannot
// prove that BEGIN IMMEDIATE + busy_timeout prevent overselling. Here several
// server processes share one database file and are hit simultaneously.

const PROCESS_COUNT = 3;
const CARTS = 12;
const SEEDED_STOCK = 5; // book id 2 ("1984") from the seed data

let tmpDir;
const children = [];
const baseUrls = [];

function startChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'helpers', 'child-server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited early with code ${code}`)));
    child.stdout.on('data', (chunk) => {
      const match = /PORT=(\d+)/.exec(String(chunk));
      if (match) {
        child.removeAllListeners('exit');
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
}

async function call(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bookstore-contention-'));
  const env = { ...process.env, DATABASE_PATH: join(tmpDir, 'shared.db') };
  delete env.ADMIN_TOKEN;
  // Start the first process alone so only one of them seeds the empty database.
  baseUrls.push(await startChild(env));
  for (let i = 1; i < PROCESS_COUNT; i++) {
    baseUrls.push(await startChild(env));
  }
});

after(() => {
  for (const child of children) child.kill('SIGTERM');
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('checkouts racing across processes never oversell', async () => {
  const cartIds = [];
  for (let i = 0; i < CARTS; i++) {
    const cart = await call(baseUrls[i % PROCESS_COUNT], 'POST', '/carts');
    assert.equal(cart.status, 201);
    const add = await call(baseUrls[i % PROCESS_COUNT], 'POST', `/carts/${cart.json.id}/items`, {
      book_id: 2,
      quantity: 1,
    });
    assert.equal(add.status, 200);
    cartIds.push(cart.json.id);
  }

  // Each checkout goes to a different process than the cart was created on.
  const results = await Promise.all(
    cartIds.map((id, i) => call(baseUrls[(i + 1) % PROCESS_COUNT], 'POST', `/carts/${id}/checkout`)),
  );

  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, SEEDED_STOCK, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, CARTS - SEEDED_STOCK, `statuses: ${statuses}`);

  const book = await call(baseUrls[0], 'GET', '/books/2');
  assert.equal(book.json.stock, 0);
});

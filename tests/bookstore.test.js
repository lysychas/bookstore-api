import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Configure the environment BEFORE importing the app: src/db.js reads
// DATABASE_PATH at import time, so we use dynamic imports below.
process.env.DATABASE_PATH = ':memory:';
const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghijklmnopqrstuvwxyz';
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

const { app } = await import('../src/app.js');
const { db } = await import('../src/db.js');

let server;
let baseUrl;

// The app logs unexpected errors via console.error; none are expected here.
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

// ---------- helpers ----------

async function request(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  if (init.body !== undefined && !('Content-Type' in init.headers)) {
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const post = (path, body) => request('POST', path, { body });
const get = (path, headers) => request('GET', path, { headers });

/** Insert a book directly into the DB and return its id. */
function seedBook({ title = 'Test Book', author = 'Test Author', price_cents = 1000, stock = 5 } = {}) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO books (title, author, price_cents, stock) VALUES (?, ?, ?, ?)')
    .run(title, author, price_cents, stock);
  return Number(lastInsertRowid);
}

const stockOf = (bookId) => db.prepare('SELECT stock FROM books WHERE id = ?').get(bookId).stock;

async function newCart() {
  const res = await post('/carts', {});
  assert.equal(res.status, 201);
  return res.json.id;
}

// ---------- happy path ----------

describe('happy path', () => {
  test('browse -> create cart -> add -> checkout -> view order', async () => {
    const bookId = seedBook({ title: 'Original Title', author: 'Original Author', price_cents: 1499, stock: 10 });

    // Browse
    const list = await get('/books');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json));
    const listed = list.json.find((b) => b.id === bookId);
    assert.deepEqual(listed, {
      id: bookId,
      title: 'Original Title',
      author: 'Original Author',
      price: '14.99',
      stock: 10,
    });

    const detail = await get(`/books/${bookId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json, listed);

    // Create cart
    const created = await post('/carts', {});
    assert.equal(created.status, 201);
    assert.match(created.json.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.json.status, 'open');
    const cartId = created.json.id;

    // Add to cart (twice -> quantities merge)
    const add1 = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 2 });
    assert.equal(add1.status, 200);
    assert.equal(add1.json.quantity, 2);
    const add2 = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
    assert.equal(add2.status, 200);
    assert.equal(add2.json.quantity, 3);

    const cart = await get(`/carts/${cartId}`);
    assert.equal(cart.status, 200);
    assert.equal(cart.json.status, 'open');
    assert.equal(cart.json.items.length, 1);
    assert.equal(cart.json.items[0].quantity, 3);

    // Adding to cart does not reserve stock
    assert.equal(stockOf(bookId), 10);

    // Checkout
    const checkout = await post(`/carts/${cartId}/checkout`, {});
    assert.equal(checkout.status, 201);
    assert.equal(checkout.json.cart_id, cartId);
    assert.equal(checkout.json.total, '44.97'); // 3 * 14.99
    assert.deepEqual(checkout.json.items, [
      { book_id: bookId, title: 'Original Title', author: 'Original Author', price: '14.99', quantity: 3 },
    ]);
    const orderId = checkout.json.id;

    // Stock decremented, cart marked checked out
    assert.equal(stockOf(bookId), 7);
    assert.equal((await get(`/carts/${cartId}`)).json.status, 'checked_out');

    // Mutate the catalog: the order must keep the frozen details
    db.prepare("UPDATE books SET title = 'Changed Title', author = 'Changed Author', price_cents = 9999 WHERE id = ?").run(bookId);

    const order = await get(`/orders/${orderId}`);
    assert.equal(order.status, 200);
    assert.equal(order.json.id, orderId);
    assert.equal(order.json.cart_id, cartId);
    assert.equal(order.json.total, '44.97');
    assert.deepEqual(order.json.items, [
      { book_id: bookId, title: 'Original Title', author: 'Original Author', price: '14.99', quantity: 3 },
    ]);

    // Catalog shows the new values, proving the order is decoupled from it
    const changed = await get(`/books/${bookId}`);
    assert.equal(changed.json.title, 'Changed Title');
    assert.equal(changed.json.price, '99.99');
  });
});

// ---------- negative / error cases ----------

describe('request body validation (400)', () => {
  const cases = [
    ['missing body', { raw: undefined }],
    ['empty string body', { raw: '' }],
    ['null body', { raw: 'null' }],
    ['array body', { raw: '[]' }],
    ['non-empty array body', { raw: '[{"book_id":1,"quantity":1}]' }],
    ['string body', { raw: '"hello"' }],
    ['number body', { raw: '42' }],
  ];

  const endpoints = [
    ['POST /carts', () => '/carts'],
    ['POST /carts/:id/items', (cartId) => `/carts/${cartId}/items`],
    ['POST /carts/:id/checkout', (cartId) => `/carts/${cartId}/checkout`],
  ];

  for (const [endpointName, pathFor] of endpoints) {
    for (const [caseName, opts] of cases) {
      test(`${endpointName} with ${caseName} -> 400`, async () => {
        const cartId = await newCart();
        const res = await request('POST', pathFor(cartId), {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        assert.equal(res.status, 400);
        assert.ok(res.json?.error, 'expects a JSON error body');
      });
    }

    test(`${endpointName} with invalid JSON syntax -> 400 JSON`, async () => {
      const cartId = await newCart();
      const res = await request('POST', pathFor(cartId), { raw: '{"book_id": 1, ' });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(res.json, { error: 'Invalid JSON' });
    });

    test(`${endpointName} with non-JSON content type -> 400`, async () => {
      const cartId = await newCart();
      const res = await request('POST', pathFor(cartId), {
        raw: 'hello',
        headers: { 'Content-Type': 'text/plain' },
      });
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  }

  test('invalid POST body does not create a cart', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM carts').get().c;
    await request('POST', '/carts', { raw: 'null' });
    await request('POST', '/carts', { raw: '[]' });
    await request('POST', '/carts', { raw: '{oops' });
    const after = db.prepare('SELECT COUNT(*) AS c FROM carts').get().c;
    assert.equal(after, before);
  });
});

describe('POST /carts/:id/items field validation (400)', () => {
  const invalidBodies = [
    ['missing book_id', { quantity: 1 }],
    ['missing quantity', { book_id: 1 }],
    ['empty object', {}],
    ['string book_id', { book_id: '1', quantity: 1 }],
    ['float book_id', { book_id: 1.5, quantity: 1 }],
    ['zero book_id', { book_id: 0, quantity: 1 }],
    ['negative book_id', { book_id: -1, quantity: 1 }],
    ['null book_id', { book_id: null, quantity: 1 }],
    ['string quantity', { book_id: 1, quantity: '1' }],
    ['float quantity', { book_id: 1, quantity: 1.5 }],
    ['zero quantity', { book_id: 1, quantity: 0 }],
    ['negative quantity', { book_id: 1, quantity: -3 }],
    ['null quantity', { book_id: 1, quantity: null }],
  ];

  for (const [name, body] of invalidBodies) {
    test(name, async () => {
      const cartId = await newCart();
      const res = await post(`/carts/${cartId}/items`, body);
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  }
});

describe('cart state and stock errors', () => {
  test('adding to an already checked out cart -> 409', async () => {
    const bookId = seedBook({ stock: 5 });
    const cartId = await newCart();
    await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
    assert.equal((await post(`/carts/${cartId}/checkout`, {})).status, 201);

    const res = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
    assert.equal(res.status, 409);
    assert.ok(res.json.error);
  });

  test('checking out an empty cart -> 400', async () => {
    const cartId = await newCart();
    const res = await post(`/carts/${cartId}/checkout`, {});
    assert.equal(res.status, 400);
    assert.ok(res.json.error);
    // cart stays open
    assert.equal((await get(`/carts/${cartId}`)).json.status, 'open');
  });

  test('checking out an already checked out cart -> 409', async () => {
    const bookId = seedBook({ stock: 5 });
    const cartId = await newCart();
    await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 2 });
    assert.equal((await post(`/carts/${cartId}/checkout`, {})).status, 201);

    const res = await post(`/carts/${cartId}/checkout`, {});
    assert.equal(res.status, 409);
    // stock was only decremented once
    assert.equal(stockOf(bookId), 3);
  });

  test('insufficient stock when adding -> 409', async () => {
    const bookId = seedBook({ stock: 2 });
    const cartId = await newCart();

    const tooMany = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 3 });
    assert.equal(tooMany.status, 409);

    // cumulative quantity across adds is also checked
    assert.equal((await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 2 })).status, 200);
    const cumulative = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
    assert.equal(cumulative.status, 409);

    // cart content unchanged by the rejected adds
    const cart = await get(`/carts/${cartId}`);
    assert.equal(cart.json.items[0].quantity, 2);
  });

  test('adding an out-of-stock book -> 409', async () => {
    const bookId = seedBook({ stock: 0 });
    const cartId = await newCart();
    const res = await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
    assert.equal(res.status, 409);
  });

  test('insufficient stock during checkout -> 409 and nothing changes', async () => {
    const plentiful = seedBook({ title: 'Plentiful', stock: 10 });
    const scarce = seedBook({ title: 'Scarce', stock: 2 });
    const cartId = await newCart();
    await post(`/carts/${cartId}/items`, { book_id: plentiful, quantity: 4 });
    await post(`/carts/${cartId}/items`, { book_id: scarce, quantity: 2 });

    // Stock drops after the items were added (e.g. another customer bought it)
    db.prepare('UPDATE books SET stock = 1 WHERE id = ?').run(scarce);

    const res = await post(`/carts/${cartId}/checkout`, {});
    assert.equal(res.status, 409);
    assert.ok(res.json.error);

    // Atomic: no stock changed, cart still open, no order created
    assert.equal(stockOf(plentiful), 10);
    assert.equal(stockOf(scarce), 1);
    assert.equal((await get(`/carts/${cartId}`)).json.status, 'open');
    const orders = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE cart_id = ?').get(cartId).c;
    assert.equal(orders, 0);
  });
});

describe('not found (404)', () => {
  test('missing book', async () => {
    const res = await get('/books/999999');
    assert.equal(res.status, 404);
    assert.ok(res.json.error);
  });

  test('non-numeric book id -> 400', async () => {
    const res = await get('/books/abc');
    assert.equal(res.status, 400);
  });

  test('book id with trailing garbage or sign -> 400', async () => {
    for (const id of ['1abc', '1.5', '-1', '+1', '1e2']) {
      const res = await get(`/books/${id}`);
      assert.equal(res.status, 400, `id "${id}" must be rejected`);
    }
  });

  test('missing cart', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    assert.equal((await get(`/carts/${missing}`)).status, 404);
    assert.equal((await post(`/carts/${missing}/items`, { book_id: 1, quantity: 1 })).status, 404);
    assert.equal((await post(`/carts/${missing}/checkout`, {})).status, 404);
  });

  test('adding a missing book to a cart', async () => {
    const cartId = await newCart();
    const res = await post(`/carts/${cartId}/items`, { book_id: 999999, quantity: 1 });
    assert.equal(res.status, 404);
  });

  test('missing order', async () => {
    const res = await get('/orders/00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 404);
    assert.ok(res.json.error);
  });
});

// ---------- concurrency ----------

describe('concurrency', () => {
  test('two simultaneous checkouts for the last copy: exactly one wins', async () => {
    const bookId = seedBook({ title: 'Last Copy', stock: 1 });

    const cartA = await newCart();
    const cartB = await newCart();
    // Both adds succeed because stock is only reserved at checkout
    assert.equal((await post(`/carts/${cartA}/items`, { book_id: bookId, quantity: 1 })).status, 200);
    assert.equal((await post(`/carts/${cartB}/items`, { book_id: bookId, quantity: 1 })).status, 200);

    const results = await Promise.all([
      post(`/carts/${cartA}/checkout`, {}),
      post(`/carts/${cartB}/checkout`, {}),
    ]);

    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);

    // Final stock is 0 (never negative) and only one order exists for the book
    assert.equal((await get(`/books/${bookId}`)).json.stock, 0);
    const orderCount = db
      .prepare('SELECT COUNT(DISTINCT order_id) AS c FROM order_items WHERE book_id = ?')
      .get(bookId).c;
    assert.equal(orderCount, 1);

    // The winner's order is retrievable; the loser's cart stays open
    const winner = results.find((r) => r.status === 201);
    assert.equal((await get(`/orders/${winner.json.id}`)).status, 200);
    const loserCartId = winner.json.cart_id === cartA ? cartB : cartA;
    assert.equal((await get(`/carts/${loserCartId}`)).json.status, 'open');
  });

  test('many simultaneous checkouts never oversell', async () => {
    const bookId = seedBook({ title: 'Limited', stock: 3 });
    const carts = [];
    for (let i = 0; i < 8; i++) {
      const cartId = await newCart();
      await post(`/carts/${cartId}/items`, { book_id: bookId, quantity: 1 });
      carts.push(cartId);
    }

    const results = await Promise.all(carts.map((id) => post(`/carts/${id}/checkout`, {})));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(results.filter((r) => r.status === 409).length, 5);
    assert.equal(stockOf(bookId), 0);
  });
});

// ---------- security ----------

describe('GET /health authentication', () => {
  test('without token -> 200, not admin', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.ok(res.json.admin === undefined || res.json.admin === false);
  });

  test('with wrong token -> 401', async () => {
    const res = await get('/health', { Authorization: 'Bearer definitely-not-the-token' });
    assert.equal(res.status, 401);
    assert.notEqual(res.json?.admin, true);
  });

  test('with correct token -> 200 admin: true', async () => {
    const res = await get('/health', { Authorization: `Bearer ${ADMIN_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.json.admin, true);
  });

  test('scheme is case-insensitive', async () => {
    const res = await get('/health', { Authorization: `bearer ${ADMIN_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.json.admin, true);
  });

  test('tokens of different lengths are rejected safely (no crash)', async () => {
    const attempts = [
      'a',
      ADMIN_TOKEN.slice(0, -1),
      ADMIN_TOKEN + 'x',
      ADMIN_TOKEN.slice(0, ADMIN_TOKEN.length / 2),
      'x'.repeat(10_000),
    ];
    for (const token of attempts) {
      const res = await get('/health', { Authorization: `Bearer ${token}` });
      assert.equal(res.status, 401, `token of length ${token.length} must be rejected`);
    }
  });

  test('malformed Authorization headers -> 401', async () => {
    const headers = [
      'Bearer',
      'Bearer ',
      `Basic ${ADMIN_TOKEN}`,
      ADMIN_TOKEN, // no scheme
      `Token ${ADMIN_TOKEN}`,
      `Bearer${ADMIN_TOKEN}`,
    ];
    for (const value of headers) {
      const res = await get('/health', { Authorization: value });
      assert.equal(res.status, 401, `header "${value}" must be rejected`);
      assert.notEqual(res.json?.admin, true);
    }
  });

  test('401 response does not leak the expected token', async () => {
    const res = await get('/health', { Authorization: 'Bearer wrong' });
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes(ADMIN_TOKEN));
  });

  test('rejects all tokens when ADMIN_TOKEN is unset', async () => {
    const saved = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    try {
      const res = await get('/health', { Authorization: 'Bearer ' });
      assert.equal(res.status, 401);
      const res2 = await get('/health', { Authorization: 'Bearer anything' });
      assert.equal(res2.status, 401);
    } finally {
      process.env.ADMIN_TOKEN = saved;
    }
  });
});

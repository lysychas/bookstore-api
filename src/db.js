import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Load environment variables dynamically before initializing DATABASE_PATH
try {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch (err) {
  // Gracefully fallback if process.loadEnvFile is not supported
}

const DEFAULT_DATABASE_PATH = './bookstore.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock       INTEGER NOT NULL CHECK (stock >= 0)
  );

  CREATE TABLE IF NOT EXISTS carts (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id  TEXT    NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    book_id  INTEGER NOT NULL REFERENCES books(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    UNIQUE (cart_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    cart_id     TEXT    NOT NULL UNIQUE REFERENCES carts(id),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id),
    title       TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    quantity    INTEGER NOT NULL CHECK (quantity > 0)
  );

  CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id   ON cart_items(cart_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
`;

export const SEED_BOOKS = [
  { title: 'The Hobbit', author: 'J.R.R. Tolkien', price_cents: 1499, stock: 10 },
  { title: '1984', author: 'George Orwell', price_cents: 999, stock: 5 },
  { title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', price_cents: 1250, stock: 0 },
];

/** Create all tables and indexes if they do not exist yet. */
export function initSchema(database) {
  database.exec(SCHEMA);
}

/** Insert the initial catalog, but only when the books table is empty. */
export function seedBooks(database) {
  const { count } = database.prepare('SELECT COUNT(*) AS count FROM books').get();
  if (count > 0) return false;

  const insert = database.prepare(
    'INSERT INTO books (title, author, price_cents, stock) VALUES (?, ?, ?, ?)',
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    // Re-check inside the write lock so concurrent starters cannot double-seed.
    const recheck = database.prepare('SELECT COUNT(*) AS count FROM books').get();
    if (recheck.count === 0) {
      for (const b of SEED_BOOKS) {
        insert.run(b.title, b.author, b.price_cents, b.stock);
      }
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return true;
}

/**
 * Open (and initialise) a SQLite database at `path`.
 * Creates the parent directory, applies pragmas, creates the schema and seeds books.
 */
export function openDatabase(path = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  const isMemory = path === ':memory:';
  if (!isMemory) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');

  initSchema(database);
  seedBooks(database);
  return database;
}

/** Run `fn` inside a BEGIN IMMEDIATE transaction; commits on success, rolls back on throw. */
export function withTransaction(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

// Default instance. NOTE: DATABASE_PATH is read at import time, so load .env
// (process.loadEnvFile) before importing this module.
export const db = openDatabase();
export default db;

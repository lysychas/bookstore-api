# Plan - JSON Backend for Online Bookstore

This plan outlines the architecture, database design, API endpoints, testing strategy, and containerization setup for a lightweight, secure online bookstore JSON API using Node.js 26+, Express 5, and the built-in `node:sqlite` module.

## Top-Level Overview
The bookstore backend is a lightweight microservice built with zero unnecessary dependencies (only Express 5 is used as a runtime dependency). It manages a book catalog, cart creation and item updates, transactional checkout, and order lookup.

To ensure extreme reliability and compliance:
1. **Node.js 26+ built-in features** are leveraged:
   - `node:sqlite` (`DatabaseSync`) for fully local, synchronized, and transaction-safe database access.
   - `node:crypto` (`randomUUID` and `timingSafeEqual`) for secure, collision-free identifiers and constant-time token comparison.
   - `process.loadEnvFile()` for loading git-ignored environment variables from `.env` programmatically, avoiding a third-party `dotenv` dependency.
   - Node's built-in test runner (`node:test`) and assertion library (`node:assert`) for lightweight, dependency-free testing.
2. **Robust Concurrency Handling** is implemented using standard SQLite `BEGIN IMMEDIATE TRANSACTION` blocks to block concurrent checkout races, ensuring that stock is checked and decremented atomically.
3. **Containerization via Podman** is achieved using a multi-stage Dockerfile built on Red Hat's public `ubi-minimal` image. It runs as a non-root numeric user (UID `1001`), maps data to a persistent volume, and binds the port to `127.0.0.1` (localhost) only.

---

## Architectural Decisions & Choices

| Topic | Selected Choice | Reason |
|---|---|---|
| **Env Files** | Programmatic `process.loadEnvFile('.env')` | Eliminates the `dotenv` dependency; safely falls back to container environment variables if `.env` does not exist. |
| **JSON Error Responses** | Global Error Handler & Body Parser Guard | Express 5 global error middleware catches SyntaxError and returns `{"error": "Invalid JSON"}` instead of an HTML page. |
| **Money Storage** | Store integer cents (`price_cents`) | Completely avoids floating-point inaccuracies. Conversion to/from decimal string happens at input/output. |
| **ID Generation** | `crypto.randomUUID()` | Built-in cryptographically secure random identifiers (V4 UUID) for carts and orders. |
| **Token Verification** | SHA-256 Hashing + `timingSafeEqual` | Standard secure pattern to prevent timing attacks and handle arbitrary length user-supplied inputs safely. |
| **Database Operations** | Synchronous `DatabaseSync` in WAL mode | Ultra-fast local execution; simplifies transactional flow and guarantees atomic writes without race conditions. |

---

## Sub-Tasks

### 1. Project Initialization & Configuration
- **Intent**: Scaffold the project, configure dependencies, git-ignore sensitive assets, and provide env templates.
- **Expected Outcomes**: Valid `package.json`, `.gitignore`, `.env.example` in place.
- **Todo List**:
  - [x] Create `package.json` with Express 5, test/start scripts.
  - [x] Create `.gitignore` ignoring `.env`, `node_modules`, and sqlite `.db` files.
  - [x] Create `.env.example` defining `BIND_ADDRESS`, `PORT`, `DATABASE_PATH`, and `ADMIN_TOKEN`.
- **Relevant Context**: `package.json`, `.env.example`, `.gitignore`
- **Status**: `[x] done`

### 2. Database Schema Design & Initialization
- **Intent**: Set up the database connection, create table schemas, and seed initial catalog data if empty.
- **Expected Outcomes**: `src/db.js` module that opens a SQLite database, enforces foreign key constraints, sets busy timeouts, and runs the schema setup and data seeding.
- **Todo List**:
  - [x] Create `src/db.js` using `node:sqlite`.
  - [x] Design tables for `books`, `carts`, `cart_items`, `orders`, and `order_items`.
  - [x] Implement automatic schema creation and data seeding (3 books: "The Hobbit", "1984", and "The Great Gatsby" (out of stock)).
- **Relevant Context**: `src/db.js`
- **Status**: `[x] done`

### 3. Core Utilities
- **Intent**: Implement secure token validation and exact decimal-to-cents parsing/formatting helpers.
- **Expected Outcomes**: `src/security.js` with constant-time token comparison; `src/money.js` with exact cent/decimal conversions without float arithmetic.
- **Todo List**:
  - [x] Implement secure constant-time comparator using SHA-256 and `crypto.timingSafeEqual` in `src/security.js`.
  - [x] Implement `centsToDecimal` and `decimalToCents` formatting and validation helpers in `src/money.js`.
- **Relevant Context**: `src/security.js`, `src/money.js`
- **Status**: `[x] done`

### 4. API Endpoints Implementation
- **Intent**: Build the Express application routes, middleware, and error handling.
- **Expected Outcomes**: Robust, crash-proof Express app in `src/app.js` and server entry point in `src/server.js`.
- **Todo List**:
  - [x] Implement `src/app.js` with body parsing and general error-handling middleware (replaces Express HTML with custom JSON shape `{"error": "<message>"}`).
  - [x] Implement POST body strict validator middleware (must be JSON object, reject array/scalar/missing).
  - [x] Implement `GET /health` with Bearer token admin detection.
  - [x] Implement catalog endpoints: `GET /books` and `GET /books/:id`.
  - [x] Implement cart endpoints: `POST /carts`, `GET /carts/:id`, and `POST /carts/:id/items` (checks stock, cart checked out status, is standard JSON POST).
  - [x] Implement checkout endpoint: `POST /carts/:id/checkout` (runs as a transaction, decrements stock, freezes book details into `order_items`, marks cart checked out, returns order).
  - [x] Implement order endpoint: `GET /orders/:id`.
  - [x] Create server entry point in `src/server.js` that loads `.env` and starts the app on the configured port and bind address.
- **Relevant Context**: `src/app.js`, `src/server.js`
- **Status**: `[x] done`

### 5. Automated Testing
- **Intent**: Verify functional correctness, edge cases, strict inputs, and concurrent checkouts.
- **Expected Outcomes**: Fully passing test suite in `tests/bookstore.test.js` using Node's test runner.
- **Todo List**:
  - [x] Set up integration testing structure using port 0.
  - [x] Write catalog tests (browse, get single, 404).
  - [x] Write cart and item update tests (valid updates, invalid POST bodies, stock limit checks, 404 and 409 states).
  - [x] Write transaction checkout tests (happy path, empty cart checkout -> 400, double checkout -> 409).
  - [x] Write high-concurrency race condition tests (two simultaneous checkout requests competing for the last copy of a book; verifying exactly one succeeds and stock stays >= 0). In-process these are functional checks only, since `DatabaseSync` is synchronous.
  - [x] Write a multi-process contention test (`tests/contention.test.js`): three server processes share one database file; verified to fail when `BEGIN IMMEDIATE` is replaced by `BEGIN`.
  - [x] Write security tests (invalid tokens, constant-time compare handles empty/malformed tokens).
- **Relevant Context**: `tests/bookstore.test.js`
- **Status**: `[x] done`

### 6. Containerization & Documentation
- **Intent**: Package the application securely and provide detailed setup instructions.
- **Expected Outcomes**: Secure Dockerfile, `compose.yaml`, and complete `README.md`.
- **Todo List**:
  - [x] Create `Dockerfile` based on `registry.access.redhat.com/ubi9/ubi-minimal`, installing Node.js 26 and running as non-root numeric user (UID `1001`) and a `HEALTHCHECK`.
  - [x] Create `compose.yaml` mapping database to a persistent volume, binding the port to `127.0.0.1` only, and supplying environment variables.
  - [x] Create `README.md` covering API endpoints (with curl examples), local setup, Podman execution, and testing instructions.
- **Relevant Context**: `Dockerfile`, `compose.yaml`, `README.md`
- **Status**: `[x] done`

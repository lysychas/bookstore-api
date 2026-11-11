# Bookstore API

A lightweight JSON backend for an online bookstore, built with Node.js 26, Express 5 and the built-in `node:sqlite` module. Express is the only runtime dependency.

Features: book catalog, carts, transactional checkout (stock is checked and decremented atomically), and order lookup.

## Table of Contents

- [Setup & Installation](#setup--installation)
- [Environment Configuration](#environment-configuration)
- [API Endpoints](#api-endpoints)
- [Running Tests](#running-tests)
- [Container Execution](#container-execution)

## Setup & Installation

**Prerequisites:** Node.js 26 or newer (`node --version`) and npm.

```bash
git clone <repository-url> bookstore-api
cd bookstore-api
npm ci

cp .env.example .env
# Edit .env and set a strong ADMIN_TOKEN (see below)

npm start
```

The server listens on `http://127.0.0.1:3000` by default. On first start it creates the SQLite database, applies the schema and seeds three books (*The Hobbit*, *1984*, and *The Great Gatsby*, which is out of stock).

## Environment Configuration

Settings are read from the process environment. A git-ignored `.env` file in the working directory is loaded automatically if present (via `process.loadEnvFile`); real environment variables take precedence.

| Variable        | Default           | Description |
|-----------------|-------------------|-------------|
| `BIND_ADDRESS`  | `127.0.0.1`       | Interface to bind to. Keep it on loopback or a specific internal IP; do not use `0.0.0.0`. |
| `PORT`          | `3000`            | TCP port to listen on. |
| `DATABASE_PATH` | `./bookstore.db`  | Path of the SQLite database file. The parent directory is created if missing. `:memory:` is supported. |
| `ADMIN_TOKEN`   | *(none)*          | Bearer token that unlocks admin detection on `GET /health`. If unset, every token is rejected. |

Generate a strong token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

> Never commit `.env`. It is listed in `.gitignore` and `.dockerignore`.

## API Endpoints

All `POST` requests must send `Content-Type: application/json` and a JSON **object** body (send `{}` when there is nothing to send). Arrays, scalars, `null` and malformed JSON are rejected with `400`. Errors always have the shape `{"error": "<message>"}`.

Prices are decimal strings (`"14.99"`); they are stored internally as integer cents.

| Method | Path                   | Description |
|--------|------------------------|-------------|
| GET    | `/health`              | Liveness probe; optional admin check |
| GET    | `/books`               | List all books |
| GET    | `/books/:id`           | Get a single book |
| POST   | `/carts`               | Create a cart |
| GET    | `/carts/:id`           | View a cart and its items |
| POST   | `/carts/:id/items`     | Add a book to a cart |
| POST   | `/carts/:id/checkout`  | Check out a cart and create an order |
| GET    | `/orders/:id`          | View an order |

The examples below assume `BASE=http://127.0.0.1:3000`.

### GET /health

```bash
curl $BASE/health
```
```json
{"status":"ok"}
```

With the admin token:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/health
```
```json
{"status":"ok","admin":true}
```

A wrong or malformed token returns `401 {"error":"Unauthorized"}`.

### GET /books

```bash
curl $BASE/books
```
```json
[
  {"id":1,"title":"The Hobbit","author":"J.R.R. Tolkien","price":"14.99","stock":10},
  {"id":2,"title":"1984","author":"George Orwell","price":"9.99","stock":5},
  {"id":3,"title":"The Great Gatsby","author":"F. Scott Fitzgerald","price":"12.50","stock":0}
]
```

### GET /books/:id

```bash
curl $BASE/books/1
```
```json
{"id":1,"title":"The Hobbit","author":"J.R.R. Tolkien","price":"14.99","stock":10}
```

| Status | Reason |
|--------|--------|
| 400    | `id` is not a number |
| 404    | `{"error":"Book not found"}` |

### POST /carts

```bash
curl -X POST $BASE/carts -H 'Content-Type: application/json' -d '{}'
```
`201 Created`
```json
{"id":"8683ac52-e1d4-4372-8e0b-ccd920e4047d","status":"open","created_at":"2026-11-11T20:42:52.967Z"}
```

### GET /carts/:id

```bash
curl $BASE/carts/8683ac52-e1d4-4372-8e0b-ccd920e4047d
```
```json
{
  "id": "8683ac52-e1d4-4372-8e0b-ccd920e4047d",
  "status": "open",
  "created_at": "2026-11-11T20:42:52.967Z",
  "items": [
    {"book_id":1,"title":"The Hobbit","author":"J.R.R. Tolkien","price":"14.99","quantity":2}
  ]
}
```

`404 {"error":"Cart not found"}` if the cart does not exist.

### POST /carts/:id/items

Adds a book to the cart. Adding the same book again increases its quantity. `book_id` and `quantity` must be positive integers.

```bash
curl -X POST $BASE/carts/8683ac52-e1d4-4372-8e0b-ccd920e4047d/items \
  -H 'Content-Type: application/json' \
  -d '{"book_id":1,"quantity":2}'
```
`200 OK` (the resulting cart line)
```json
{"book_id":1,"title":"The Hobbit","author":"J.R.R. Tolkien","price":"14.99","quantity":2}
```

| Status | Reason |
|--------|--------|
| 400    | Missing or invalid `book_id` / `quantity` |
| 404    | Cart or book not found |
| 409    | Cart already checked out, or requested quantity exceeds stock |

### POST /carts/:id/checkout

Runs in a single `BEGIN IMMEDIATE` transaction: verifies stock, decrements it, freezes book details into the order, and marks the cart `checked_out`.

```bash
curl -X POST $BASE/carts/8683ac52-e1d4-4372-8e0b-ccd920e4047d/checkout \
  -H 'Content-Type: application/json' -d '{}'
```
`201 Created`
```json
{
  "id": "1cc8e8f5-d1ab-497e-9cc6-af76ff7f9dce",
  "cart_id": "8683ac52-e1d4-4372-8e0b-ccd920e4047d",
  "total": "29.98",
  "created_at": "2026-11-11T20:42:53.061Z",
  "items": [
    {"book_id":1,"title":"The Hobbit","author":"J.R.R. Tolkien","price":"14.99","quantity":2}
  ]
}
```

| Status | Reason |
|--------|--------|
| 400    | Cart is empty |
| 404    | Cart not found |
| 409    | Cart already checked out, or insufficient stock |

### GET /orders/:id

```bash
curl $BASE/orders/1cc8e8f5-d1ab-497e-9cc6-af76ff7f9dce
```

Returns the same shape as the checkout response. `404 {"error":"Order not found"}` if unknown.

## Running Tests

Tests use Node's built-in test runner against an isolated database; no extra dependencies are required.

```bash
npm ci
npm test
```

The suite covers the catalog, cart and item rules, checkout (including empty and double checkout), concurrent checkouts for the last copy of a book, admin token handling, and the money/token helpers. [`tests/contention.test.js`](tests/contention.test.js) starts three server processes on one shared SQLite file and races checkouts across them; this is the test that actually exercises `BEGIN IMMEDIATE` and `busy_timeout` (inside a single Node process `DatabaseSync` calls are already serialised).

## Container Execution

The image is a multi-stage build on `registry.access.redhat.com/ubi9/ubi-minimal`. The build stage downloads Node.js 26.13.1 from the official binary release (SHA-256 verified, x86_64 and aarch64 supported) and installs production dependencies; the runtime stage contains only the `node` binary, `libatomic`, `node_modules` and `src/`. It runs as the non-root numeric user `1001` and defines a `HEALTHCHECK` against `/health`. The SQLite database lives in `/data`, which should be backed by a volume.

Podman ignores `HEALTHCHECK` for OCI-format images; build with `podman build --format docker ...` to keep it (`compose.yaml` defines its own healthcheck either way).

### Podman / Docker (single container)

Replace `podman` with `docker` if you prefer.

```bash
# Build
podman build -t bookstore-api:latest .

# Create a persistent volume and a network with a fixed subnet
podman volume create bookstore_data
podman network create --subnet 10.89.60.0/24 bookstore_net

# Run, binding to a specific internal IP (never 0.0.0.0) and publishing on host loopback only
podman run -d --name bookstore-api \
  --network bookstore_net --ip 10.89.60.10 \
  -p 127.0.0.1:3000:3000 \
  -v bookstore_data:/data \
  -e BIND_ADDRESS=10.89.60.10 \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" \
  --read-only --cap-drop=ALL --security-opt no-new-privileges \
  bookstore-api:latest
```

The default `BIND_ADDRESS=127.0.0.1` is only reachable from inside the container, so a published port would not work. Binding to the container's fixed internal IP keeps the service off all-interface binding, while `-p 127.0.0.1:3000:3000` limits host exposure to loopback. The Compose setup below does the same.

### Podman Compose / Docker Compose

`compose.yaml` builds the image, publishes `127.0.0.1:3000:3000` (localhost only), stores the database at `DATABASE_PATH=/data/bookstore.db` on the named volume `bookstore_data`, and runs the container read-only with all capabilities dropped.

`ADMIN_TOKEN` is **required** and is never stored in the compose file. Provide it from your shell or from a git-ignored `.env` file next to `compose.yaml`:

```bash
export ADMIN_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"

podman-compose up -d --build     # or: docker compose up -d --build
curl http://127.0.0.1:3000/health
podman-compose logs -f           # follow logs
podman-compose down              # stop; data is kept in the volume
podman-compose down -v           # stop and DELETE the database volume
```

If `ADMIN_TOKEN` is missing, Compose stops with an error instead of starting an unprotected service.

### Not included

TLS termination, rate limiting and a log pipeline are out of scope: run the service behind a TLS-terminating reverse proxy if it is reachable by anything other than the local host.

### Notes

- Data persists across `down`/`up` cycles because it is stored in the `bookstore_data` volume.
- The Compose network uses the fixed subnet `10.89.50.0/24`; change it in `compose.yaml` if it clashes with an existing network.
- When running rootless Podman on macOS, the Podman machine must be running (`podman machine start`).

## License

MIT

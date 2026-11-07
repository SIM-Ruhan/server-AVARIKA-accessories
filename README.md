# AVARIKA server

Express 5 + MongoDB native driver. Single owner/admin and customers only. JavaScript ES modules. No Mongoose, Stripe, multi-seller roles, subscriptions, or listing limits.

Read **SETUP.md** for full bash instructions, MongoDB configuration, and payment setup.

## Quick start

```bash
cd avarika-server
npm ci
cp .env.example .env
```

Edit `.env` with your MongoDB URI, set `BETTER_AUTH_URL=http://localhost:3000`, and generate `BETTER_AUTH_SECRET` using `openssl rand -base64 32`. For an existing installation, follow the Better Auth upgrade steps at the top of **SETUP.md** and run `npm run migrate:auth` before startup. The database must be a **replica set or sharded cluster**, because stock and order changes use multi-document transactions. MongoDB Atlas works, or use the local replica-set Compose file:

```bash
docker compose up -d
docker compose ps
```

After MongoDB is healthy:

```bash
npm run seed
```

Set `ADMIN_NAME`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` of at least 12 characters in `.env`, then:

```bash
npm run admin
```

Remove `ADMIN_PASSWORD` from `.env` after provisioning. No default admin credentials are shipped. The script refuses to overwrite an account, silently promote a customer, or create another admin when one exists.

```bash
npm run dev
```

API: `http://localhost:5000/api`. Health check: `GET /api/health`.

## Application structure

| File | Responsibility |
| --- | --- |
| `src/index.js` | Startup, shutdown, expired reservation cleanup |
| `src/config.js` | Environment settings |
| `src/db.js` | Native driver connection, indexes, transaction helper |
| `src/auth.js` | Better Auth configuration, native MongoDB adapter, session/role checks |
| `src/domain.js` | Validation, money, totals, public projections, payment checks |
| `src/app.js` | HTTP endpoints, origin guard, access control, middleware |
| `src/orders.js` | Atomic checkout, stock, idempotency, settlement, fulfillment |
| `src/payments.js` | SSLCOMMERZ hosted wallet initiation and validation |
| `scripts/seed.js` | Idempotent sample product seeding; does not overwrite products |
| `scripts/create-admin.js` | Transactional owner + Better Auth credential provisioning |
| `src/auth-migration.js`, `scripts/migrate-auth.js` | Preserve legacy accounts and move credentials to Better Auth |

Collections: `users`, `authAccounts`, `authSessions`, `authVerifications`, `products`, `carts`, `orders`, `reviews`. The old `sessions` collection is no longer used.

## Commerce rules

- All money is stored as integer paisa. API product forms accept BDT, converted by the server.
- Checkout takes product IDs/quantities, reads current prices/costs/stock from MongoDB, and recomputes the total. The expected total must match; changed prices require customer confirmation.
- An order, its stock reservation, and cart deduction commit together. A failed transaction cannot partially consume stock.
- `idempotencyKey` is unique per customer. Repeated identical requests return the existing order; a changed payload with the same key is rejected.
- Online orders reserve stock for 30 minutes. The long-running server checks expiry every minute and on startup. Expiry/cancellation restores stock only once.
- COD reserves stock immediately. On delivery, the admin explicitly confirms receipt and cash collection; then it counts as paid.
- Online settlement requires provider API validation matching transaction ID, BDT, exact amount, and a validation ID. The actual wallet channel and risk flag are checked.
- Duplicate IPNs are idempotent. Delayed valid payments try to re-reserve released stock; insufficient stock, a cancelled order, risk, or a mismatched wallet enters `payment_review` instead of automatic fulfillment.
- Review/refund exceptions are handled with the merchant before shipping. Automatic refunds and an admin override of risky payments are not implemented.
- Normal fulfillment is `pending → processing → shipped → delivered`. Wallet orders must be verified paid first. Unpaid orders can be cancelled subject to their status.
- Customers can only read/change their own orders and cart. Only customers with a delivered purchase can review that product; one editable review per product/customer.
- Product “delete” archives the record so past orders retain history. Reactivate through Edit. Editing a sample product makes it a regular catalog item.
- Costs, gross margins, gateway sessions, callback tokens, and validation IDs are excluded from customer-facing order/product responses.

## Authentication

Better Auth **1.7.17** handles email registration/login, signed HttpOnly session cookies, database sessions, and logout. It uses the native MongoDB adapter with transactions. New password hashes use scrypt. The migration preserves existing bcrypt credentials and IDs so users retain their passwords and commerce history.

The Express handler lives at `/api/auth/{*path}` and is mounted before JSON parsing. The client calls Better Auth through the same-origin Next.js proxy. `BETTER_AUTH_URL` and `CLIENT_ORIGIN` must both equal the public frontend origin without a trailing slash. `BETTER_AUTH_SECRET` stays on the server. Production requires HTTPS and sets Secure cookies.

Public signup cannot assign admin privilege. Every protected commerce request loads the current MongoDB user to check permissions and block status. Blocking a customer revokes their Better Auth sessions and prevents new logins. The auth client refreshes sessions on focus and every minute; the server remains the authorization authority.

Both Express and Better Auth apply rate limiting. Express overwrites the internal `x-avarika-client-ip` header from its trusted `req.ip`; set `TRUST_PROXY` according to the actual reverse-proxy chain. Use a shared limiter store before scaling to multiple API processes.

Recovery emails, email verification delivery, social login, and MFA are not configured. There are no default credentials or a default auth secret.

## Tests

```bash
npm test
npm run check
```

Result during creation: **37 passing tests, 0 failures, 1 skipped MongoDB integration suite**. Authentication tests use the real Better Auth HTTP handler with its official memory adapter; the domain tests exercise real calculation and validation functions. They do not substitute for the MongoDB integration suite.

Run the included real transactional integration suite against a dedicated reachable replica set:

```bash
NODE_ENV=test TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run test:integration
```

It creates a uniquely named `avarika_test_...` database and drops only that database when finished. It checks legacy credential migration, preserved IDs, Better Auth registration/login, authorization, product creation, persistent carts, stock reservation, repeat checkout, price tampering, COD fulfillment, reviews, concurrent stock purchase, wallet validation/IPN, and session revocation. Wallet responses in this test are test doubles; no real money is moved.

The built Next.js API proxy also passed an HTTP smoke check for registration, cookies, session retrieval, logout/revocation, and login against the real Better Auth handler with the memory adapter.

The creation environment blocked `mongod` with `open: Operation not permitted`, so this suite was not executed here. Live gateway validation was also not exercised without merchant credentials.

## Runtime

Run as a long-lived Node service with `npm start`. The stock-expiry timer is part of this process; this server is not packaged as a Vercel serverless function. If you move it to a serverless environment, first replace the interval with a durable scheduled worker invoking the same expiry service.

Use one instance for the included in-memory rate limiter, or replace its store with a shared limiter when scaling across instances. MongoDB remains the source of truth for sessions, stock, and orders.

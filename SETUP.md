# AVARIKA — setup and launch guide

Two independent projects: **avarika-client** (Next.js, JavaScript/JSX) and **avarika-server** (Express + MongoDB native driver). Keep them next to each other for local development. There is no Mongoose, TypeScript application source, Stripe integration, seller subscription, or multi-seller system.

## Upgrade an existing AVARIKA installation to Better Auth

This version replaces the earlier custom authentication with **Better Auth 1.7.17**. Both ZIPs must be updated together. Registration, login, logout, session refresh, navbar state, and protected commerce endpoints use Better Auth. The database remains native MongoDB; there is no Mongoose.

If you already installed the previous ZIPs:

1. Stop the old client/server processes. Back up your database and retain the old project folders. If you edited application code, merge those edits into the new version before switching.
2. Extract these updated ZIPs into a separate folder and copy your environment files. The following commands assume the updated ZIPs and the old `avarika-client/` and `avarika-server/` folders are in the current directory:

```bash
mkdir avarika-better-auth
unzip avarika-client.zip -d avarika-better-auth
unzip avarika-server.zip -d avarika-better-auth
cp avarika-server/.env avarika-better-auth/avarika-server/.env
cp avarika-client/.env.local avarika-better-auth/avarika-client/.env.local
cd avarika-better-auth/avarika-server
npm ci
openssl rand -base64 32
```

3. Put the generated value in the **server** `.env` as `BETTER_AUTH_SECRET`. Add these settings, using the public frontend origin for both URLs:

```dotenv
CLIENT_ORIGIN=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=PASTE_YOUR_GENERATED_SECRET_HERE
```

Do not copy that placeholder as your secret. Keep the generated value stable across server restarts and keep it out of the client environment and source control.

4. Ensure MongoDB is reachable, then migrate accounts and start the updated server:

```bash
npm run migrate:auth
npm run dev
```

The migration preserves user IDs, customer/admin roles, blocked status, and existing passwords. Orders, reviews, and carts keep the same user references. Each credential migration commits in a MongoDB transaction; rerunning skips already migrated users. Legacy bcrypt hashes move from `users.passwordHash` to Better Auth's credential accounts. New passwords use scrypt. The old custom sessions are removed; everyone signs in again. Existing Better Auth sessions are left intact on reruns. **Do not recreate an existing admin.**

5. In a second terminal, start the updated client:

```bash
cd /YOUR/PROJECT/PATH/avarika-better-auth/avarika-client
npm ci
npm run dev
```

Open `http://localhost:3000`. Log in with an existing account or register a new customer. If you have no existing users, the migration safely reports zero accounts; follow the admin setup below.

The previous `ECONNREFUSED 127.0.0.1:27017` error still means no MongoDB server is accepting connections there. Use your Atlas URI or start the included Docker replica set before running migration or starting Express. Installing Better Auth does not start MongoDB.

## Better Auth integration details

- Client: `src/lib/auth-client.js` exports `authClient`; the form calls `signUp.email` / `signIn.email`, and the provider uses `useSession` / `signOut`.
- Server: `src/auth.js` configures Better Auth with `@better-auth/mongo-adapter`. Its Express handler is mounted before body parsers.
- HTTP endpoints are `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/get-session`, and `/api/auth/sign-out`. The old `/register`, `/login`, `/me`, and `/logout` API endpoints are removed; browser page routes `/register` and `/login` stay the same.
- Collections are `users`, `authAccounts`, `authSessions`, and `authVerifications`. Existing commerce collections are unchanged. Auth sessions use Better Auth's token format; this version no longer uses the old SHA-256 token-hash store.
- Session cookies are HttpOnly and SameSite=Lax, and Secure in production. The browser uses the Next.js `/api` proxy, so no cross-domain token storage or localStorage auth token is needed.
- Customers cannot set `role` or `blocked` through registration/profile requests. Server middleware reloads the user's current database permissions for protected commerce endpoints. Blocking a customer deletes their Better Auth sessions and rejects new logins.
- Registration requires a name, valid email, and a 10–128-character password; the form also confirms the password. The admin provisioning script requires at least 12 characters.
- Auth attempts are rate limited. Express supplies a server-controlled IP header to Better Auth, replacing caller values. Configure `TRUST_PROXY` for your actual proxy chain; never trust arbitrary client forwarding headers.
- Email verification, password-reset email delivery, Google sign-in, and MFA are not configured by this update. Accounts are not marked email-verified merely because they registered.

Official integration references: [Express](https://better-auth.com/docs/integrations/express), [MongoDB adapter](https://better-auth.com/docs/adapters/mongo), [email/password](https://better-auth.com/docs/authentication/email-password).

## 1. Extract and check Node

Use Node.js **22 or newer**, npm, and either MongoDB Atlas or a local MongoDB replica set. Docker Desktop is optional for the local database recipe below. These commands work in macOS Terminal, Linux, or WSL.

From the folder containing the two ZIP files:

```bash
unzip avarika-client.zip
unzip avarika-server.zip
node --version
npm --version
```

Do not put one project inside the other.

```text
Your chosen folder/
  avarika-client/
  avarika-server/
```

## 2. Configure MongoDB and the server

```bash
cd avarika-server
npm ci
cp .env.example .env
```

Open `.env` in your editor and choose one database option.

**Option A — MongoDB Atlas:** set `MONGODB_URI` to your own Atlas driver connection URI and `MONGODB_DB=avarika`. The database user needs read/write and index permissions for this database. Allow the server's network access in Atlas. Percent-encode special characters in URI credentials.

```dotenv
MONGODB_URI=mongodb+srv://YOUR_DB_USER:YOUR_ENCODED_PASSWORD@YOUR_CLUSTER/avarika?retryWrites=true&w=majority
MONGODB_DB=avarika
```

**Option B — local Docker database:** the supplied Compose file creates a MongoDB replica set with persistent storage and a loopback-only port. Keep the default URI from `.env.example`.

```bash
# Run inside avarika-server
# Docker Desktop / Docker Engine must already be running.
docker compose up -d
docker compose ps
```

Wait until the Mongo service shows **healthy**. Its health check initializes the local `rs0` replica set. The local development database has no credentials and is bound only to 127.0.0.1; do not reuse that Compose configuration as a public database service.

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/avarika?replicaSet=rs0
MONGODB_DB=avarika
```

A standalone MongoDB instance is not enough: checkout uses transactions to keep stock, orders, and cart changes consistent. MongoDB supports these multi-document transactions on replica sets and sharded clusters. Reference: <https://www.mongodb.com/docs/manual/core/transactions/>.

Keep these local application settings:

```dotenv
NODE_ENV=development
PORT=5000
CLIENT_ORIGIN=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=PASTE_YOUR_GENERATED_SECRET_HERE
PUBLIC_API_URL=http://localhost:5000
TRUST_PROXY=0
```

Generate a secret with `openssl rand -base64 32` and replace `BETTER_AUTH_SECRET` in the server `.env` with its output. `BETTER_AUTH_URL` is the **frontend** origin used by the browser, not the separate Express address. It must exactly match `CLIENT_ORIGIN`.

Set your real customer support email and adjust the delivery defaults:

```dotenv
STORE_EMAIL=your-real-store-email@example.com
SHIPPING_DHAKA=80
SHIPPING_OUTSIDE=130
FREE_SHIPPING_THRESHOLD=3000
```

The three shipping settings are BDT amounts. These are editable starter values, not your established business policy.

## 3. Add sample products and create your admin

```bash
npm run seed
```

This adds eight sample accessories with original SVG illustrations. It preserves existing products. Sample product labels and specifications are visible; replace them with your real stock, materials, prices, costs, and images before launch. It does not create sample users, orders, revenue, or reviews.

Set these in the server `.env` using your own values:

```dotenv
ADMIN_NAME=Your name
ADMIN_EMAIL=your-admin-email@example.com
ADMIN_PASSWORD=YOUR_UNIQUE_PASSWORD_AT_LEAST_12_CHARACTERS
```

Then run:

```bash
npm run admin
```

The script will not overwrite an existing account or silently promote a registered customer. It refuses a second admin. **Remove the ADMIN_PASSWORD line after successful provisioning.** No shared/default login credentials are included in the source.

Start the backend and leave this terminal running:

```bash
npm run dev
```

Check it in another terminal:

```bash
curl http://localhost:5000/api/health
```

Expected response when MongoDB is connected: `{"ok":true}`.

## 4. Start the client in a second terminal

From the folder holding both extracted projects:

```bash
cd avarika-client
npm ci
cp .env.example .env.local
npm run dev
```

Client `.env.local`:

```dotenv
API_ORIGIN=http://127.0.0.1:5000
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Open **http://localhost:3000**. Use that exact origin consistently; changing to 127.0.0.1 in the browser will fail the configured mutation-origin check.

- Log in with your newly created admin email/password. Dashboard sends you to `/dashboard/admin`.
- Register a separate customer account to test the user portal.
- The visitor navbar has Log in and Sign up; authenticated users see Dashboard.
- Add real products from Admin → Add product.
- Feature/unfeature products from Admin → All products. The four newest active featured products appear on the homepage. Changes refresh the admin list automatically.
- Edit or archive products from the same list. Archiving removes them from the shop while preserving order history; Edit can reactivate them.
- Add to bag requires login. Buy now goes directly to checkout for the selected item/quantity.

## 5. Upload product images to ImgBB

Configure `NEXT_PUBLIC_IMAGEBB_KEY` in the client `.env.local` file. Product images are uploaded by the admin product form and saved as ImgBB HTTPS URLs; the backend only stores those URLs.

## 6. bKash, Nagad, and COD

**COD is built into the app. bKash and Nagad use SSLCOMMERZ hosted checkout**, with a selected merchant wallet channel. This is not a direct bKash or Nagad API integration and does not collect a customer PIN/OTP inside AVARIKA.

You need an SSLCOMMERZ merchant/sandbox account with the desired wallet channels enabled. Merchant onboarding and transaction fees are separate from this source code. Verify current terms with the provider:

- API documentation: <https://developer.sslcommerz.com/doc/v4/>
- Sandbox registration: <https://developer.sslcommerz.com/registration/>
- Merchant pricing/channel information: <https://sslcommerz.com/pricing/>

Set **server-only** environment values:

```dotenv
SSLCOMMERZ_STORE_ID=YOUR_SANDBOX_STORE_ID
SSLCOMMERZ_STORE_PASSWORD=YOUR_SANDBOX_STORE_PASSWORD
SSLCOMMERZ_LIVE=false
SSLCOMMERZ_BKASH_CHANNEL=bkash
SSLCOMMERZ_NAGAD_CHANNEL=nagad
```

Confirm the actual enabled channel codes with your merchant account. The two channel values are configurable because the hosted gateway's available channels depend on the merchant setup. When credentials are blank, checkout disables both wallets and keeps COD available. No fake successful payment is generated.

The provider must be able to reach the callbacks over a **public HTTPS** URL. Localhost alone cannot receive provider callbacks. Use your deployed HTTPS API, or a development HTTPS endpoint forwarding to the API. Set `PUBLIC_API_URL` to that origin, without `/api` and without a trailing slash, then restart the server.

Example using a separate API domain:

```dotenv
PUBLIC_API_URL=https://api.your-domain.com
```

The server supplies these URLs automatically when opening checkout:

```text
POST /api/payments/ssl/ipn
POST /api/payments/ssl/success?order=...&token=...
POST /api/payments/ssl/fail?order=...&token=...
POST /api/payments/ssl/cancel?order=...&token=...
```

Configure the IPN URL in the merchant portal as needed. If using the frontend domain to proxy callbacks, set `PUBLIC_API_URL` to that frontend HTTPS origin and confirm its `/api` rewrite reaches Express for POST requests.

Sandbox walkthrough:

1. Register a customer and add a product to the bag.
2. Choose bKash or Nagad, enter delivery details, and continue to the provider.
3. Complete a sandbox wallet transaction using the provider's current sandbox procedure.
4. Confirm the result page shows **paid** from the database, not merely a success query parameter.
5. Check Admin → Paid via bKash/Nagad, then the overview chart.
6. Test cancellation, failure, repeated notification, and a delayed return. The order must not become paid without API validation.
7. Test an interrupted payment through My orders → Continue payment. Reservations expire after 30 minutes; a new order is required after expiry.

After successful merchant testing, replace the sandbox credentials with live credentials and set `SSLCOMMERZ_LIVE=true`. The gateway URLs switch on the server.

COD walkthrough:

1. Select Cash on delivery and place an order.
2. Admin → Orders: move Pending → Processing → Shipped.
3. Mark Delivered only after delivery **and cash collection** are confirmed.
4. The order becomes paid and appears in revenue/gross-profit figures.
5. The customer can now leave or edit a review for the delivered product.

Paid orders cannot be cancelled through the unpaid cancellation button. Refunds, risky/channel-mismatched payments, and stock-shortfall exceptions require merchant review; automatic refunds and overriding payment-review states are outside this implementation.

## 7. Run checks

Client:

```bash
cd avarika-client
npm run build
```

Server:

```bash
cd avarika-server
npm test
npm run check
```

Real database integration (run from `avarika-server` with the local replica set running):

```bash
NODE_ENV=test TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run test:integration
```

The integration suite creates a unique `avarika_test_...` database and drops only that generated database. Its payment provider is mocked, so it does not charge real money. It now also checks native MongoDB credential migration, existing admin login, registration, role protection, and session revocation. The default authentication tests run the real Better Auth handler with its official memory adapter; they do not prove MongoDB transaction behavior.

Verification during creation:

| Check | Result |
| --- | --- |
| Next.js production compilation and route generation | Passed |
| Backend domain and Better Auth HTTP/authorization tests | 37 passed, 0 failures |
| Built Next.js API proxy: registration, cookies, session, logout, login | Passed using Better Auth with its memory adapter |
| Backend JavaScript syntax | Passed |
| Real MongoDB transaction/integration suite | Included but not run: local mongod was blocked by the environment |
| Live/sandbox gateway network transactions | Not run: merchant credentials were not supplied |
| Browser layout and full UI interaction QA | Not run: preview launcher passed unsupported flags to Next.js |

Manual checks after local setup:

- Test at 360px, 390px, 768px, and 1440px viewport widths; inspect navbar, filters, product details, checkout, and horizontally scrollable admin tables.
- Open/close mobile navigation using the keyboard; verify its dialog traps focus and Escape closes it.
- Pause the hero video; enable reduced motion and confirm the motion is reduced.
- Register/log in/log out; refresh a protected route; ensure a customer cannot access admin data.
- Search/filter/sort/paginate products; verify empty and unavailable-product states.
- Change cart quantity and remove an item; reload and check persistence.
- Create a COD order, double-submit/retry checkout, and verify one stock decrement.
- Cancel an eligible unpaid order and confirm stock returns once.
- Place simultaneous orders for the last unit and confirm one succeeds.
- Feature/unfeature/archive/edit a product; check list refresh and storefront behavior.
- Block a customer and check their existing session no longer works.
- Deliver a COD order; check revenue, gross profit, and verified review eligibility.
- Complete both wallet sandbox flows and the error cases listed above.

## 8. Production commands

Use HTTPS for both your customer-facing site and externally accessed API. Set the production variables **before building the client**.

Server `.env` example:

```dotenv
NODE_ENV=production
PORT=5000
MONGODB_URI=YOUR_PRODUCTION_REPLICA_SET_URI
MONGODB_DB=avarika
CLIENT_ORIGIN=https://www.your-domain.com
BETTER_AUTH_URL=https://www.your-domain.com
BETTER_AUTH_SECRET=YOUR_PRIVATE_RANDOM_SECRET
PUBLIC_API_URL=https://api.your-domain.com
TRUST_PROXY=1
```

Set `TRUST_PROXY` to the actual number of trusted reverse-proxy hops. It is 0 for direct local access. Keep secrets outside git.

Client `.env.local` example:

```dotenv
API_ORIGIN=https://api.your-domain.com
NEXT_PUBLIC_SITE_URL=https://www.your-domain.com
```

Run the backend as a long-running Node service (its timer releases expired stock):

```bash
cd avarika-server
npm ci --omit=dev
npm start
```

Run the frontend in a separate terminal/service:

```bash
cd avarika-client
npm ci
npm run build
npm start
```

Use your host's service manager to keep both processes running and configure HTTPS reverse proxies for the chosen domains. The client defaults to port 3000; the server defaults to 5000. Rebuild the client when `API_ORIGIN` changes. A persistent MongoDB Atlas/replica set stores all application records.

The Next.js client can run on a Next.js-compatible host with `API_ORIGIN` set before build. The provided Express entry point is a persistent Node server, not a serverless handler. Do not deploy its interval-based stock cleanup unchanged as a serverless function.

## 9. Common fixes

| Symptom | Fix |
| --- | --- |
| API unavailable / no collection | Start the backend; check `/api/health`, MongoDB access, and `API_ORIGIN` |
| `ECONNREFUSED 127.0.0.1:27017` | Start the included MongoDB replica set or replace the URI with your reachable Atlas cluster |
| `Legacy accounts found` | Stop the old server and run `npm run migrate:auth`, then restart |
| `Set BETTER_AUTH_SECRET` | Generate a random secret and add it to the server `.env` |
| MongoDB replica-set error | Use Atlas or the included Docker replica set, not standalone MongoDB |
| `Request origin is not allowed` | Match both `CLIENT_ORIGIN` and `BETTER_AUTH_URL` exactly to the browser origin; do not add a trailing slash |
| Login works but cookie disappears | Use HTTPS with `NODE_ENV=production`; use development mode for HTTP localhost |
| Wallet buttons disabled | Add server merchant credentials and restart |
| Provider return not received | Verify public HTTPS callbacks, IPN configuration, and forwarding of POST bodies |
| Payment awaiting verification | Check merchant transaction/IPN delivery; do not manually mark it paid from browser input |
| Product changed while editing | Reload the edit form; a stock/order update changed the version |
| Item no longer available | Refresh the bag or remove the archived/out-of-stock item |
| Admin email already exists | Provision with a distinct owner email; the script intentionally does not overwrite users |

## 10. Included scope and boundaries

The requested storefront, browse/detail routes, customer/admin portals, MongoDB persistence, server authorization, order stock handling, reviews, Bklit chart, and SSLCOMMERZ wallet/COD code are included. No site was published.

You still supply the real catalog, contact details/business policies, database, admin credentials, hosting, and merchant credentials. No live deployment or real wallet transaction is claimed. Password recovery emails, Google sign-in, file uploads, courier APIs, discount codes, automatic refunds, and tax-invoice services were not part of this build.

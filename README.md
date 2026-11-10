# BalanceIT – PG Expense Manager

BalanceIT is a private, responsive expense and settlement app for one household of exactly five roommates. It uses a vanilla JavaScript frontend, Express, SQLite for local development or PostgreSQL for hosted deployments, bcrypt password hashes, and HTTP-only server sessions. There is no public signup route.

## Requirements

- Node.js 22.13 or newer and npm
- SQLite is used by default for local development. Set `DATABASE_URL` to use hosted PostgreSQL.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a unique password of at least 10 characters for each of the five members. Keep `.env` private; it is ignored by Git. Leave `DATABASE_URL` empty for a local SQLite database.
3. Install dependencies with `npm install`.
4. Initialize the database and five accounts with `npm run seed` (or start directly; the server initializes an empty database on first start).
5. Start the app with `npm start` and open `http://localhost:3000`.

The starter usernames are `member1` through `member5`; `.env.example` leaves passwords blank so they must be set before seeding. Display names and usernames can also be changed there. The frontend receives only a member's display name and username after sign-in. Passwords and hashes stay on the server.

Seed accounts are inserted only when the users table is empty. Restarting the server never resets an existing password. To reset the database for a fresh development setup, stop the app, back up anything you need, remove the local SQLite database, update `.env`, and seed again. Do not delete a live production database to change credentials.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `NODE_ENV` | Set to `production` for secure cookies and proxy handling |
| `SESSION_SECRET` | Long, random session signing secret; use at least 32 characters in production |
| `DATABASE_URL` | PostgreSQL connection string; when set, the app uses PostgreSQL instead of SQLite |
| `DATABASE_PATH` | SQLite file path when `DATABASE_URL` is empty; new installations default to `./data/balanceit.sqlite` |
| `MEMBER_1_USERNAME` … `MEMBER_5_USERNAME` | The only five usernames allowed |
| `MEMBER_1_PASSWORD` … `MEMBER_5_PASSWORD` | Initial passwords; bcrypt hashes are stored in the configured database |
| `MEMBER_1_NAME` … `MEMBER_5_NAME` | Names shown in the app |

For a fresh setup, configure the five usernames and passwords before the first seed. Existing password hashes are not overwritten at startup. To deliberately rotate credentials, update all five member settings in `.env`, stop the app, back up the database, then run `npm run reset-credentials`. This command updates the five accounts in place and keeps their expense history and user IDs. Start the app again afterward. It does not print passwords.

## Features

- Five configured accounts, login rate limiting, bcrypt hashes, database-backed server sessions, HTTP-only SameSite cookies, and no public registration.
- Shared and personal expenses. Shared expenses split equally among selected participants; remainder paise go to the lowest member IDs first.
- Four independent votes per expense. Three approvals approve, two rejections reject, submitters cannot vote, and a unique database constraint prevents repeat votes.
- Pending expenses never affect the ledger. Personal expenses are approved and reported but excluded from shared fair shares and balances.
- Backend paise calculations, all-time member balances, minimum-count transfers for the five-member balance set, payer-requested/receiver-confirmed payments, immediate received-payment records, notifications, filtering, monthly reports, and CSV export.
- Reports-page data reset requests require four approvals total (the requester plus three other members). Two rejections close the request. On approval, the active expense and settlement ledger is archived for review, then cleared; the five accounts and reset audit history remain.
- Responsive desktop sidebar and compact mobile navigation, light and dark appearance toggle, loading/empty/error feedback, and approval polling while the approvals page is open.

## Tests

Run the automated business-logic tests with:

```sh
npm test
```

They cover expense creation, duplicate votes, approval and rejection thresholds, self-vote rejection, paise allocation and rounding, member balances, personal and pending expense exclusions, transfer matching, settlement confirmation, and the four-member data-reset quorum with preserved archives.

## API overview

All API responses and request bodies are JSON except CSV export. Every endpoint below except login and session status requires an authenticated session cookie. Mutations require the same origin when an `Origin` header is supplied. Amounts in write requests are rupee strings (for example, `"500.25"`); responses expose money as integer paise fields.

| Method and route | Purpose |
| --- | --- |
| `GET /api/auth/session` | Check whether the current browser is authenticated |
| `POST /api/auth/login` | Sign in with `{ "username", "password" }`; limited to 10 attempts per 15 minutes per IP |
| `POST /api/auth/logout` | Destroy the server session |
| `GET /api/members` | List the five public member IDs and display names |
| `GET /api/dashboard` | Dynamic summary, member balances, latest approved expenses, transfer suggestions, unread count |
| `GET /api/expenses` | Approved ledger; optional `month=YYYY-MM`, `year=YYYY`, `member`, `category`, `type`, `search`, `page`, `limit` filters |
| `GET /api/expenses/:id` | Expense details, split participants, and recorded votes |
| `POST /api/expenses` | Submit `{ title, amount, expenseDate, category, expenseType, participantIds }`; payer comes from the session |
| `GET /api/approvals` | Pending requests and recent approved/rejected decisions |
| `POST /api/approvals/:id/vote` | Submit `{ "vote": "approved" }` or `{ "vote": "rejected", "reason": "optional" }` |
| `GET /api/settlements` | Balances, recommended transfers, and settlement history |
| `POST /api/settlements` | Request `{ receiverId, amount, paymentDate, note }`; authenticated member is the payer and the receiver must confirm |
| `POST /api/settlements/received` | Record `{ payerId, amount, paymentDate, note }` as received immediately; authenticated member is the receiver |
| `POST /api/settlements/:id/confirm` | Confirm a pending transfer as its receiver; optional `amount` allows partial confirmation |
| `GET /api/notifications` | Current member's latest notifications and unread count |
| `PATCH /api/notifications/:id/read` | Mark one notification read |
| `PATCH /api/notifications/read-all` | Mark all current member notifications read |
| `GET /api/data-resets` | Current pending reset request and recent reset decision history |
| `POST /api/data-resets` | Request a ledger reset; requester is counted as the first approval |
| `POST /api/data-resets/:id/vote` | Submit `{ "vote": "approved" }` or `{ "vote": "rejected" }`; four approvals complete the reset, two rejections close it |
| `GET /api/data-resets/archives/:id` | Read a preserved expense and settlement snapshot after an approved reset |
| `GET /api/reports?year=YYYY&month=MM` | Monthly spending, member report, categories, and settlement history |
| `GET /api/reports/export.csv?year=YYYY&month=MM` | Download that report as CSV |

The API validates dates, categories, types, amounts, membership, vote permissions, receiver identity, and current balances on the server. It uses parameterized SQL. SQLite migrations are in `migrations/`; equivalent PostgreSQL migrations are in `migrations/postgres/`. Applied migration versions are recorded in `schema_migrations` for either database.

## Deploy

### Free Render + Supabase setup

1. Create a Supabase project on the Free plan. In Supabase, open **Connect**, choose the **Session pooler** connection string, and copy the URI. The session pooler works from hosts that only have IPv4 outbound access.
2. In Render, open the web service's **Environment** page and add `DATABASE_URL` with that full Supabase URI. Keep it private; do not paste it into source files, commits, screenshots, or chat. If Supabase's URI has a placeholder password, replace it with your database password. If the password has special URL characters, use the URI Supabase provides or URL-encode it.
3. Set `NODE_ENV=production`, `SESSION_SECRET` to a random value of at least 32 characters, and the five configured usernames, passwords, and display names. Keep using the same member credentials you want the five people to log in with.
4. Deploy with build command `npm ci` and start command `npm start`. On startup BalanceIT creates the PostgreSQL tables and indexes, then seeds the five users if the database has no users. No SQLite disk or `DATABASE_PATH` is needed in Render when `DATABASE_URL` is set.
5. Open the Render URL and sign in. The app now stores expenses and sessions in Supabase, so Render's idle spin-down does not erase the ledger.

Supabase Free can pause a project after inactivity and does not include automatic database backups. The project can be restored after pausing, but download your own database exports regularly. Free service limits can change, so check [Supabase Free plan details](https://supabase.com/docs/guides/platform/billing-on-supabase) and [backup guidance](https://supabase.com/docs/guides/platform/backups). Render Free web instances may still sleep while idle, which can make the first request take longer.

### Copy existing local SQLite history

If `data/roomledger.sqlite` contains history you want to keep, copy it before deploying the app to Supabase:

1. Stop the local app. Set `DATABASE_URL` in your local `.env` to the new Supabase Session pooler URI. Leave `DATABASE_PATH` pointing to your local SQLite file.
2. Import before anyone adds ledger records to Supabase. If the app has already seeded its five accounts, make sure those five usernames match the local SQLite usernames. If Supabase is still empty, set all five `MEMBER_n_USERNAME` and `MEMBER_n_PASSWORD` values locally; passwords must be at least 10 characters.
3. Run `npm run import-sqlite`. The importer refuses to mix data with existing expenses, settlements, reset history, or notifications. It copies the ledger and audit archives, keeps the five member IDs, and (when it imports the user rows) updates their password hashes from the configured environment variables. It does not copy login sessions, so everyone must sign in again.
4. Verify the ledger in the app. Keep a backup of the original SQLite file until you have confirmed the migration.

If the deployed Render SQLite database has already been erased and no local database or export contains those records, the data cannot be recovered from this code change. If you do not need to import local history, skip the importer; the app will create a clean ledger and seed the five configured accounts on its first start.

For local development, keep `DATABASE_URL` blank and run BalanceIT with SQLite as described above. On a different host, either use PostgreSQL with `DATABASE_URL` or ensure the SQLite file is on a persistent writable disk. Production session cookies require HTTPS; configure the host's trusted reverse proxy correctly if it terminates TLS.

No credentials or session secrets belong in frontend files or version control. The database includes password hashes and financial records; protect backups and storage accordingly.

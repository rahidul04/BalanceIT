# BalanceIT – PG Expense Manager

BalanceIT is a private, responsive expense and settlement app for one household of exactly five roommates. It uses a vanilla JavaScript frontend, Express, SQLite, bcrypt password hashes, and HTTP-only server sessions. There is no public signup route.

## Requirements

- Node.js 22.13 or newer and npm (BalanceIT uses Node's built-in synchronous SQLite driver)
- A persistent writable disk for the SQLite database in production

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a unique password of at least 10 characters for each of the five members. Keep `.env` private; it is ignored by Git.
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
| `DATABASE_PATH` | SQLite file path; new installations default to `./data/balanceit.sqlite` |
| `MEMBER_1_USERNAME` … `MEMBER_5_USERNAME` | The only five usernames allowed |
| `MEMBER_1_PASSWORD` … `MEMBER_5_PASSWORD` | Initial passwords; bcrypt hashes are stored in SQLite |
| `MEMBER_1_NAME` … `MEMBER_5_NAME` | Names shown in the app |

For a fresh setup, configure the five usernames and passwords before the first seed. Existing password hashes are not overwritten at startup. To deliberately rotate credentials, update all five member settings in `.env`, stop the app, back up the database, then run `npm run reset-credentials`. This command updates the five accounts in place and keeps their expense history and user IDs. Start the app again afterward. It does not print passwords.

## Features

- Five configured accounts, login rate limiting, bcrypt hashes, server-side SQLite sessions, HTTP-only SameSite cookies, and no public registration.
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

The API validates dates, categories, types, amounts, membership, vote permissions, receiver identity, and current balances on the server. It uses parameterized SQL. Migrations `001_initial.sql`, `002_confirmed_settlement_amount.sql`, and `003_data_reset_approval.sql` create and extend the normalized schema; applied migration versions are recorded in `schema_migrations`.

## Deploy

1. Deploy to a Node.js 22.13+ host that supports a persistent volume. Do not use an ephemeral filesystem for SQLite.
2. Build/install with `npm ci`, then run `npm start` as the service command. The startup path runs the initial migration and seeds accounts if the database is empty.
3. Mount a durable volume and set `DATABASE_PATH` to a file on that volume (for example `/var/lib/balanceit/balanceit.sqlite`). Ensure the service user can write to the directory. When no path is configured, BalanceIT reuses an existing `./data/roomledger.sqlite` database if present, preserving data from the previous app name.
4. Set `NODE_ENV=production`, a randomly generated `SESSION_SECRET` of at least 32 characters, all five unique account usernames, five strong initial passwords, and display names as host secrets/environment variables.
5. Serve behind HTTPS. Production session cookies are secure, HTTP-only, and SameSite Lax. Configure the host's trusted reverse proxy correctly if it terminates TLS.
6. Restrict access to environment configuration, back up the SQLite database regularly, and test restoring a backup before relying on it for household records.

No credentials or session secrets belong in frontend files or version control. The database includes password hashes and financial records; protect backups and storage accordingly.

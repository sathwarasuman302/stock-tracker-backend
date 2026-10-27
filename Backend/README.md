# Stock Tracker API

Express API for delayed Yahoo Finance market quotes and simulated quotes, and investor-scoped paper trading. In the normal `mongodb` storage mode, account data, deleted-account markers, investor ledgers, and custom stocks are persisted in separate MongoDB Atlas collections. Existing JSON files are migrated into these collections; source JSON files are left untouched. New password-hashed accounts added to the legacy backend account file after its initial migration are backfilled into `users` at startup, except accounts marked deleted.

### Atlas collections

In **Data Explorer → `stock_tracker`**, the backend stores:

- `users`: registered account documents for all roles. Passwords are salted hashes, never plaintext.
- `users_investor`: a synchronized copy of investor account documents only, with salted password hashes and creation timestamps. Investor registration, admin-created investor accounts, startup migration, and account deletion keep this collection in sync with `users`.
- `users_trader`: a synchronized copy of trader account documents only, with salted password hashes and creation timestamps. Trader registration, admin-created trader accounts, startup migration, and account deletion keep this collection in sync with `users`.
- `admin_overview`: synchronized overview summary and account rows derived from the other collections. Changes to users, trading accounts, or stocks refresh this collection.
- `deleted_users`: deletion-prevention markers; email addresses are hashed.
- `trading_accounts`: trader trading-account data only. Trader and investor accounts are created on registration and missing accounts for existing registered members are initialized during backend startup; account records include cash balance, positions, orders, and transactions.
- `investor_accounts`: investor trading-account data. The app reads this alongside `trading_accounts` so trader/investor features continue to work.
- `admin_trading_accounts`: separate storage to preserve any existing admin ledger data.
- `orders`: compatibility collection containing executed buy/sell orders from the combined ledger.
- `traders_orders`: completed trader BUY/SELL order records only, including account email and role.
- `investor_orders`: investor BUY/SELL records, kept separate so trader orders remain isolated.
- `trader_history`: trader completed-order history, synchronized from trader account orders.
- `investor_history`: investor completed-order history, synchronized from investor account orders.
- `trader_dashboard`: one live dashboard summary per trader, including balance, P&L, open positions, and five most recent orders. It is rebuilt whenever trading-account data is saved.
- `investor_dashboard`: one live dashboard summary per investor, including balance, P&L, open positions, and five most recent orders. It is rebuilt whenever trading-account data is saved.
- `trader_portfolio`: one complete portfolio record per trader, including balance, P&L, and open/closed positions. It is synchronized whenever trading-account data is saved.
- `investor_portfolio`: one portfolio summary per investor with balance, P&L, and complete open/closed position details. It is synchronized whenever trading-account data is saved.
- `holdings`: open positions for all roles.
- `closed_positions`: closed positions and realized P&L for all roles.
- `stocks`: all eight built-in stock catalog entries and any custom stocks added in the app. Quote history is not stored.
- `deleted_stocks`: IDs of stocks deleted by an administrator so they do not return on backend restart.
- `data_migrations`: required markers that prevent deleted records from being restored from old JSON files.
- `holdings` and `closed_positions` remain shared collections with account role and email fields identifying their owner. Former `_Trader` collections, if present, are left untouched by the app so their data is not deleted.
- `app_state` is not used by the current backend. The old migration lookup was removed; if this collection is empty, it can be dropped from Atlas without affecting the collections above.

## Run

### Connect MongoDB Atlas

1. In Atlas, open the `Stock-Tracker` project and create a cluster if one does not already exist.
2. Open **Security → Database Access** and create a database user. Save its username and password; these are not your Atlas website login.
3. Open **Security → Network Access → Add IP Address**. For local development, choose **Add Current IP Address** and save. The project screenshot's warning means the current IP still needs to be added. Avoid allowing access from anywhere except when you understand the risk.
4. Open **Database → Clusters → Connect → Drivers**, choose Node.js, and copy the connection string. Replace the password placeholder with the database user's password. URL-encode special characters in the username or password.
5. In VS Code, open the `Stock-Tracker` folder. Open a terminal and enter `Backend`. If `Backend/.env` does not exist yet, create it with `Copy-Item .env.example .env`.
6. Open `Backend/.env` and set `MONGO_URI` to the Atlas connection string. Ensure `STORAGE_DRIVER=mongodb` is present; do not put the MongoDB URI in a `VITE_` frontend variable. `server.js` uses Google and Cloudflare DNS (`8.8.8.8`, `1.1.1.1`) for MongoDB Atlas SRV lookup.
7. In that terminal, run `npm install` once and then `npm run dev`.
8. In a second VS Code terminal, enter `Frontend` and run `npm install` once, then `npm run dev`.
9. Open `http://localhost:5000/` or `http://localhost:5000/api/health`. A successful Atlas connection reports `"database":"connected"` and `"databaseName":"stock_tracker"`. The frontend is available at the Vite URL printed in its terminal.

The API listens on port `5000` by default, even while MongoDB is unavailable, so the health endpoint remains reachable during database connection problems. Check `GET /api/health` directly or through the frontend proxy at `http://localhost:5173/api/health`. A successful Atlas connection reports `"database":"connected"` and `"databaseName":"stock_tracker"`. If Atlas is unreachable, health returns HTTP 503 with `"database":"disconnected"` and database-backed API routes return HTTP 503. The backend reports the connection failure in its terminal and retries initialization every 10 seconds. Fix the URI, Atlas access, or network issue described in the terminal; once the database becomes reachable, initialization completes without restarting the server. It never silently switches to local files.

Set `PORT` in the backend process environment to use a different API port. If you change it, update the target in `vite.config.ts` as well.

`STORAGE_DRIVER=file` is reserved for the automated backend tests. Do not use it for normal Atlas-backed development.

### Market prices

Supported built-in stocks use delayed Yahoo Finance quotes, cached for five seconds. NSE symbols including HDFCBANK, ICICIBANK, ITC, and SBIN use Yahoo Finance's `.NS` suffix; BSE symbols use `.BO`, and NIFTY maps to `^NSEI`. Their stock-detail charts refresh the live delayed quote into the current candle; Yahoo Finance data is delayed, not exchange-tick real time. Custom stocks and indexes without Yahoo Finance mappings use simulated quotes. Admin sector lookup prefers a sector already stored in MongoDB and temporarily caches unavailable Yahoo profile results. `/api/market/quotes`, `/api/market/quote`, and `/api/market/index/quote` remain available while MongoDB initializes or is disconnected; database-backed routes, including paper-order fills, still require the database to be ready. Stock-detail charts use Yahoo Finance candle history and do not fabricate historical candles.

For TLS alerts or server-selection failures, confirm the cluster is running and add your current public IP under **Atlas → Security → Network Access**. If the IP is already allowed, test from another trusted network and check whether a VPN, firewall, or proxy is interrupting TLS. Do not disable TLS certificate validation.

If startup reports `MongoDB is not connected; cannot access the "data_migrations" collection`, make sure you are running `npm run dev` from the `Backend` directory and that `Backend/.env` contains a valid `MONGO_URI`. The backend now establishes the database connection before accessing collections.

## Account registration and login

- `POST /api/auth/register` creates an investor or trader account and rejects duplicate email addresses.
- `POST /api/auth/login` verifies the email and password and returns the public account profile.
- Admins can create accounts with `POST /api/admin/users`, list registered accounts with `GET /api/admin/users`, and permanently delete an account plus its trading data with `DELETE /api/admin/users/:email`. Admin-created accounts are stored in Atlas `users`; passwords are saved only as salted hashes.
- The Admin Users page copies older browser-local accounts into Atlas when an administrator opens that page. Browser-local accounts are separate per browser and cannot be copied from devices that have not opened the page.
- Admins can add or update a stock with `PUT /api/admin/stocks/:id`; its symbol, exchange, sector, price, and change percentage are saved in the `stocks` collection. `DELETE /api/admin/stocks/:id` removes it from `stocks` and records a tombstone in `deleted_stocks`, preventing built-in stocks from reappearing after restart.
- Admins can list the complete built-in and custom stock catalog with `GET /api/admin/stocks`. The Admin Stocks page loads this database-backed list and refreshes it after stock changes.
- Admins can list all persisted buy/sell orders across accounts and roles with `GET /api/admin/orders`. In MongoDB mode, this combines `traders_orders` and `investor_orders`.
- Admins can read the synchronized overview snapshot with `GET /api/admin/overview`. In MongoDB mode, the snapshot is stored in `admin_overview` and refreshed after persisted application data changes.
- Account records store salted scrypt password hashes, never plaintext passwords. Deleted email addresses are retained only as SHA-256 revocation markers to prevent stale sessions from recreating trading data.
- Registration returns the user to the login page; sign in with the same email and password to start a session.

## Investor paper-trading API

The existing frontend sends the logged-in user's email in the `X-Investor-Id` header. This scopes the following API data to that investor:

- `GET /api/investor/profile`, `GET /api/investor/balance`
- `GET /api/portfolio`, `GET /api/positions`, `GET /api/orders`, `GET /api/transactions`
- `POST /api/orders/buy`, `POST /api/orders/sell`
- `GET /api/admin/investors` returns member account summaries, positions, and orders to the admin panel.

Trading account storage is partitioned by both normalized email and role, so an investor and trader identity remain separate even if they use the same email address.

Order quantity, available cash, position direction, and market price are checked by the backend. Sell orders can reduce long positions or open/increase short positions; Buy orders can reduce short positions or open/increase long positions. An order that crosses through zero closes the current position and opens one in the opposite direction. Short-sale proceeds are credited to cash, and short liabilities are deducted from net market value. The in-memory trading ledger is persisted as a MongoDB document and is intended for this single-process simulation, not as a production trading database. The frontend session is still browser-local and trading requests trust identity headers; use server-verified sessions before deploying to untrusted users.

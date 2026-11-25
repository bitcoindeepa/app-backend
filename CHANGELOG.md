# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

To release: add the version's section below, bump `version` in `package.json`, and merge to `main`. The `release` workflow then tags the merge commit `vX.Y.Z` and publishes the GitHub release with that section as its notes (it fails, and tags nothing, if the section is missing).

## [Unreleased]

## [2.1.0] - 2026-11-26

### New

- **Choose whether the web app asks for the passkey on open**: `GET /passkey` returns `lock_on_open`, and `PATCH /passkey/settings { lock_on_open }` changes it for all of the member's web sessions. Turning it off needs an unlocked session (403 `passkey_required`); turning it on doesn't. It is on by default and turns on again when a member adds their first passkey. Sends, sale payments, bank account and passkey changes still need a passkey whatever the setting (#156)
- OpenSSF Scorecard workflow (#145)

## [2.0.2] - 2026-11-25

### New

- **Passkeys for the web app** (Face ID, fingerprint or device PIN, `/passkey/*`). Every send (`POST /p2p/send`) and sale payment (`POST /sell/orders/:id/pay`) from the web needs a passkey approval for exactly that action, sent in `X-Passkey-Assertion`. A member can also lock the app: a locked web session can't add or remove bank accounts until it unlocks (12 h). Support can remove a member's passkeys with `POST /passkey/admin-reset/:userId`. The Mini App is never gated: Telegram's webview can't run passkeys for our domain (#153)
- **Sign in with a passkey on the web**: `POST /auth/passkey/options` then `POST /auth/passkey/login` start a web session that is already unlocked, without Telegram (30/min per IP). It doesn't renew the bot wallet link, which lasts a year from the last Telegram login (#155)
- **Savings pots**: the bot's balance now includes `pot_balance` and `pots`. Sell quotes only use spendable sats, and `dca-summary` returns `spendable_balance`, `pot_balance` and `pots`. A bot without these fields keeps the old behaviour (#149)
- Admins get a Telegram alert when a member's KYC attempt is declined (#80)
- Settlement handles each bot refusal by type: `APPROVAL_DELIVERY` and `BUSY` retry on a slower schedule, `OVER_LIMIT` and `NO_WALLET` stop for a human (#143)
- Telegram alerts are rich messages with a level icon, short title and field table; the review reminder is laid out as tables (#143)
- Alerts that need a human go to `ALERT_TOPIC_ID` (defaults to `LOG_TOPIC_ID`) (#75)
- Clearer errors from the PayHere API
- Hotfixes merged to `main` open a back-merge PR into `dev` automatically (#81)
- Bumping `version` in `package.json` on `main` tags and publishes the release automatically. A push that only adds a missing CHANGELOG section retries it, pending release runs are queued instead of replaced, and a manual run always publishes the tag it was given

### Changed

- **The backend runs on Node 22** (the Dockerfile was still on Node 18, which passkeys can't run on) (#154)
- All money arithmetic uses bignumber.js through `src/common/money.ts` (#74)
- `package.amount` stays a float in this release; every API response already converts it, so the switch to `decimal(18, 2)` ships in the next release (#79, #146)
- `dca-summary` is cached for 10 s instead of 5 min, so wallet and pot changes show on refresh (#151)
- Sales and purchases are linked to their bot transfers by payment hash (#71)
- Members are named in logs by Telegram link and app username, without mentions (#144)
- One-time buys show "Sats Purchase" on the PayHere checkout
- README updated; licensed under AGPL-3.0 (#72)

### Fixed

- **Possible double payout**: settlement no longer overwrites an unrecorded attempt's marker with `UNKNOWN`, either when PayHere hasn't confirmed the payment or when the payment was held or charged back during the attempt. That marker is what stops a blind resend while the bot history can't be read
- A passkey removed or replaced while an unlock, approval or passkey sign-in was being checked is refused, so it can no longer leave a session unlocked
- Telegram's plain-text alert fallback counts characters as Telegram does, and long field values (such as a bot error message) are cut, so the fallback is no longer cut early or refused for being too long
- `/transaction/latest` returns `package_amount` as a number whatever the column type

### Security

- The PayHere webhook checks new `payment_id`s with PayHere before recording them, and settlement only pays `payment_id`s PayHere lists as `RECEIVED` with the recorded amount, so replayed notifications with invented `payment_id`s are never paid (#77)

### Upgrading

- **Production moves from Node 18 to Node 22** with this release (#154)
- 4 migrations, applied on startup in production, all safe while 2.0.1 is still serving:
  - `20261205000000_package_amount_decimal`: now a no-op (kept because development databases already ran it)
  - `20261205000001_more_settlement_failure_reasons`: widens the `settlement_failure` CHECK, added `NOT VALID` so the table isn't scanned under lock (#143)
  - `20261206000000_create_user_passkey`: the `user_passkey` table and nullable passkey columns on `user_session` (#153)
  - `20261207000000_create_passkey_login_attempt`: the `passkey_login_attempt` table for passkey sign-in (#155)
- New optional env var `WEBAUTHN_RP_ID`: the domain passkeys are bound to (default `APP_URL`'s host). **Set it before the first passkey is registered**: changing it later orphans every passkey
- Deploy the backend before the frontend: the app reads the new `dca-summary` fields and the passkey routes

## [2.0.1] - 2026-11-20

### New

- **Manage admins from the dashboard**: `GET /admin/admins` lists admins and `POST /admin/admins` adds one (password at least 12 characters; 409 for a duplicate email) (#66)
- **Flat bank charge on sales**: each sale now deducts `SELL_BANK_CHARGE_LKR` (default Rs.30) after the fee. It is stored on the order as `bank_charge_lkr`, and `amount_lkr` is gross minus fee minus bank charge (#67)

### Upgrading

- 1 new migration: `20261130000000_add_sell_bank_charge`, applied on startup in production
- New optional env var `SELL_BANK_CHARGE_LKR` (0–1000, 2 decimal places; empty means 30, set `0` for no charge)

## [2.0.0] - 2026-11-20

The 2.0 release: selling sats for LKR, one-time buys, P2P sends, an admin dashboard API, server-side sessions with Telegram web login, a single BTC/LKR price everywhere, and a large round of payment and settlement hardening. 211 files changed since the previous `main`.

### Highlights

#### New

- **Sell sats for LKR** via CeyPay, paid to an admin-verified bank account. The user approves the debit through the bot's collect API; payouts, refunds and stuck orders are tracked by status, with retries and `NEEDS_REVIEW` alerts (#41, #47, #54)
- **One-time BTC buys** through a one-off PayHere checkout, with per-buy, daily and hourly limits, order expiry and holds for late or duplicate payments (#43)
- **P2P sends** between Bitcoin Deepa users, relayed to the bot (`/p2p/*`), and **Bitcoin Deepa @usernames** to resolve recipients (#54, #56, #60)
- **Server-side sessions** (`user_session`) with **Log In with Telegram (OIDC + PKCE)** for the web app and an initData exchange for the Mini App; legacy JWTs can read but not spend (#62)
- **Admin dashboard API**: Better Auth sign-in, analytics, transactions, members and bank-account reviews (#38, #39, #40, #41)
- **One BTC/LKR price**: Ceylon Cash BTC/USD × CeyPay USDT/LKR, with a 1-minute rate log used as a short fallback; CoinMarketCap is display-only (#46, #48, #52)
- **Ed25519-signed bot API** with approval polling, same-memo retries and the deposit callback (#49, #61)
- History: sales in `/transaction/list`, settlement and sale transfers marked in bot history, user avatar seed (#53, #57, #58, #59)
- Unit and e2e test suites with CI (#37)

#### Fixes and hardening

- Security, payment and code-quality review: subscription owner taken from the server-side order (not `custom_1`), Didit webhook replay and timestamp checks, settlement safety and alerting, config validation at startup (#36)
- Sell payout gaps (double pay, stuck order, double claim, deadlock), chargeback during settlement, 3-hourly reminders for items waiting on a human (#47)
- Each payment keeps its transfer memo across the release cutover, so earlier sends are still deduped (#65)
- One-line CMC errors with a failure cache, Telegram 429 backoff (#50)
- Bun lockfile, axios upgrade (#26, #35); Redis credential removed from docs (#34)

#### Developer

- Pending migrations run on startup in production (#44)
- External API calls and JSON log lines logged in development (#51)
- `payhere_order` renamed to `buy_order` (#55)

### Upgrading

- **18 new migrations** (`20261117…` to `20261129…`). Production applies them on startup.
- **New env vars required in production** (the app refuses to boot without them): `APP_URL`, `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, `TRUST_PROXY`, `BASE_URL`, `BETTER_AUTH_SECRET`, `ADMIN_APP_URL`, `DIDIT_WEBHOOK_SECRET`, `CEYPAY_API_URL`, `CEYPAY_API_KEY_ID`, `CEYPAY_API_SECRET`, `BITCOINDEEPA_API_URL`, `BITCOINDEEPA_WALLET_ID`, `BITCOINDEEPA_PRIVATE_KEY_PEM` (Ed25519). With `SELL_ENABLED=true`, also `CEYPAY_WEBHOOK_PUBLIC_KEY` and the `R2_*` settings. See `.env.template`.
- **Deploy with the matching bot build**: the bot rejects V1-signed `/p2p/*` calls, and sends are Ed25519-signed.
- Register `BASE_URL/auth/telegram/callback` in BotFather for web login, and create the first dashboard admin with `bun run admin:create`.

[Unreleased]: https://github.com/bitcoindeepa/app-backend/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/bitcoindeepa/app-backend/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/bitcoindeepa/app-backend/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/bitcoindeepa/app-backend/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/bitcoindeepa/app-backend/compare/5b13b46...v2.0.0

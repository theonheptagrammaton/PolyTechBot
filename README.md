# PolyTech

A Telegram trading bot for [Polymarket](https://polymarket.com). Users get a managed wallet on `/start`, then browse markets, trade, copy top traders and run automated strategies without leaving Telegram.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)

**Try it on Telegram:** [t.me/tradepolytech](https://t.me/tradepolytech)

---

## Features

### Trading
- Market and limit orders on any Polymarket market
- Open orders, open positions and closed-position history
- Internal stop-loss monitor (price-triggered market sells instead of resting limit orders)
- Automatic redemption of resolved positions
- Shareable PnL cards rendered as images

### Market discovery
- Browse by category: politics, crypto, sports, business, geopolitics, tech, science, pop culture and more
- Trending and newest markets
- Keyword search with pagination
- Market and wallet analysis via `/analyze`

### Copy trading
- Smart-wallet leaderboard of top Polymarket traders
- Follow a wallet and mirror its buys (and optionally its sells) with your own sizing rules
- Runs in a separate worker process; notifications are delivered through a BullMQ queue

### Automated strategies
- **Bond**: scans high-probability markets and buys near-certain outcomes, with filters, take-profit / stop-loss and a daily loss limit
- **Up/Down Autopilot** (`/autopilot`, `/afk`): trades short-timeframe crypto up/down rounds by coin, timeframe, direction and price range
- **Nothing Ever Happens**: picks non-sports markets and bets on the status quo
- **Backtest**: simulates a strategy against historical data before you run it live

### Wallet and funds
- Managed Polymarket wallet per user (via Predexon)
- Deposit addresses for Polygon, Ethereum and Solana, with automatic detection
- Withdrawals to external addresses
- Optional 2FA (TOTP, Google Authenticator compatible) with backup codes

### Platform
- 1% commission per trade, collected on-chain to an admin wallet
- Three-tier referral program (25% / 5% / 3% of commission) with automatic payouts
- 10% cashback of commission to the trader
- Group mode with per-group rate limiting
- English, Russian and Chinese interface
- Admin commands: stats, user list, broadcast
- Web dashboard for platform metrics (token-protected)

---

## Architecture

```
Telegram ──> bot (src/index.ts) ──┬──> PostgreSQL (Prisma)
                                  ├──> Redis (sessions, state, queues)
                                  ├──> Predexon API (wallets, order execution)
                                  └──> Polymarket APIs (Gamma, CLOB, Data)

worker (src/worker.ts) ──> copy-trade monitor, notification queue (BullMQ)
dashboard (dashboard/)  ──> Express + static UI over the same database
```

| Path | Contents |
| --- | --- |
| `src/bot/handlers/` | Telegram commands and callback handlers |
| `src/services/` | Trading, strategies, wallets, deposits, referrals, commission |
| `src/i18n/` | Translations (`en`, `ru`, `zh`) |
| `src/database/` | Prisma and Redis clients |
| `prisma/` | Schema and migrations |
| `dashboard/` | Admin dashboard |

---

## Self-hosting

### Requirements

- Node.js 20+
- PostgreSQL 14+
- Redis 7+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Predexon](https://predexon.com) API key (wallets and trade execution)

### Quick start with Docker

```bash
git clone https://github.com/theonheptagrammaton/PolyTechBot.git
cd PolyTechBot
cp .env.example .env        # fill in the values, see below
docker compose up -d
docker compose logs -f bot
```

This starts PostgreSQL, Redis, the bot, the worker and the dashboard. The bot container syncs the database schema on start.

### Manual setup

```bash
git clone https://github.com/theonheptagrammaton/PolyTechBot.git
cd PolyTechBot
npm install
cp .env.example .env
npx prisma migrate deploy
npx prisma generate
npm run build
npm start              # bot
npm run start:worker   # worker, in a second process
```

For development: `npm run dev`.

### Configuration

Required:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Exactly 32 characters, used for AES-256-GCM. Generate with `openssl rand -hex 16` |
| `PREDEXON_API_KEY` | Predexon API key |

Commonly used:

| Variable | Description |
| --- | --- |
| `BOT_USERNAME` | Bot username without `@`, used in referral links |
| `ADMIN_USER_IDS` | Comma-separated Telegram user IDs with admin access |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis connection |
| `ADMIN_WALLET_ADDRESS` | Polygon address that receives commission |
| `PLATFORM_EXECUTOR_KEY` | Private key of a wallet holding MATIC for fee-transfer gas |
| `REFERRAL_TREASURY_KEY` | Private key of a wallet holding USDC.e for referral payouts |
| `POLY_BUILDER_API_KEY`, `POLY_BUILDER_SECRET`, `POLY_BUILDER_PASSPHRASE` | Polymarket Builder (relayer) credentials |
| `WEBHOOK_DOMAIN`, `WEBHOOK_PORT` | Use webhooks instead of long polling |
| `DASHBOARD_TOKEN` | Access token for the dashboard |
| `POSTGRES_PASSWORD` | Database password used by `docker-compose.yml` |

See [`.env.example`](.env.example) for the full list.

For a full server walkthrough (firewall, PM2, backups), see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Security

- Wallet keys and credentials are encrypted at rest with AES-256-GCM. Losing `ENCRYPTION_KEY` makes stored keys unrecoverable; leaking it exposes them.
- Never commit `.env`. The executor and treasury keys control real funds.
- Keep PostgreSQL and Redis off the public internet.

Found a vulnerability? Please report it privately via [GitHub Security Advisories](https://github.com/theonheptagrammaton/PolyTechBot/security/advisories/new) instead of opening a public issue.

---

## Disclaimer

PolyTech is an independent project and is not affiliated with or endorsed by Polymarket. Prediction-market trading carries real financial risk, and automated strategies can lose money. Use at your own risk and check whether Polymarket is available in your jurisdiction.

---

## License

[MIT](LICENSE) © [Eray Pişkin](https://eraypiskin.com)

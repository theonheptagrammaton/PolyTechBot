<div align="center">

<img src=".github/assets/logo.png" alt="PolyTech" width="88" />

# PolyTech

**A Telegram trading bot for Polymarket.**

Trade prediction markets, copy top wallets and run automated strategies without leaving Telegram.

[![Telegram](https://img.shields.io/badge/Telegram-@tradepolytech-26A5E4?logo=telegram&logoColor=white)](https://t.me/tradepolytech)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#architecture)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-4169E1?logo=postgresql&logoColor=white)](#requirements)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](#requirements)
[![Polygon](https://img.shields.io/badge/Polygon-PoS-7B3FE4?logo=polygon&logoColor=white)](#architecture)
[![License](https://img.shields.io/badge/license-All%20rights%20reserved-lightgrey)](LICENSE)

**[Open the bot](https://t.me/tradepolytech)** · Built by **[Eray Pişkin](https://eraypiskin.com)**

</div>

---

## Overview

PolyTech puts Polymarket inside a Telegram chat. A user sends `/start`, gets a managed wallet, funds it from Polygon, Ethereum or Solana, and can trade any market from there. On top of manual trading it mirrors the best-performing wallets and runs rule-based strategies around the clock, with stop-losses, take-profits and automatic redemption of resolved positions.

## Features

| Area | What it does |
| --- | --- |
| **Trading** | Market and limit orders on any Polymarket market, open orders, positions and full trade history. |
| **Risk controls** | Internal stop-loss monitor that triggers market sells on price, take-profit / stop-loss on strategies, daily loss limits. |
| **Market discovery** | Categories (politics, crypto, sports, business, geopolitics, tech, science, pop culture), trending and newest markets, keyword search. |
| **Analysis** | `/analyze` for market and wallet analysis, smart-money scanning. |
| **Copy trading** | Leaderboard of top Polymarket wallets; follow one and mirror its buys, and optionally its sells, with your own sizing. |
| **Bond strategy** | Scans high-probability markets and buys near-certain outcomes, with filters, TP/SL and a daily loss cap. |
| **Up/Down Autopilot** | `/autopilot` trades short-timeframe crypto up/down rounds by coin, timeframe, direction and price range. |
| **Nothing Ever Happens** | Picks non-sports markets and bets on the status quo. |
| **Backtesting** | Simulates a strategy against historical data before it goes live. |
| **Wallet & funds** | Managed wallet per user, deposit detection on Polygon, Ethereum and Solana, withdrawals, automatic redemption. |
| **Security** | Optional TOTP 2FA with backup codes, AES-256-GCM encryption for keys and credentials at rest. |
| **PnL cards** | Shareable profit-and-loss images generated per position or for all-time results. |
| **Referrals & cashback** | Three-tier referral program (25% / 5% / 3% of commission) with automatic payouts, 10% cashback to traders. |
| **Groups & languages** | Group mode with per-group rate limits; English, Russian and Chinese interface. |
| **Admin** | Stats, user list, broadcast, and a token-protected web dashboard for platform metrics. |

The platform charges a 1% commission per trade, collected on-chain to the admin wallet.

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

The instructions below document how the project runs. Running your own instance requires written permission, see [License](#license).

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

Copyright © 2026 [Eray Pişkin](https://eraypiskin.com). All rights reserved.

The source is public for reference only. Using, copying, modifying or redistributing it, or running it as a service, requires prior written permission. See [LICENSE](LICENSE).

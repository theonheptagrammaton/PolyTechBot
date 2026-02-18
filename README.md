# 🤖 Polymarket Telegram Trading Bot

A production-ready Telegram bot for trading on Polymarket with multi-chain wallet support, 2FA security, automated deposits, and commission system.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

## ✨ Features

### 🔐 Security & Authentication
- **2FA Authentication** - Google Authenticator integration with backup codes
- **End-to-End Encryption** - AES-256-GCM for private keys and credentials
- **Multi-signature Support** - Secure wallet management

### 💰 Multi-Chain Wallet
- **EVM Chains**: Polygon, Ethereum, BNB (shared address)
- **Solana**: Dedicated SPL wallet
- **Auto-generation** - Wallets created on first \`/start\`
- **Real-time Balance** - Live USDC balance from blockchains

### 💸 Deposit System
- **Multi-chain Deposits** - Polygon, Ethereum, Solana
- **Automatic Detection** - Bot checks blockchain for incoming USDC
- **One-click Approval** - Approve + Deposit to Polymarket
- **Minimum $10** - Validation and user notifications

### 📊 Portfolio Tracking
- **Open Positions** - Active orders with live data
- **Closed Positions** - Complete trade history
- **All Transactions** - Combined view with pagination

### 🔍 Market Discovery
- **Browse by Category** - Politics, Crypto, Sports, Business, Pop Culture
- **Search Markets** - Keyword search with pagination
- **Real-time Data** - Direct from Polymarket Gamma API

### 💹 Trading (Coming Soon)
- Market & Limit orders
- 1% commission system
- 2FA protection for large trades

---

## 🚀 Quick Start (Production Deployment)

### Prerequisites

- **Node.js** 18+ 
- **PostgreSQL** 14+
- **Redis** 7+
- **Git**
- **Telegram Bot Token**

---

## 📦 Installation

### Step 1: Clone Repository

\`\`\`bash
git clone https://github.com/theonheptagrammaton/polytech.git
cd polytech
\`\`\`

### Step 2: Install Dependencies

\`\`\`bash
npm install
\`\`\`

### Step 3: Setup PostgreSQL

\`\`\`bash
# Using Docker (Recommended)
docker run --name polytech-postgres \\
  -e POSTGRES_USER=polytech \\
  -e POSTGRES_PASSWORD=your_secure_password \\
  -e POSTGRES_DB=polytech_db \\
  -p 5432:5432 \\
  -d postgres:14-alpine
\`\`\`

### Step 4: Setup Redis

\`\`\`bash
# Using Docker (Recommended)
docker run --name polytech-redis \\
  -p 6379:6379 \\
  -d redis:7-alpine
\`\`\`

### Step 5: Configure Environment

\`\`\`bash
cp .env.example .env
nano .env
\`\`\`

**Required Configuration:**

\`\`\`env
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
ADMIN_USER_IDS=your_telegram_user_id
DATABASE_URL=postgresql://polytech:password@localhost:5432/polytech_db
ENCRYPTION_KEY=generate_with_openssl_rand_hex_16
ADMIN_COMMISSION_WALLET=0xYourPolygonWalletAddress
NODE_ENV=production
\`\`\`

### Step 6: Run Migrations

\`\`\`bash
npx prisma migrate deploy
npx prisma generate
\`\`\`

### Step 7: Build & Start

\`\`\`bash
npm run build
npm start
\`\`\`

---

## 🐳 Docker Deployment (Easiest)

\`\`\`bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f bot

# Stop
docker-compose down
\`\`\`

---

## 🔧 Configuration

### Get Telegram Bot Token
1. Message [@BotFather](https://t.me/BotFather)
2. Send \`/newbot\`
3. Copy token to \`.env\`

### Get Your Telegram ID
1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy ID to \`ADMIN_USER_IDS\`

### Generate Encryption Key
\`\`\`bash
openssl rand -hex 16
\`\`\`

---

## 🛡️ Security

- ✅ Never commit \`.env\`
- ✅ Use strong passwords
- ✅ Enable firewall
- ✅ Keep dependencies updated
- ✅ Rotate encryption key periodically

---

## 🔄 Process Management (PM2)

\`\`\`bash
npm install -g pm2
pm2 start npm --name "polytech-bot" -- start
pm2 save
pm2 startup
\`\`\`

---

## 🚨 Troubleshooting

### Bot Not Starting
\`\`\`bash
pm2 logs polytech-bot --lines 100
\`\`\`

### Database Issues
\`\`\`bash
sudo systemctl status postgresql
sudo systemctl restart postgresql
\`\`\`

### Redis Issues
\`\`\`bash
sudo systemctl status redis
redis-cli ping
\`\`\`

---

## 📊 Monitoring

\`\`\`bash
# View logs
pm2 logs polytech-bot

# Check status
pm2 status

# Restart
pm2 restart polytech-bot
\`\`\`

---

## 🔄 Updates

\`\`\`bash
git pull origin main
npm install
npx prisma migrate deploy
npm run build
pm2 restart polytech-bot
\`\`\`

---

## 📄 License

MIT License

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/theonheptagrammaton/polytech/issues)

---

Made with ❤️ by [theonheptagrammaton](https://github.com/theonheptagrammaton)

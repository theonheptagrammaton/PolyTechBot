# 🚀 Production Deployment Guide

Complete step-by-step guide to deploy Polymarket Telegram Bot on your server.

---

## 📋 Server Requirements

### Minimum Specs
- **OS**: Ubuntu 20.04+ or Debian 11+
- **CPU**: 2 cores
- **RAM**: 2GB
- **Storage**: 10GB free space
- **Network**: Public IP with open ports

### Recommended Specs
- **OS**: Ubuntu 22.04 LTS
- **CPU**: 4 cores
- **RAM**: 4GB
- **Storage**: 20GB SSD
- **Network**: Dedicated server or VPS

---

## 🔐 Step 1: Initial Server Setup

### 1.1 Connect to Server

\`\`\`bash
ssh root@your_server_ip
\`\`\`

### 1.2 Update System

\`\`\`bash
apt update && apt upgrade -y
\`\`\`

### 1.3 Create Non-Root User

\`\`\`bash
adduser polytech
usermod -aG sudo polytech
\`\`\`

### 1.4 Configure Firewall

\`\`\`bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
\`\`\`

### 1.5 Switch to New User

\`\`\`bash
su - polytech
\`\`\`

---

## 📦 Step 2: Install Dependencies

### 2.1 Install Node.js 18

\`\`\`bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should show v18.x
npm --version
\`\`\`

### 2.2 Install PostgreSQL 14

\`\`\`bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
sudo systemctl status postgresql
\`\`\`

### 2.3 Install Redis

\`\`\`bash
sudo apt install -y redis-server
sudo systemctl start redis
sudo systemctl enable redis
redis-cli ping  # Should return "PONG"
\`\`\`

### 2.4 Install Git

\`\`\`bash
sudo apt install -y git
git --version
\`\`\`

### 2.5 Install PM2 (Process Manager)

\`\`\`bash
sudo npm install -g pm2
pm2 --version
\`\`\`

---

## 💾 Step 3: Configure PostgreSQL

### 3.1 Create Database

\`\`\`bash
sudo -u postgres psql
\`\`\`

In PostgreSQL prompt:

\`\`\`sql
CREATE DATABASE polytech_db;
CREATE USER polytech WITH PASSWORD 'CHANGE_THIS_PASSWORD_123!@#';
GRANT ALL PRIVILEGES ON DATABASE polytech_db TO polytech;
\\q
\`\`\`

### 3.2 Test Connection

\`\`\`bash
psql -U polytech -d polytech_db -h localhost -W
# Enter password when prompted
# Type \\q to exit
\`\`\`

---

## 🔴 Step 4: Configure Redis

### 4.1 Secure Redis

\`\`\`bash
sudo nano /etc/redis/redis.conf
\`\`\`

Find and update these lines:

\`\`\`conf
# Bind to localhost only
bind 127.0.0.1 ::1

# Set password (uncomment and change)
requirepass YOUR_REDIS_PASSWORD_HERE
\`\`\`

### 4.2 Restart Redis

\`\`\`bash
sudo systemctl restart redis
redis-cli
# In redis-cli:
AUTH YOUR_REDIS_PASSWORD_HERE
PING  # Should return "PONG"
exit
\`\`\`

---

## 📥 Step 5: Clone Repository

### 5.1 Clone Project

\`\`\`bash
cd ~
git clone https://github.com/theonheptagrammaton/polytech.git
cd polytech
\`\`\`

### 5.2 Install Dependencies

\`\`\`bash
npm install
\`\`\`

---

## ⚙️ Step 6: Configure Environment

### 6.1 Copy Example Config

\`\`\`bash
cp .env.example .env
nano .env
\`\`\`

### 6.2 Fill in Configuration

\`\`\`env
# Telegram Bot Token (get from @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

# Your Telegram User ID (get from @userinfobot)
ADMIN_USER_IDS=123456789

# Polymarket API
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137

# Database (use password from Step 3.1)
DATABASE_URL=postgresql://polytech:CHANGE_THIS_PASSWORD_123!@#@localhost:5432/polytech_db

# Redis (use password from Step 4.1)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_REDIS_PASSWORD_HERE

# Production settings
NODE_ENV=production
LOG_LEVEL=info

# Encryption key (generate new one)
ENCRYPTION_KEY=run_openssl_rand_hex_16_here

# Admin commission wallet (your Polygon wallet)
ADMIN_COMMISSION_WALLET=0xYourPolygonWalletAddressHere
\`\`\`

### 6.3 Generate Encryption Key

\`\`\`bash
openssl rand -hex 16
# Copy output and paste in .env as ENCRYPTION_KEY
\`\`\`

---

## 🔨 Step 7: Build & Deploy

### 7.1 Run Database Migrations

\`\`\`bash
npx prisma migrate deploy
npx prisma generate
\`\`\`

### 7.2 Build TypeScript

\`\`\`bash
npm run build
\`\`\`

### 7.3 Test Run

\`\`\`bash
npm start
# Press Ctrl+C to stop after verifying it starts
\`\`\`

---

## 🔄 Step 8: Setup PM2

### 8.1 Start with PM2

\`\`\`bash
pm2 start npm --name "polytech-bot" -- start
\`\`\`

### 8.2 Configure Auto-Start

\`\`\`bash
pm2 startup
# Copy and run the command it outputs

pm2 save
\`\`\`

### 8.3 Verify Running

\`\`\`bash
pm2 status
pm2 logs polytech-bot --lines 50
\`\`\`

---

## ✅ Step 9: Verify Deployment

### 9.1 Check Bot Status

\`\`\`bash
pm2 status
\`\`\`

Should show:
\`\`\`
┌────┬────────────────┬─────────┬──────────┐
│ id │ name           │ status  │ cpu      │
├────┼────────────────┼─────────┼──────────┤
│ 0  │ polytech-bot   │ online  │ 0%       │
└────┴────────────────┴─────────┴──────────┘
\`\`\`

### 9.2 Test Telegram Bot

1. Open Telegram
2. Find your bot (search by username)
3. Send \`/start\`
4. Wallet should be created
5. Test features

---

## 📊 Step 10: Monitoring & Logs

### View Logs

\`\`\`bash
# Real-time logs
pm2 logs polytech-bot

# Last 100 lines
pm2 logs polytech-bot --lines 100

# Error logs only
pm2 logs polytech-bot --err
\`\`\`

### Monitor Resources

\`\`\`bash
pm2 monit
\`\`\`

### Check Status

\`\`\`bash
pm2 status
pm2 info polytech-bot
\`\`\`

---

## 🔄 Step 11: Updates

### Pull Latest Code

\`\`\`bash
cd ~/polytech
git pull origin main
\`\`\`

### Update Dependencies

\`\`\`bash
npm install
\`\`\`

### Run Migrations

\`\`\`bash
npx prisma migrate deploy
\`\`\`

### Rebuild

\`\`\`bash
npm run build
\`\`\`

### Restart Bot

\`\`\`bash
pm2 restart polytech-bot
pm2 logs polytech-bot
\`\`\`

---

## 🔐 Step 12: Security Hardening

### 12.1 SSH Key Authentication

\`\`\`bash
# On your local machine:
ssh-keygen -t ed25519 -C "your_email@example.com"
ssh-copy-id polytech@your_server_ip

# On server, disable password auth:
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl restart sshd
\`\`\`

### 12.2 Fail2Ban

\`\`\`bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
\`\`\`

### 12.3 Auto Updates

\`\`\`bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
\`\`\`

---

## 🔧 Troubleshooting

### Bot Won't Start

\`\`\`bash
# Check logs
pm2 logs polytech-bot --err --lines 100

# Check if ports are in use
sudo netstat -tulpn | grep -E '5432|6379'

# Restart services
sudo systemctl restart postgresql
sudo systemctl restart redis
pm2 restart polytech-bot
\`\`\`

### Database Connection Issues

\`\`\`bash
# Test connection
psql -U polytech -d polytech_db -h localhost -W

# Check PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql-14-main.log

# Restart PostgreSQL
sudo systemctl restart postgresql
\`\`\`

### Redis Connection Issues

\`\`\`bash
# Test Redis
redis-cli -a YOUR_REDIS_PASSWORD ping

# Check Redis logs
sudo tail -f /var/log/redis/redis-server.log

# Restart Redis
sudo systemctl restart redis
\`\`\`

### Out of Memory

\`\`\`bash
# Check memory
free -h

# Add swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
\`\`\`

### Disk Space Full

\`\`\`bash
# Check disk usage
df -h

# Clean logs
pm2 flush
sudo journalctl --vacuum-time=7d

# Clean npm cache
npm cache clean --force
\`\`\`

---

## 📦 Backup & Restore

### Database Backup

\`\`\`bash
# Create backup
pg_dump -U polytech -d polytech_db > ~/backup_\$(date +%Y%m%d).sql

# Restore backup
psql -U polytech -d polytech_db < ~/backup_20260218.sql
\`\`\`

### Automated Daily Backup

\`\`\`bash
# Create backup script
nano ~/backup.sh
\`\`\`

\`\`\`bash
#!/bin/bash
pg_dump -U polytech -d polytech_db > ~/backups/db_\$(date +%Y%m%d).sql
find ~/backups -name "db_*.sql" -mtime +7 -delete
\`\`\`

\`\`\`bash
chmod +x ~/backup.sh

# Add to crontab
crontab -e
# Add: 0 2 * * * /home/polytech/backup.sh
\`\`\`

---

## 🎯 Performance Tuning

### PostgreSQL

\`\`\`bash
sudo nano /etc/postgresql/14/main/postgresql.conf
\`\`\`

\`\`\`conf
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
\`\`\`

### Redis

\`\`\`bash
sudo nano /etc/redis/redis.conf
\`\`\`

\`\`\`conf
maxmemory 512mb
maxmemory-policy allkeys-lru
\`\`\`

### Node.js

\`\`\`bash
pm2 delete polytech-bot
NODE_OPTIONS="--max-old-space-size=2048" pm2 start npm --name "polytech-bot" -- start
pm2 save
\`\`\`

---

## ✅ Final Checklist

- [ ] Server updated and secured
- [ ] Firewall configured
- [ ] PostgreSQL running and secured
- [ ] Redis running and secured
- [ ] Repository cloned
- [ ] .env configured correctly
- [ ] Database migrations run
- [ ] Bot built successfully
- [ ] PM2 configured for auto-start
- [ ] Bot tested in Telegram
- [ ] Monitoring setup
- [ ] Backups configured

---

## 📞 Support

If you encounter issues:

1. Check logs: \`pm2 logs polytech-bot\`
2. Review this guide
3. Open GitHub issue

---

**Deployment complete! 🎉**

Your Polymarket Trading Bot is now running in production!

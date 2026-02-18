#!/bin/bash

set -e

echo "🚀 Setting up Polymarket Telegram Bot..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if .env exists
if [ -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file already exists. Skipping...${NC}"
else
    echo "📝 Creating .env file..."
    cp .env.example .env

    # Generate encryption key
    ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")

    # Update .env with generated encryption key
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/your_32_character_encryption_key_here/$ENCRYPTION_KEY/" .env
    else
        sed -i "s/your_32_character_encryption_key_here/$ENCRYPTION_KEY/" .env
    fi

    echo -e "${GREEN}✅ .env file created${NC}"
    echo -e "${YELLOW}⚠️  Please edit .env and add your TELEGRAM_BOT_TOKEN${NC}"
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Start Docker services
echo "🐳 Starting PostgreSQL and Redis..."
docker-compose up -d postgres redis

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Run migrations
echo "🗃️  Running database migrations..."
npx prisma migrate dev --name init

echo ""
echo -e "${GREEN}✅ Setup completed!${NC}"
echo ""
echo "📋 Next steps:"
echo "1. Edit .env file and add your TELEGRAM_BOT_TOKEN"
echo "2. Add your Telegram user ID to ADMIN_USER_IDS in .env"
echo "3. Run 'npm run dev' to start the bot in development mode"
echo ""
echo "To get your Telegram user ID, you can:"
echo "1. Start a chat with @userinfobot on Telegram"
echo "2. Or use @raw_data_bot"
echo ""

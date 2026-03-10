FROM node:20-alpine AS builder

WORKDIR /app

# Sharp + Pango text rendering build dependencies
RUN apk add --no-cache python3 make g++ cairo-dev pango-dev fontconfig-dev

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client
RUN npm run db:generate

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# ── Production ──────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Sharp + Pango runtime dependencies
RUN apk add --no-cache cairo pango fontconfig

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy Prisma files and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy built application
COPY --from=builder /app/dist ./dist

# Template PNGs + font files (tsc doesn't copy non-TS assets)
COPY src/bot/img ./dist/bot/img

# Install fonts to system so Pango/fontconfig can find them
RUN mkdir -p /usr/share/fonts/custom && \
    cp dist/bot/img/fonts/*.ttf /usr/share/fonts/custom/ 2>/dev/null || true && \
    cp dist/bot/img/fonts/*.otf /usr/share/fonts/custom/ 2>/dev/null || true && \
    fc-cache -f

# Create logs directory
RUN mkdir -p /app/logs

# Entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]

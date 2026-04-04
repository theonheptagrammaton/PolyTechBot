FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY server.js ./
COPY public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]

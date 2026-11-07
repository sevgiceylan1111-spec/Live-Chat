FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV CHAT_DATABASE_PATH=/data/chat.sqlite

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
CMD ["npm", "start"]

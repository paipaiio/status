FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    CHROMIUM_BIN=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node frontend ./frontend
COPY --chown=node:node config ./config

RUN mkdir -p /data/runtime /data/config /data/qq-bot \
  && chown -R node:node /app /data

USER node

EXPOSE 3210 3211

CMD ["node", "src/server.js"]

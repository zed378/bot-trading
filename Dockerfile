FROM node:26-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*

FROM base AS system
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

FROM system AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM build AS test
CMD ["npm", "test"]

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.171.0
COPY --from=build /app/dist ./dist
COPY server/v2/agents/personas ./dist/server/server/v2/agents/personas
COPY .env.example ./config.env.example
COPY docker/entrypoint.sh /usr/local/bin/mpu-entrypoint
RUN chmod 755 /usr/local/bin/mpu-entrypoint && mkdir -p /state && chown node:node /state
USER node
WORKDIR /state
ENTRYPOINT ["mpu-entrypoint"]
CMD ["node", "/app/dist/server/server/index.js"]

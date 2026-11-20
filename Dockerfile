FROM node:26-bookworm-slim AS system
RUN apt-get update && apt-get install -y --no-install-recommends python3 python-is-python3 git chromium ca-certificates && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

FROM system AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM build AS test
CMD ["npm", "test"]

FROM system AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server/v2/agents/personas ./dist/server/server/v2/agents/personas
COPY skills ./skills
COPY workers ./workers
COPY data/sample ./data/sample
COPY .env.example ./config.env.example
COPY docker/entrypoint.sh /usr/local/bin/mpu-entrypoint
RUN chmod 755 /usr/local/bin/mpu-entrypoint && mkdir -p /state && chown node:node /state
USER node
WORKDIR /state
ENTRYPOINT ["mpu-entrypoint"]
CMD ["node", "/app/dist/server/server/index.js"]

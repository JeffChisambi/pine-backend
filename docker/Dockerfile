# syntax=docker/dockerfile:1

# ---- Base ----
FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- Dependencies (cached separately from source for faster rebuilds) ----
FROM base AS dependencies
COPY package.json package-lock.json* ./
RUN npm install --include=dev

# ---- Build ----
FROM dependencies AS build
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build
RUN npm run build:seed
RUN npm prune --omit=dev

# ---- Production runtime ----
FROM base AS production
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/sh -m pine

# Install Playwright system dependencies and Chromium browser
RUN npx playwright install --with-deps chromium && \
    chown -R pine:nodejs /ms-playwright

COPY --from=build --chown=pine:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=pine:nodejs /app/dist ./dist
COPY --from=build --chown=pine:nodejs /app/prisma ./prisma
COPY --from=build --chown=pine:nodejs /app/scripts ./scripts
COPY --from=build --chown=pine:nodejs /app/package.json ./package.json

USER pine
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/v1/health/liveness', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]

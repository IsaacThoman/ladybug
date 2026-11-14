# syntax=docker/dockerfile:1
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci --omit=dev -w @ladybug/server --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    && test -L node_modules/@ladybug/shared && test -L node_modules/@ladybug/backend \
    && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY packages/backend/src packages/backend/src
COPY apps/server/src apps/server/src
RUN mkdir -p /app/.artifacts && chown node:node /app/.artifacts
USER node
WORKDIR /app/apps/server
EXPOSE 3001
CMD ["node", "src/index.ts"]

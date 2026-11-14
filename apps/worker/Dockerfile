# syntax=docker/dockerfile:1
# The docker CLI, for the docker sandbox provider (compose / Coolify). It's a
# static binary, so it runs on the Debian base below.
FROM docker:29.9.3-cli AS docker-cli

FROM node:24-slim
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/desktop/package.json apps/desktop/
COPY apps/extension/package.json apps/extension/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/garden/package.json packages/garden/
COPY packages/backend/package.json packages/backend/
RUN npm ci --omit=dev -w @ladybug/worker --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    && test -L node_modules/@ladybug/shared && test -L node_modules/@ladybug/backend \
    && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY packages/backend/src packages/backend/src
COPY apps/worker/src apps/worker/src
RUN mkdir -p /app/.artifacts && chown node:node /app/.artifacts
USER node
WORKDIR /app/apps/worker
CMD ["node", "src/index.ts"]

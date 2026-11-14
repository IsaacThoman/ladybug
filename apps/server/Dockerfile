# Server image: the Express API plus the built admin UI (served at /admin/).
# Build context is the repo root: docker compose handles this, or
#   docker build -f apps/server/Dockerfile .

FROM node:24-alpine AS manifests
WORKDIR /app
# npm ci needs every workspace manifest the lockfile references.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/garden/package.json packages/garden/
COPY packages/backend/package.json packages/backend/
COPY apps/admin/package.json apps/admin/
COPY apps/desktop/package.json apps/desktop/
COPY apps/extension/package.json apps/extension/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

FROM manifests AS admin
RUN npm ci --workspace=@ladybug/admin --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/garden packages/garden
COPY apps/admin apps/admin
RUN npx --workspace=@ladybug/admin vite build

FROM manifests
ENV NODE_ENV=production
RUN npm ci --workspace=@ladybug/server --omit=dev --ignore-scripts --no-audit --no-fund \
    && test -L node_modules/@ladybug/shared && test -L node_modules/@ladybug/backend \
    && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY packages/backend/src packages/backend/src
COPY apps/server/src apps/server/src
COPY --from=admin /app/apps/admin/dist apps/admin/dist
RUN mkdir -p /app/.artifacts && chown node:node /app/.artifacts
USER 1000
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Node runs the TypeScript directly (type stripping), same as `npm start`.
CMD ["node", "apps/server/src/index.ts"]

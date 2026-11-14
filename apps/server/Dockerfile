# Server image: the Express API plus the built admin UI (served at /admin/).
# Build context is the repo root: docker compose handles this, or
#   docker build -f apps/server/Dockerfile .

FROM node:24-alpine AS admin
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin/package.json apps/admin/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
COPY apps/extension/package.json apps/extension/
RUN npm ci --workspace=@ladybug/admin --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN npx --workspace=@ladybug/admin vite build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin/package.json apps/admin/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
COPY apps/extension/package.json apps/extension/
RUN npm ci --workspace=@ladybug/server --omit=dev --ignore-scripts && npm cache clean --force
COPY packages/shared packages/shared
COPY apps/server/src apps/server/src
COPY --from=admin /app/apps/admin/dist apps/admin/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Node runs the TypeScript directly (type stripping), same as `npm start`.
CMD ["node", "apps/server/src/index.ts"]

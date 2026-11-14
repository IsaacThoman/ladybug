# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/desktop/package.json apps/desktop/
COPY apps/extension/package.json apps/extension/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/mascot/package.json packages/mascot/
RUN npm ci --include=dev -w @ladybug/web --include-workspace-root=true --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/mascot packages/mascot
COPY apps/web apps/web
ARG VITE_SERVER_URL=""
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm run build -w @ladybug/web

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080

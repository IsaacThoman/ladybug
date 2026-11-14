# syntax=docker/dockerfile:1
# Disposable detonation sandbox: headful Chromium on Xvfb + the tool daemon.
# Build from the repo root:
#   docker build -f apps/sandbox/Dockerfile -t ladybug-sandbox:dev .
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xauth tini \
    yara libimage-exiftool-perl file unzip p7zip-full curl ca-certificates libnss3-tools \
  && rm -rf /var/lib/apt/lists/*

# Reuse the image's uid (pwuser, 1001) as the unprivileged `sandbox` user.
RUN usermod --login sandbox --home /home/sandbox --move-home pwuser \
  && groupmod --new-name sandbox pwuser \
  && mkdir -p /home/sandbox/downloads /home/sandbox/work /home/sandbox/.pki/nssdb \
  && chown -R sandbox:sandbox /home/sandbox \
  && chmod 700 /home/sandbox/.pki /home/sandbox/.pki/nssdb

WORKDIR /app
# Only the workspaces the sandbox needs. node_modules/@ladybug/shared stays a
# symlink to packages/shared, which Node needs to strip its types.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/sandbox/package.json apps/sandbox/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci -w @ladybug/sandbox --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY packages/shared packages/shared
COPY apps/sandbox apps/sandbox
RUN chmod 755 apps/sandbox/docker/entrypoint.sh

ENV NODE_ENV=production \
    HOME=/home/sandbox \
    SANDBOX_HOME=/home/sandbox \
    DISPLAY=:99 \
    DAEMON_PORT=7000

USER 1001
WORKDIR /home/sandbox/work
EXPOSE 7000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:7000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/apps/sandbox/docker/entrypoint.sh"]

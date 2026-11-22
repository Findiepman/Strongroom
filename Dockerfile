# Build stage: has a compiler in case bcrypt or better-sqlite3 has no
# prebuilt binary for the target platform.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
# git: the GitHub puller. tini: forwards signals so `docker stop` is clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/strongroom-entrypoint
RUN chmod 755 /usr/local/bin/strongroom-entrypoint && mkdir -p /data && chown node:node /data

# Everything Strongroom writes (database, files, repos, SSH host key, session
# secret) lives under /data. Without NODE_ENV=production the session secret is
# generated once and kept in /data, so no .env is needed to start.
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080 \
    SFTP_PORT=2222
VOLUME /data
EXPOSE 8080 2222

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "strongroom-entrypoint"]
CMD ["node", "server.js"]

LABEL org.opencontainers.image.title="Strongroom" \
      org.opencontainers.image.description="Self-hosted file cloud: web file manager, SFTP, multi-user quotas" \
      org.opencontainers.image.source="https://github.com/Findiepman/Strongroom" \
      org.opencontainers.image.licenses="MIT"

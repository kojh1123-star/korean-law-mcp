# Korean Law MCP Server - Docker 배포용

# --- Build Stage ---
# Official Node 24 LTS manifest, resolved 2026-09-09. Includes node:sqlite.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder

WORKDIR /app

COPY package*.json ./
# Kordoc keeps native OCR/ML helpers optional.  This server does not import
# them, so do not run transitive postinstall downloaders during image builds.
# Pure-JS annex parsing remains installed and is verified in CI.
RUN npm ci --ignore-scripts --omit=optional

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

RUN npm run build
RUN npm prune --omit=dev --omit=optional --ignore-scripts
RUN npm run verify:annex-runtime

# --- Runtime Stage ---
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN apk add --no-cache su-exec

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/law-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/law-entrypoint && chmod 755 /usr/local/bin/law-entrypoint

RUN chown -R appuser:appgroup /app

# The entrypoint prepares the mounted OAuth directory, then drops to appuser.
ENTRYPOINT ["/usr/local/bin/law-entrypoint"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
# A container is explicitly a remote deployment unit. Bind externally, but
# fail startup unless the operator supplies MCP_AUTH_TOKEN (or deliberately
# opts into MCP_ALLOW_UNAUTHENTICATED_REMOTE at runtime).
ENV MCP_HTTP_HOST=0.0.0.0
ENV OAUTH_DB_PATH=/data/oauth/oauth.sqlite

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "build/index.js", "--mode", "sse", "--port", "3000"]

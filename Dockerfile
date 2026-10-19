# Follow Up Boss MCP Server: HTTP mode for remote installs (Hostinger, any VPS).
# Published to ghcr.io/mindwear-capitian/followupboss-mcp-server on each release tag.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js LICENSE NOTICE README.md CHANGELOG.md ./

# OAuth clients + tokens live in /data so a redeploy does not log Claude out.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV MCP_TRANSPORT=http \
    PORT=3000 \
    MCP_OAUTH_STORE_PATH=/data/oauth-store.json \
    MCP_REQUIRE_AUTH=true

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "index.js"]

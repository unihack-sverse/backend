FROM node:20-alpine AS deps
WORKDIR /usr/src/app
# Build toolchain only for native modules (argon2) that lack a prebuilt binary.
RUN apk add --no-cache g++ make python3
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5001
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
USER node
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "src/server.js"]

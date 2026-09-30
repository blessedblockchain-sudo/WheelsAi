# WheelsAI API — production image. Build from the REPO ROOT:
#   docker build -f apps/api/Dockerfile -t wheelsai-api .
#
# Stages:
#   base       node:22-alpine + runtime libs shared by every stage
#   builder    full install, prisma generate, tsup bundle (dist/index.js)
#   prod-deps  production-only node_modules for @wheelsai/api, plus the
#              Prisma CLI + engines for the fly.io release_command
#   runner     dist + prod node_modules + prisma schema/migrations, non-root
#
# Only explicit manifests and source trees are COPYed — never whole
# workspace directories — so local files such as apps/api/.env and
# packages/db/.env cannot end up in an image layer.

# ---- Base ----
# Node 22: @mastra/core and @mastra/schema-compat require node >=22.13.
FROM node:22-alpine AS base
# libc6-compat: glibc shim for prebuilt native addons.
# openssl: Prisma's query/schema engines link libssl, and Prisma picks the
# engine build by running `openssl version`.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ---- Build Stage ----
FROM base AS builder

# Toolchain for native modules (argon2) when no prebuilt binary matches.
RUN apk add --no-cache python3 make g++

# Every workspace manifest, so npm ci sees the workspace layout the
# lockfile was written against. Only the API's dependency closure is
# installed (-w), plus @wheelsai/db for its devDependency on the prisma CLI.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/cli/package.json ./packages/cli/
COPY packages/db/package.json ./packages/db/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/shared/package.json ./packages/shared/
COPY packages/types/package.json ./packages/types/
RUN npm ci --workspace=@wheelsai/api --workspace=@wheelsai/db \
      --no-audit --fund=false

# Sources. The @wheelsai/* packages ship TypeScript and are inlined into
# the bundle by tsup (see apps/api/tsup.config.ts).
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/src ./packages/db/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src ./packages/types/src
COPY apps/api/tsconfig.json apps/api/tsup.config.ts ./apps/api/
COPY apps/api/src ./apps/api/src

# Generate the Prisma client (+ musl query engine) into node_modules/.prisma
RUN npm run db:generate

# Bundle the API -> apps/api/dist/index.js (single ESM file + sourcemap)
RUN npm run build --workspace=@wheelsai/api

# ---- Production dependencies ----
FROM base AS prod-deps

RUN apk add --no-cache python3 make g++

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/types/package.json ./packages/types/
RUN npm ci --omit=dev --workspace=@wheelsai/api --no-audit --fund=false \
    && npm cache clean --force

# Generated Prisma client + native engine (the prod install only has the
# @prisma/client stub), and the Prisma CLI with its engines. The CLI is a
# devDependency of @wheelsai/db but the release_command in
# fly.{production,staging}.toml runs `npx prisma migrate deploy` inside
# this image; without a local copy npx would download whatever `prisma` is
# latest at release time. Its dependency closure is entirely @prisma/*.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
RUN ln -sf ../prisma/build/index.js node_modules/.bin/prisma

# ---- Production Stage ----
FROM base AS runner

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs wheelsai

# Production node_modules. apps/api/node_modules holds the API's
# non-hoisted dependency versions and must sit next to dist/.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

# The bundle. apps/api/package.json is required at runtime: its
# "type": "module" is what makes Node load dist/index.js as ESM.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Schema + migrations for the release_command:
#   npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma

# Set environment
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=4000

# Switch to non-root user
USER wheelsai

EXPOSE 4000

# Health check. 127.0.0.1, not localhost: busybox wget resolves localhost
# to [::1] first, and the API binds 0.0.0.0 (IPv4 only), so a localhost
# probe is refused and marks a healthy container unhealthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/health || exit 1

# Start the API
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# RockScreener backend — ONE IMAGE, FOUR PROCESSES.
#
# The gateway, the indexer, the scorer and the trader are the same build with
# different entrypoints, and that is deliberate: they share the config loader,
# the Prisma client, the source clients and the scoring functions, so four
# images would be four copies of one dependency tree that must never drift
# apart. The compose file picks the command; nothing here knows which one it
# will be.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies. Only the manifests are copied first, so a source change does not
# invalidate the install layer — which is most of the build time.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @rockscreener/backend...

# ---------------------------------------------------------------------------
# Build. The shared package compiles first because the backend imports its
# .d.ts, not its source.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/backend/ apps/backend/
RUN pnpm --filter @rockscreener/shared build \
 && pnpm --filter @rockscreener/backend db:generate \
 && pnpm --filter @rockscreener/backend exec tsc -p tsconfig.json

# A PACKAGE WITH NO DEPENDENCIES GETS NO node_modules, and the runtime stage
# below copies one out of the shared package unconditionally.
#
# `@rockscreener/shared` is pure types and constants: it depends on nothing, so
# pnpm creates no directory for it, so that COPY would fail the whole build with
# "failed to compute cache key: /app/packages/shared/node_modules: not found".
#
# mkdir rather than deleting the COPY: the day somebody adds a dependency to
# shared, pnpm creates the directory and this line becomes a no-op, instead of
# the runtime image quietly shipping without it.
RUN mkdir -p packages/shared/node_modules

# ---------------------------------------------------------------------------
# Runtime.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules

COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY --from=build /app/apps/backend/node_modules apps/backend/node_modules
COPY --from=build /app/apps/backend/package.json apps/backend/package.json
COPY --from=build /app/apps/backend/prisma apps/backend/prisma
COPY --from=build /app/apps/backend/scripts apps/backend/scripts
# The thresholds. Read at boot and kept OUT of the image's secret surface on
# purpose — every credential it needs is referenced by ${NAME} from the
# environment.
COPY --from=build /app/apps/backend/configuration.json apps/backend/configuration.json

WORKDIR /app/apps/backend

# NEVER ROOT. Every one of these processes talks to the internet, and the trader
# holds decrypted keys in memory while it signs.
USER node

# Overridden per service in compose. The gateway is the sensible default because
# it is the one that answers a health check.
CMD ["node", "dist/gateway.js"]

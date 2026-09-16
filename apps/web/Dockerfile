# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# RockScreener web.
#
# Standalone output, so the runtime image carries the server and the exact
# subset of node_modules it traced rather than the whole workspace — a few tens
# of megabytes instead of several hundred.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @rockscreener/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/
# The web app imports the shared package's .d.ts, not its source.
RUN pnpm --filter @rockscreener/shared build

# BAKED AT BUILD TIME, NOT INJECTED AT RUN TIME. `NEXT_PUBLIC_*` is inlined into
# the client bundle by the compiler, so a value supplied only to `docker run`
# arrives too late and the browser calls a relative path that does not exist —
# which looks exactly like an API outage.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TELEGRAM_BOT
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_TELEGRAM_BOT=$NEXT_PUBLIC_TELEGRAM_BOT
RUN pnpm --filter @rockscreener/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3040
ENV HOSTNAME=0.0.0.0

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3040
CMD ["node", "apps/web/server.js"]

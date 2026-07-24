# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.6 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages

RUN pnpm --filter @autonomy-studio/shared build \
 && pnpm --filter @autonomy-studio/server build \
 && pnpm --filter @autonomy-studio/web build

# Drop dev dependencies (esbuild, vite, typescript, ...) — keep only what the
# server needs at runtime. `--legacy`: pnpm 10+ otherwise refuses to `deploy` a
# workspace without `inject-workspace-packages=true`; legacy deploy copies the
# built `@autonomy-studio/shared` (its `dist` produced above) into the pruned
# node_modules, which is exactly what the runtime needs.
RUN pnpm --filter @autonomy-studio/server --prod --legacy deploy /app/server-deploy

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Bind all interfaces so `-p 8080:8080` is reachable — a loopback bind inside the
# container netns is NOT reachable through Docker's published-port NAT. This
# exposes an UNAUTHENTICATED app (single fixed local principal); publish it only
# on a trusted network / behind your own auth proxy.
ENV HOST=0.0.0.0
# DB + the secret-encryption master key both live under one persisted dir, so a
# named volume on /app/data survives restarts. WITHOUT AUTONOMY_DATA_DIR the key
# would auto-regenerate every boot and make all stored secrets undecryptable.
ENV DB_PATH=/app/data/app.sqlite
ENV AUTONOMY_DATA_DIR=/app/data
# Serve the built web SPA from this same server (single-container self-host).
ENV WEB_ROOT=/app/web

COPY --from=build /app/server-deploy/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/drizzle ./drizzle
COPY --from=build /app/packages/server/package.json ./package.json
COPY --from=build /app/packages/web/dist ./web

# node:22-slim ships no curl/wget; Node 22 has global fetch. Targets loopback
# INSIDE the container (correct for a liveness probe) — proving external
# reachability is the operator's `-p` + network concern, not the healthcheck's.
# --start-period covers boot (reconcile + retention drain before serving).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080
CMD ["node", "dist/index.js"]

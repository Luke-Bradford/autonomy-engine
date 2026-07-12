# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.6 --activate

COPY pnpm-workspace.yaml package.json ./
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
# server needs at runtime.
RUN pnpm --filter @autonomy-studio/server deploy --prod /app/server-deploy

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/app/data/app.sqlite

COPY --from=build /app/server-deploy/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/drizzle ./drizzle
COPY --from=build /app/packages/server/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/index.js"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/stub-canvas/package.json apps/stub-canvas/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile
# .dockerignore keeps .env, data/, *.sqlite, .git and host node_modules out of this copy.
COPY . .
RUN pnpm --filter @canvas-agent/core --filter @canvas-agent/server run build
# Production dependencies of the server and its workspace packages only. A fresh install (not
# `pnpm prune`, which prompts without a TTY) keeps the workspace link to @canvas-agent/core.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && CI=true pnpm install --prod --frozen-lockfile --filter "@canvas-agent/server..."

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DB_PATH=/data/canvas-agent.sqlite
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
# The volume must belong to the user the server runs as, or SQLite cannot create its file.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "apps/server/dist/main.js"]

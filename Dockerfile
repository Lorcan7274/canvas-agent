FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/stub-canvas/package.json apps/stub-canvas/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @canvas-agent/core --filter @canvas-agent/server run build
RUN pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DB_PATH=/data/canvas-agent.sqlite
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "apps/server/dist/main.js"]

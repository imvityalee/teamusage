# Build from the repository root:
#   docker build -f packages/server/Dockerfile -t teamusage .
# Same base image for build and runtime, so the native better-sqlite3 binary matches.

FROM node:22-slim AS build
ENV CI=true
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
# Manifests first, so dependency installation is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/server packages/server
# tsup bundles the server (and shared); vite builds the dashboard into packages/server/web/dist.
RUN pnpm --filter @teamusage/server run build
# Production dependencies only (including the compiled better-sqlite3), without the rest of the workspace.
RUN pnpm --filter @teamusage/server deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production \
    TEAMUSAGE_DATA_DIR=/data
WORKDIR /app/packages/server
COPY --from=build /out/node_modules ./node_modules
# "type": "module", so Node loads dist/*.js as ES modules by declaration, not by syntax detection.
COPY --from=build /repo/packages/server/package.json ./package.json
COPY packages/server/LICENSE.md ./LICENSE.md
COPY --from=build /repo/packages/server/dist ./dist
COPY --from=build /repo/packages/server/web/dist ./web/dist
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin teamusage \
 && mkdir /data && chown teamusage:teamusage /data && chmod 700 /data \
 && ln -s /app/packages/server/dist/admin.js /usr/local/bin/teamusage-admin \
 && chmod 755 dist/admin.js dist/main.js
USER teamusage
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

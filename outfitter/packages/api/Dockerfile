# Outfitter control-plane API. Build context is outfitter/ (the npm workspace root), so the
# workspace lockfile resolves the api package's dependencies:
#   docker build -f packages/api/Dockerfile -t outfitter-api outfitter/
# One image serves both roles; OUTFITTER_ROLE=web|link is set per Cloud Run service.
#
# The api depends on the workspace package @outfitter/provider-local (its SandboxProvider
# implementations), which must be compiled with tsc before the api can import it: npm links the
# workspace into node_modules, but the link points at the package's source tree, whose `main` is
# dist/src/index.js. The first deploy after that dependency was introduced failed at startup with
# ERR_MODULE_NOT_FOUND because this file installed only the api workspace. Hence a builder stage.
#
# The builder stage also builds @outfitter/web (Vite) to packages/web/dist: routes/static.ts
# serves that directory at "/" when it exists. Only the built dist/ is copied into the final
# image -- the web workspace's own node_modules (React, Vite, etc.) never ship, keeping the
# runtime image build-stage-free per E3's "ship dist" requirement.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
# This stage installs devDependencies (it builds packages/web). One of them,
# mongodb-memory-server (packages/api's Mongo-backed tests), downloads a ~76 MB mongod in its
# postinstall; the image never runs tests, so skip it. The runtime stage below is --omit=dev.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/provider-local/package.json packages/provider-local/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace=@outfitter/api --workspace=@outfitter/provider-local --workspace=@outfitter/web --include-workspace-root=false
COPY packages/provider-local/src packages/provider-local/src
COPY packages/provider-local/tsconfig.json packages/provider-local/
RUN npm run build --workspace=@outfitter/provider-local
COPY packages/web/src packages/web/src
COPY packages/web/public packages/web/public
COPY packages/web/index.html packages/web/tsconfig.json packages/web/vite.config.ts packages/web/
RUN npm run build --workspace=@outfitter/web

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/provider-local/package.json packages/provider-local/
RUN npm ci --omit=dev --workspace=@outfitter/api --workspace=@outfitter/provider-local --include-workspace-root=false
COPY --from=builder /app/packages/provider-local/dist packages/provider-local/dist
COPY --from=builder /app/packages/web/dist packages/web/dist
COPY packages/api/src packages/api/src
COPY packages/api/tsconfig.json packages/api/
WORKDIR /app/packages/api
USER node
EXPOSE 8080
# Node 24 runs .ts directly (type stripping), same as `npm start` locally.
CMD ["node", "src/main.ts"]

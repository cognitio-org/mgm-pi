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
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/provider-local/package.json packages/provider-local/
RUN npm ci --workspace=@outfitter/api --workspace=@outfitter/provider-local --include-workspace-root=false
COPY packages/provider-local/src packages/provider-local/src
COPY packages/provider-local/tsconfig.json packages/provider-local/
RUN npm run build --workspace=@outfitter/provider-local

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/provider-local/package.json packages/provider-local/
RUN npm ci --omit=dev --workspace=@outfitter/api --workspace=@outfitter/provider-local --include-workspace-root=false
COPY --from=builder /app/packages/provider-local/dist packages/provider-local/dist
COPY packages/api/src packages/api/src
COPY packages/api/tsconfig.json packages/api/
WORKDIR /app/packages/api
USER node
EXPOSE 8080
# Node 24 runs .ts directly (type stripping), same as `npm start` locally.
CMD ["node", "src/main.ts"]

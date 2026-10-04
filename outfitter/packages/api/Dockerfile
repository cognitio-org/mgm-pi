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
#
# RUN --mount needs BuildKit: DOCKER_BUILDKIT=1 docker build ... (Docker 23+ uses it by default).
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
# Sentry source maps (#423, vite.config.ts sentrySourceMaps). The upload token arrives as a BuildKit
# secret (deploy/cloudbuild-api-sentry.yaml), mounted for this one RUN at /run/secrets and never
# written to a layer, a build arg or the log. It's read from the file rather than with the mount's
# env= option, which needs a newer BuildKit than every daemon has. Without the secret (local
# builds, deploy/cloudbuild-api.yaml before the owner stores it) the file is missing or empty and
# the web builds exactly as before. SENTRY_ORG/SENTRY_PROJECT are not secret (deploy/config.env).
# Then delete any *.map, upload or not: maps must never ship (deploy/test/sentry-sourcemaps.test.sh).
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    SENTRY_ORG="${SENTRY_ORG}" SENTRY_PROJECT="${SENTRY_PROJECT}" \
    npm run build --workspace=@outfitter/web \
  && find packages/web/dist -name '*.map' -type f -delete \
  && if find packages/web/dist -name '*.map' | grep -q .; then echo "source maps left in dist" >&2; exit 1; fi

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

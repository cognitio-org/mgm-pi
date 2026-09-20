# Outfitter control-plane API. Build context is outfitter/ (the npm workspace root), so the
# workspace lockfile resolves the api package's dependencies:
#   docker build -f packages/api/Dockerfile -t outfitter-api outfitter/
# One image serves both roles; OUTFITTER_ROLE=web|link is set per Cloud Run service.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --workspace=@outfitter/api --include-workspace-root=false
COPY packages/api/src packages/api/src
COPY packages/api/tsconfig.json packages/api/
WORKDIR /app/packages/api
USER node
EXPOSE 8080
# Node 24 runs .ts directly (type stripping), same as `npm start` locally.
CMD ["node", "src/main.ts"]

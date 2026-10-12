# Finance MCP. No secrets are copied into the image. Cloud Run mounts FINANCE_MCP_TOKEN
# and the process reads kernal_wise_key from Secret Manager at call time.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
RUN chmod -R a+rX /app

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/finance-mcp.mjs"]

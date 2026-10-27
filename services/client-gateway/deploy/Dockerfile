FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY libs/chat_runtime /libs/chat_runtime
COPY services/client-gateway/package.json services/client-gateway/package-lock.json services/client-gateway/.npmrc ./
RUN npm ci --omit=dev
FROM dependencies AS tests
COPY services/client-gateway/ ./
ENTRYPOINT ["npm", "test"]
FROM dependencies AS runtime
ENV NODE_ENV=production PORT=8080 INTERNAL_PORT=8443
COPY services/client-gateway/src ./src
USER 10001:10001
EXPOSE 8080 8443
ENTRYPOINT ["node", "src/main.mjs"]

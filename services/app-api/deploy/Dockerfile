FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY services/app-api/package.json services/app-api/package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY services/app-api/ ./
RUN npm run build

FROM build AS tests
ENTRYPOINT ["sh", "-c", "npm run format:check && npm run lint && npm test && npm run test:e2e"]

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 LISTEN_ADDRESS=0.0.0.0
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]

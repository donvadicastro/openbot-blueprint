FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY bin ./bin
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY schemas ./schemas
COPY deploy/openbot/.env.example ./deploy/openbot/.env.example
# Blueprint definitions are supplied through a read-only bind mount at runtime.
ENTRYPOINT ["node", "dist/bin/openbot-compose.js"]

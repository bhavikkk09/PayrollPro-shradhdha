# One image serving the API and the built web app. Used by Render and docker compose.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci || npm install
COPY apps apps
RUN cd apps/api && npx prisma generate && npx nest build
RUN cd apps/web && npx vite build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/apps/api apps/api
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --chown=node:node scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
USER node
EXPOSE 3000
CMD ["/app/docker-entrypoint.sh"]

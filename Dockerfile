FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data/uploads /data/reports && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]

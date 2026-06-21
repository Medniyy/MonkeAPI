FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY data ./data

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 1001 monke \
    && useradd --system --uid 1001 --gid monke monke \
    && mkdir -p /app/.cache \
    && chown -R monke:monke /app

COPY --from=build --chown=monke:monke /app/package.json ./package.json
COPY --from=build --chown=monke:monke /app/node_modules ./node_modules
COPY --from=build --chown=monke:monke /app/dist ./dist
COPY --from=build --chown=monke:monke /app/data ./data

USER monke
EXPOSE 3000

CMD ["node", "dist/server.js"]

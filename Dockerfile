FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack install --global pnpm@10.32.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S watchlater && adduser -S watchlater -G watchlater

FROM runtime-base AS runtime
COPY --from=build --chown=watchlater:watchlater /app/package.json ./package.json
COPY --from=build --chown=watchlater:watchlater /app/node_modules ./node_modules
COPY --from=build --chown=watchlater:watchlater /app/dist ./dist
COPY --from=build --chown=watchlater:watchlater /app/drizzle ./drizzle
USER watchlater
EXPOSE 3000
CMD ["node", "dist/src/server.js"]

FROM runtime-base AS worker-runtime
RUN apk add --no-cache ffmpeg chromium yt-dlp
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
COPY --from=build --chown=watchlater:watchlater /app/package.json ./package.json
COPY --from=build --chown=watchlater:watchlater /app/node_modules ./node_modules
COPY --from=build --chown=watchlater:watchlater /app/dist ./dist
COPY --from=build --chown=watchlater:watchlater /app/drizzle ./drizzle
USER watchlater
CMD ["node", "dist/src/worker.js"]

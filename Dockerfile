# Build with bun, run on node (Flue's Node runtime needs node:sqlite, which bun lacks).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HEFYN_DATA_DIR=/data
# The build externalizes dependencies, so ship node_modules (runtime deps only).
COPY --from=build /app/package.json /app/bun.lock* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# uid/gid 1000 (user `node`): same as the sandbox user, so files written by web/agent and by shells are interchangeable.
RUN mkdir -p /data/models && chown -R 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.mjs"]

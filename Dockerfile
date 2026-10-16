# Build with bun, run on node (Flue's Node runtime needs node:sqlite, which bun lacks).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Optional: bake the GLiNER model into the image (docker compose build --build-arg HEFYN_GLINER_BAKE=1, optionally
# --build-arg HEFYN_GLINER_BASE_URL=https://mirror.example/gliner). Without it this stage only creates an empty directory.
FROM oven/bun:1 AS models
ARG HEFYN_GLINER_BAKE=0
ARG HEFYN_GLINER_BASE_URL=
WORKDIR /app
COPY scripts/gliner-fetch.ts scripts/
COPY src/server/redact/models.ts src/server/redact/notice.ts src/server/redact/
RUN mkdir -p /opt/hefyn/models/gliner && if [ "$HEFYN_GLINER_BAKE" = "1" ]; then \
      bun scripts/gliner-fetch.ts /opt/hefyn/models/gliner ${HEFYN_GLINER_BASE_URL:+"$HEFYN_GLINER_BASE_URL"} && touch /opt/hefyn/BAKED && chmod -R a-w /opt/hefyn; fi

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HEFYN_DATA_DIR=/data
# The build externalizes dependencies, so ship node_modules (runtime deps only).
COPY --from=build /app/package.json /app/bun.lock* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=models /opt/hefyn /opt/hefyn
# uid/gid 1000 (user `node`): same as the sandbox user, so files written by web/agent and by shells are interchangeable.
RUN mkdir -p /data/models && chown -R 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.mjs"]

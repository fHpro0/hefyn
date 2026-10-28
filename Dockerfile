# Bun everywhere: build and run on the same pinned Bun. The servers run the TypeScript sources directly (no bundles);
# only the console (bundled by Bun, static output in dist/web) is built.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HEFYN_DATA_DIR=/data
COPY --from=build /app/package.json /app/bun.lock* /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/profiles ./profiles
COPY --from=build /app/dist ./dist
# uid/gid 1000 (user `bun` in this image): same as the sandbox user, so files written by web/agent and by shells are interchangeable.
RUN mkdir -p /data && chown -R 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3000
CMD ["bun", "src/agent.ts"]

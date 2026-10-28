# Runner: holds /var/run/docker.sock (root-equivalent). Keep it small, internal-only, and run with cap_drop ALL (+CHOWN, FOWNER, DAC_OVERRIDE).
# Zero dependencies: plain TypeScript run by Bun (the same pinned version as the app image).
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8790 HEFYN_DATA_DIR=/data
CMD ["bun", "src/server.ts"]

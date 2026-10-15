# Runner: holds /var/run/docker.sock (root-equivalent). Keep it small, internal-only, and run with cap_drop ALL (+CHOWN, FOWNER, DAC_OVERRIDE).
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8790 HEFYN_DATA_DIR=/data
CMD ["node", "src/server.ts"]

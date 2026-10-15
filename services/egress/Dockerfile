# Egress proxy: the agent's only way out. Zero dependencies.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production PORT=3128
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 CMD node -e "fetch('http://localhost:'+(process.env.PORT||3128)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]

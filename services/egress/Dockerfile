# Egress proxy: the agent's only way out. Zero dependencies; plain TypeScript run by Bun (the same pinned version as the app image).
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json ./
COPY src ./src
USER bun
ENV NODE_ENV=production PORT=3128
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3128)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "src/server.ts"]

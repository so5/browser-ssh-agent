FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/bssh-agent-entrypoint.sh
RUN chmod +x /usr/local/bin/bssh-agent-entrypoint.sh \
    && ln -s /app/dist/bin/bssh-agent.js /usr/local/bin/bssh-agent
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/bssh-agent-entrypoint.sh"]

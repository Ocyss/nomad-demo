FROM oven/bun:1.4.4

WORKDIR /app
LABEL org.opencontainers.image.title="nomad-demo"

ARG APP_VERSION
ARG DEPLOY_COLOR=cyan

ENV NODE_ENV=production PORT=3000 APP_VERSION=${APP_VERSION} DEPLOY_COLOR=${DEPLOY_COLOR}

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun package.json ./

USER bun

EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "src/index.ts"]

# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04 AS toolchain

ARG TARGETARCH
ARG NODE_VERSION=22.23.1
ARG CODEX_VERSION=0.144.5

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git tini xz-utils build-essential python3 pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH:-amd64}" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ --strip-components=1 -C /usr/local \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && codex --version

FROM toolchain AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/codex-client/package.json packages/codex-client/package.json
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM toolchain AS runtime
ENV NODE_ENV=production \
    ORKESTR_HOME=/data \
    CODEX_HOME=/data/codex \
    ORKESTR_WORKSPACE=/workspace \
    ORKESTR_HOST=0.0.0.0 \
    ORKESTR_PORT=3000 \
    ORKESTR_CODEX_VERSION=0.144.5

RUN if getent passwd ubuntu >/dev/null; then userdel --remove ubuntu; fi \
  && if getent group ubuntu >/dev/null; then groupdel ubuntu; fi \
  && groupadd --gid 1000 orkestr \
  && useradd --uid 1000 --gid orkestr --create-home --shell /bin/bash orkestr \
  && mkdir -p /app /data/codex /workspace /opt/orkestr-demo \
  && chown -R orkestr:orkestr /app /data /workspace /opt/orkestr-demo

WORKDIR /app
COPY --from=build --chown=orkestr:orkestr /app/node_modules ./node_modules
COPY --from=build --chown=orkestr:orkestr /app/dist ./dist
COPY --from=build --chown=orkestr:orkestr /app/packages/shared ./packages/shared
COPY --from=build --chown=orkestr:orkestr /app/packages/codex-client ./packages/codex-client
COPY --from=build --chown=orkestr:orkestr /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=orkestr:orkestr /app/package.json ./package.json
COPY --chown=orkestr:orkestr demo/workspace/ /opt/orkestr-demo/
COPY --chown=orkestr:orkestr docker/entrypoint.sh /usr/local/bin/orkestr-entrypoint
RUN chmod 0755 /usr/local/bin/orkestr-entrypoint

USER orkestr
EXPOSE 3000
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orkestr-entrypoint"]

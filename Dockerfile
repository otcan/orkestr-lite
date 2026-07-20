# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim AS chromium-payload

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && mkdir -p /opt/chromium-compat \
  && ldd /usr/lib/chromium/chromium \
    | awk '/=> \/(lib|usr\/lib)\// { print $3 }' \
    | while read -r library; do \
        name="$(basename "$library")"; \
        case "$name" in \
          libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|libresolv.so.*|libstdc++.so.*|libgcc_s.so.*) continue ;; \
        esac; \
        cp -L "$library" "/opt/chromium-compat/$name"; \
      done \
  && rm -rf /var/lib/apt/lists/*

FROM ubuntu:24.04 AS toolchain

ARG TARGETARCH
ARG NODE_VERSION=22.23.1
ARG CODEX_VERSION=0.144.5

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git tini xz-utils build-essential python3 pkg-config \
    tmux byobu sudo ripgrep jq unzip zip openssh-client less vim nano procps lsof \
    iproute2 iputils-ping dnsutils netcat-openbsd \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2t64 libdbus-1-3 \
    libdrm2 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 libopenh264-7 xdg-utils fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

COPY --from=chromium-payload /usr/lib/chromium/ /usr/lib/chromium/
COPY --from=chromium-payload /etc/chromium.d/ /etc/chromium.d/
COPY --from=chromium-payload /usr/share/chromium/ /usr/share/chromium/
COPY --from=chromium-payload /opt/chromium-compat/ /opt/chromium-compat/
COPY docker/chromium-launcher.sh /usr/bin/chromium
RUN chmod 0755 /usr/bin/chromium

RUN case "${TARGETARCH:-amd64}" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ --strip-components=1 -C /usr/local \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && codex --version \
  && chromium --version

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
    CODEX_HOME=/codex \
    ORKESTR_WORKSPACE=/workspace \
    ORKESTR_HOST=0.0.0.0 \
    ORKESTR_PORT=3000 \
    ORKESTR_CODEX_VERSION=0.144.5 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WA_CHROME_PATH=/usr/bin/chromium

RUN if getent passwd ubuntu >/dev/null; then userdel --remove ubuntu; fi \
  && if getent group ubuntu >/dev/null; then groupdel ubuntu; fi \
  && groupadd --gid 1000 orkestr \
  && useradd --uid 1000 --gid orkestr --create-home --shell /bin/bash orkestr \
  && mkdir -p /app /data/codex /codex /workspace /opt/orkestr-demo /run/orkestr-desk-auth \
  && chown -R orkestr:orkestr \
    /app /data /codex /workspace /opt/orkestr-demo /run/orkestr-desk-auth

WORKDIR /app
COPY --from=build --chown=orkestr:orkestr /app/node_modules ./node_modules
COPY --from=build --chown=orkestr:orkestr /app/dist ./dist
COPY --from=build --chown=orkestr:orkestr /app/packages/shared ./packages/shared
COPY --from=build --chown=orkestr:orkestr /app/packages/codex-client ./packages/codex-client
COPY --from=build --chown=orkestr:orkestr /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=orkestr:orkestr /app/package.json ./package.json
COPY --chown=orkestr:orkestr demo/workspace/ /opt/orkestr-demo/
COPY --chown=orkestr:orkestr docker/entrypoint.sh /usr/local/bin/orkestr-entrypoint
COPY docker/orkestr-sudoers /etc/sudoers.d/orkestr
RUN chmod 0755 /usr/local/bin/orkestr-entrypoint \
  && chmod 0440 /etc/sudoers.d/orkestr \
  && visudo --check --file=/etc/sudoers.d/orkestr

USER orkestr
EXPOSE 3000
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orkestr-entrypoint"]

FROM runtime AS desk-runtime
USER root
ENV HOME=/home/orkestr \
    DISPLAY=:1 \
    ORKESTR_DESK_HOST=0.0.0.0 \
    ORKESTR_DESK_PORT=3100 \
    ORKESTR_DESK_TOKEN_FILE=/run/orkestr-desk-auth/token

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    dbus-x11 xfce4 xfce4-terminal thunar tigervnc-standalone-server \
    websockify xfonts-base fonts-dejavu-core util-linux xdotool wmctrl scrot \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/orkestr-desk-auth /home/orkestr/.config /home/orkestr/.cache \
  && chown -R orkestr:orkestr /home/orkestr /run/orkestr-desk-auth

COPY docker/desk-entrypoint.sh /usr/local/bin/orkestr-desk-entrypoint
COPY docker/desk-xdg-open.sh /usr/local/bin/xdg-open
RUN chmod 0755 /usr/local/bin/orkestr-desk-entrypoint /usr/local/bin/xdg-open

USER orkestr
EXPOSE 3100 6080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3100/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orkestr-desk-entrypoint"]

FROM runtime AS final

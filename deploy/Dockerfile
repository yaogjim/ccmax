# ccmax 产品镜像：运行源码 Server + CLI + H5。
#
# 设计约束（与 deploy/build.sh、deploy/Dockerfile.dockerignore 配合）：
#   - 构建上下文是仓库根目录，但通过 Dockerfile.dockerignore 白名单只放行产品源码。
#     真实 providers、会话配置、浏览器登录态、.env 永远不会进入构建上下文。
#   - 只安装仓库根与 desktop 各自的冻结锁文件（bun.lock），不在镜像内升级依赖。
#   - 运行期不使用 root：UID/GID 1000:1000，工作目录与 HOME 是 /workspace，
#     配置目录是 /config。不使用 --privileged、不挂载 Docker socket、不暴露浏览器调试端口。
#   - 容器内禁用自动 dotenv：CC_HAHA_SKIP_DOTENV=1 让 bin/ccmax 始终传 --no-env-file。

ARG BUN_IMAGE=oven/bun:1.3.14
ARG DEBIAN_IMAGE=debian:bookworm-slim

# 只用于从官方 Bun 镜像中取出 bun 可执行文件，避免自建安装脚本带来的不确定性。
FROM ${BUN_IMAGE} AS bun-bin
FROM ${DEBIAN_IMAGE} AS os-base

ARG NODE_MAJOR=24
ARG AGENT_BROWSER_VERSION=0.39.0
ARG CCMAX_UID=1000
ARG CCMAX_GID=1000

# 固定 npm 行为，杜绝隐式安装 latest、审计上报或构建期自动升级提示。
ENV BUN_INSTALL=/usr/local \
    DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

# ── 系统层：Node 24（agent-browser 的安装与运行要求）、Chromium、诊断工具、字体 ──
# 系统包使用发行版受支持的版本与安全更新；本镜像不宣称字节级可重复构建，
# 实际安装版本由 build.sh 在构建后通过镜像标签与工具清单记录。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh; \
    bash /tmp/nodesource_setup.sh; \
    rm -f /tmp/nodesource_setup.sh; \
    apt-get install -y --no-install-recommends nodejs; \
    node --version; \
    npm --version

# CA 已在上一层安装：系统工具包改用官方 HTTPS 源，有限重试应对临时下载失败。
RUN set -eux; \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
      -exec sed -i 's|http://deb.debian.org|https://deb.debian.org|g' {} +; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      chromium \
      curl wget ca-certificates \
      iputils-ping dnsutils net-tools traceroute iproute2 \
      jq git python3 \
      fonts-liberation fonts-noto-cjk \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libgbm1 libasound2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 libxkbcommon0 libgtk-3-0 libxshmfence1 \
      libx11-xcb1 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/bin/chromium --version; \
    bun --version

# ── agent-browser：仅安装显式锁定的精确版本，禁止 latest 与构建期自动升级 ──
RUN set -eux; \
    case "${AGENT_BROWSER_VERSION}" in \
      latest|"") echo "AGENT_BROWSER_VERSION 必须是精确版本号" >&2; exit 1 ;; \
    esac; \
    npm install --global --no-fund --no-audit "agent-browser@${AGENT_BROWSER_VERSION}"; \
    agent-browser --version

# ── 非 root 运行身份与持久化挂载点 ──
RUN set -eux; \
    groupadd --gid "${CCMAX_GID}" ccmax; \
    useradd --uid "${CCMAX_UID}" --gid "${CCMAX_GID}" \
      --create-home --home-dir /workspace --shell /bin/bash ccmax; \
    install -d -o "${CCMAX_UID}" -g "${CCMAX_GID}" -m 0755 /config /app

# ── 构建专用编译链：node-pty 等原生依赖需要 make、C++ 与 Python ──
# 编译工具仅进入依赖/H5 构建阶段；最终运行镜像仍基于 os-base。
FROM os-base AS build-base

RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends build-essential; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/bin/make; \
    test -x /usr/bin/g++; \
    test -x /usr/bin/python3

# ── 根依赖：只使用冻结锁文件，保证镜像内依赖与仓库一致 ──
# 同时复制 preload.ts：bunfig.toml 声明了 `preload = ["./preload.ts"]`，
# 该文件缺失时 bun 在 /app 下的任何调用都可能因解析 preload 而失败。
FROM build-base AS root-deps

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json preload.ts ./
RUN set -eux; \
    bun install --frozen-lockfile --no-progress; \
    test -d /app/node_modules

# ── H5 构建：在 Linux 构建环境内生成 desktop/dist，复用 desktop 自己的锁文件 ──
# 该阶段直接基于 build-base，避免 /app/bunfig.toml 影响 desktop 目录下的 bun 调用。
FROM build-base AS web-build

WORKDIR /app
COPY desktop/package.json desktop/bun.lock ./desktop/
RUN set -eux; \
    cd /app/desktop; \
    bun install --frozen-lockfile --no-progress

# desktop 的 H5 构建会经相对导入进入仓库根 src/（例如 desktop/src/components/
# agentTeams/AgentTeamsPlanCard.tsx → src/shared/teamPlan.ts → zod/v4），
# 这类依赖只声明在根 bun.lock，desktop 锁文件里没有。因此这里必须同时提供
# 根 node_modules，否则 vite 解析 zod/v4 失败、H5 构建直接中断。
# 直接复用 root-deps 阶段的产物，不重复安装。desktop/bunfig.toml 是仓库内
# 刻意保留的「覆盖父级 bunfig」文件，因此 desktop 目录下的 bun 调用不会被
# /app/bunfig.toml 的 preload 影响。
COPY --from=root-deps /app/node_modules /app/node_modules
COPY . .
RUN set -eux; \
    cd /app/desktop; \
    bun run build; \
    test -f /app/desktop/dist/index.html

# ── 运行镜像 ──
FROM os-base AS runtime

ARG CCMAX_VERSION=0.0.0-unknown
ARG CCMAX_REVISION=unknown
ARG CCMAX_BUILD_TIME=unknown
ARG CCMAX_DIRTY=unknown
ARG AGENT_BROWSER_VERSION=0.39.0
ARG NODE_MAJOR=24
ARG BUN_IMAGE=oven/bun:1.3.14
ARG DEBIAN_IMAGE=debian:bookworm-slim

LABEL org.opencontainers.image.title="ccmax-server-h5" \
      org.opencontainers.image.description="ccmax local Server + CLI + H5 runtime" \
      org.opencontainers.image.version="${CCMAX_VERSION}" \
      org.opencontainers.image.revision="${CCMAX_REVISION}" \
      org.opencontainers.image.created="${CCMAX_BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/yaogjim/ccmax" \
      com.ccmax.source.dirty="${CCMAX_DIRTY}" \
      com.ccmax.agent-browser.version="${AGENT_BROWSER_VERSION}"

WORKDIR /app

# 产品源码、CLI 入口与 preload。node_modules 与 H5 产物来自构建阶段，
# 均通过 Dockerfile.dockerignore 与显式 COPY 控制，不包含任何运行数据。
COPY . .
COPY --from=root-deps /app/node_modules /app/node_modules
COPY --from=web-build /app/desktop/dist /app/desktop/dist

RUN set -eux; \
    chmod +x \
      /app/bin/ccmax \
      /app/bin/claude-haha \
      /app/deploy/build.sh \
      /app/deploy/export.sh \
      /app/deploy/service.sh \
      /app/deploy/image-smoke.sh \
      /app/deploy/scripts/common.sh; \
    test -x /app/bin/ccmax; \
    test -f /app/preload.ts; \
    test -f /app/src/server/index.ts; \
    test -f /app/src/entrypoints/cli.tsx; \
    test -f /app/runtime/win_helper.py; \
    test -f /app/runtime/win_cursor_badge.py; \
    test -f /app/runtime/requirements-win.txt; \
    test -f /app/desktop/dist/index.html; \
    test -f /app/bunfig.toml

# ── 镜像内工具清单：由镜像自身生成，导出/交付时随镜像一起保留 ──
# 关键点：这里记录的是「真正装进镜像的」版本与 dpkg 包清单，
# 而不是构建机上的 bun/工具版本；交付方可直接据此复核镜像内容。
RUN set -eux; \
    dpkg-query -W -f='${Package}\t${Version}\n' > /tmp/dpkg.tsv; \
    jq -n \
      --arg builtAt "${CCMAX_BUILD_TIME}" \
      --arg productVersion "${CCMAX_VERSION}" \
      --arg productRevision "${CCMAX_REVISION}" \
      --arg bunImage "${BUN_IMAGE}" \
      --arg debianImage "${DEBIAN_IMAGE}" \
      --arg nodeMajor "${NODE_MAJOR}" \
      --arg agentBrowserPin "${AGENT_BROWSER_VERSION}" \
      --arg bun "$(bun --version)" \
      --arg node "$(node --version)" \
      --arg npm "$(npm --version)" \
      --arg chromium "$(/usr/bin/chromium --version)" \
      --arg agentBrowser "$(agent-browser --version)" \
      --arg osRelease "$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")" \
      --arg arch "$(dpkg --print-architecture)" \
      --rawfile dpkg /tmp/dpkg.tsv \
      '{schemaVersion:1,generatedFrom:"image-build",builtAt:$builtAt,productVersion:$productVersion,productRevision:$productRevision,baseImages:{bun:$bunImage,debian:$debianImage,nodeMajor:$nodeMajor},pins:{agentBrowser:$agentBrowserPin},runtimes:{bun:$bun,node:$node,npm:$npm,chromium:$chromium,agentBrowser:$agentBrowser},os:{release:$osRelease,architecture:$arch},dpkgPackages:($dpkg | split("\n") | map(select(length>0)) | map(split("\t") | {name:.[0],version:.[1]}))}' \
      > /app/deploy/image-inventory.json; \
    jq -e '(.dpkgPackages | length) > 20 and (.runtimes.bun | length) > 0' /app/deploy/image-inventory.json > /dev/null; \
    rm -f /tmp/dpkg.tsv; \
    test -s /app/deploy/image-inventory.json

# 运行期身份与路径。SERVER_HOST/SERVER_PORT 通过环境变量给出，
# 这样部署方无需改镜像即可覆盖监听地址与端口。
ENV NODE_ENV=production \
    BUN_INSTALL=/usr/local \
    CC_HAHA_SKIP_DOTENV=1 \
    CC_HAHA_ROOT=/app \
    HOME=/workspace \
    CLAUDE_CONFIG_DIR=/config \
    CLAUDE_H5_DIST_DIR=/app/desktop/dist \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=18081 \
    APP_VERSION="${CCMAX_VERSION}" \
    CLAUDE_CODE_LOCAL_VERSION="${CCMAX_VERSION}" \
    CLAUDE_CODE_LOCAL_BUILD_TIME="${CCMAX_BUILD_TIME}" \
    PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 数据目录以卷形式声明；调用方应显式 bind mount，避免误用匿名卷。
VOLUME ["/config", "/workspace"]

EXPOSE 18081

# 健康检查直接读取运行期 SERVER_PORT，探 127.0.0.1/health 并要求 JSON status=ok。
# 用 shell 形式让 ${SERVER_PORT} 在容器运行时展开，部署方改端口无需重建镜像。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'

WORKDIR /workspace
USER 1000:1000

# 直接用 bun 加载仓库 preload.ts，不依赖 /workspace 下的临时启动文件。
# --no-env-file 是硬要求：镜像内绝不隐式加载 .env，避免把 workspace 里的
# dotenv 当作产品默认配置（bin/ccmax 也依赖 CC_HAHA_SKIP_DOTENV=1 达到同样效果）。
CMD ["bun", "--no-env-file", "--preload", "/app/preload.ts", "/app/src/server/index.ts"]
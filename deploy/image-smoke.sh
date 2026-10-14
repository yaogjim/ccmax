#!/usr/bin/env bash
#
# ccmax 产品镜像的隔离冒烟检查。
#
# 这是可选的、需要 Docker 守护进程的手动验证，不属于任何必需 CI 车道：
# 未显式传入 --allow-docker 时只打印跳过原因并以 0 退出。
#
# 隔离要求（必须保持）：
#   - 容器内 /config 与 /workspace 使用 docker tmpfs（uid=1000,gid=1000），
#     不再把宿主临时目录 bind mount 进去 —— 宿主目录属主是当前用户，
#     容器内 UID 1000 既读不了也写不了，会造成假失败；
#   - 只额外只读挂载本次生成的冒烟脚本本身，绝不挂载真实 HOME 或真实 ~/.claude；
#   - 容器以 --network none 运行，只在容器内部访问回环地址，不发起任何外部网络请求；
#   - 不挂载 Docker socket，不使用 --privileged，不额外授予 capability；
#   - 不调用真实模型、不调用真实消息平台、不启动桌面应用。
#
# 本机 endpoint：--allow-docker 后、任何 Docker 调用之前只读 docker context 元数据，
# 只接受本机 unix:/// 绝对 socket；DOCKER_HOST、DOCKER_CONTEXT 或当前 current context
# 指向远端时直接拒绝。未传 --allow-docker 时本脚本不调用 Docker，直接跳过。
#
# 用法: deploy/image-smoke.sh --image REF --allow-docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
. "${SCRIPT_DIR}/scripts/common.sh"

IMAGE_REF=""
ALLOW_DOCKER="0"
KEEP_TMP="0"

usage() {
  cat <<'EOF'
用法: deploy/image-smoke.sh --image REF --allow-docker [选项]

在隔离的临时容器中启动镜像，检查运行身份、目录可写性、环境变量、镜像内工具清单、
真实 CLI 入口（--help）、服务启动探针与真实浏览器动作。

选项:
  --image REF       必需。镜像 ID 或精确标签；拒绝 latest。
  --allow-docker    必需开关。缺少时脚本只打印跳过原因并以 0 退出。
  --keep-tmp        保留临时目录用于排错（默认删除）
  -h, --help        显示本帮助

退出码: 0 通过或跳过；1 参数错误或冒烟失败（失败码会原样透出）。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) [ "$#" -ge 2 ] || die "--image 需要参数"; IMAGE_REF="$2"; shift 2 ;;
    --image=*) IMAGE_REF="${1#--image=}"; shift ;;
    --allow-docker) ALLOW_DOCKER="1"; shift ;;
    --keep-tmp) KEEP_TMP="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知选项: $1（使用 --help 查看用法）" ;;
  esac
done

if [ "$ALLOW_DOCKER" != "1" ]; then
  info "跳过镜像冒烟：未传入 --allow-docker。"
  info "该检查需要本地 Docker 守护进程并会启动容器，因此默认不执行。"
  exit 0
fi

[ -n "$IMAGE_REF" ] || die "必须用 --image 指定镜像"
reject_floating_image_ref "$IMAGE_REF"

require_cmd docker
# daemon 查询之前先确认 endpoint 是本机（DOCKER_HOST / DOCKER_CONTEXT / 当前 context）。
require_local_docker_endpoint docker inspect >/dev/null
if ! docker info >/dev/null 2>&1; then
  die "无法连接 Docker 守护进程；请先确认 Docker/Colima 已启动（本脚本不会自动启动它）"
fi

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$IMAGE_ID" ] || die "本地找不到镜像 ${IMAGE_REF}"
# 与 export.sh 相同：标签解析为镜像 ID 后，后续 inspect 与 docker run 都锁定该 ID，
# 避免 tag 在检查期间被重新指向别的镜像（TOCTOU）。
IMAGE_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_ID" 2>/dev/null | tr -d '\r\n' || true)"

# 宿主临时目录只用来存放冒烟脚本；它不会被容器写入，也不承载用户数据。
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccmax-image-smoke.XXXXXX")"
SMOKE_SCRIPT="${TMP_ROOT}/smoke.sh"

cleanup() {
  local status=$?
  if [ "$KEEP_TMP" = "1" ]; then
    warn "已保留临时目录: ${TMP_ROOT}"
  else
    rm -rf "$TMP_ROOT"
  fi
  # 原样透出失败码：cleanup 不得把失败吞成 0。
  exit "$status"
}
trap cleanup EXIT

cat > "$SMOKE_SCRIPT" <<'INNER'
set -u

failures=0
server_pid=""

fail() {
  printf 'FAIL %s\n' "$*"
  failures=$((failures + 1))
}

ok() {
  printf 'ok   %s\n' "$*"
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label = $actual"
  else
    fail "$label expected=$expected actual=$actual"
  fi
}

check_present() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then
    ok "$label = $path"
  else
    fail "$label missing: $path"
  fi
}

check_tool() {
  local bin="$1"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "tool $bin -> $(command -v "$bin")"
  else
    fail "tool missing: $bin"
  fi
}

check_writable() {
  local label="$1" dir="$2"
  if [ -w "$dir" ] && ( : > "${dir}/.ccmax-smoke-write" ) 2>/dev/null; then
    rm -f "${dir}/.ccmax-smoke-write" 2>/dev/null || true
    ok "$label 可由 UID $(id -u) 写入 ($dir)"
  else
    fail "$label 不可写 ($dir)"
  fi
}

cleanup_inner() {
  local status=$?
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup_inner EXIT

PORT="${SERVER_PORT:-18081}"
BASE_URL="http://127.0.0.1:${PORT}"

printf '== 运行身份 ==\n'
check_eq "uid" "1000" "$(id -u)"
check_eq "gid" "1000" "$(id -g)"
check_eq "cwd" "/workspace" "$(pwd)"
check_eq "HOME" "/workspace" "${HOME}"
check_eq "CLAUDE_CONFIG_DIR" "/config" "${CLAUDE_CONFIG_DIR:-}"
check_eq "AGENT_BROWSER_EXECUTABLE_PATH" "/usr/bin/chromium" "${AGENT_BROWSER_EXECUTABLE_PATH:-}"
check_eq "SERVER_PORT" "18081" "$PORT"

printf '== 目录可写性（tmpfs 权限）==\n'
check_writable "config" "/config"
check_writable "workspace" "/workspace"
check_writable "tmp" "/tmp"

printf '== 路径与产物 ==\n'
check_present "preload" "/app/preload.ts"
check_present "server entry" "/app/src/server/index.ts"
check_present "cli entry" "/app/src/entrypoints/cli.tsx"
check_present "h5 index" "/app/desktop/dist/index.html"
check_present "chromium" "/usr/bin/chromium"
check_present "镜像内工具清单" "/app/deploy/image-inventory.json"

printf '== 工具清单 ==\n'
for bin in bun node npm agent-browser chromium curl wget ping dig nslookup netstat traceroute ss ip jq git python3; do
  check_tool "$bin"
done
printf 'bun     %s\n' "$(bun --version 2>&1 | head -n 1)"
printf 'node    %s\n' "$(node --version 2>&1 | head -n 1)"
printf 'chromium %s\n' "$(chromium --version 2>&1 | head -n 1)"
printf 'agent-browser %s\n' "$(agent-browser --version 2>&1 | head -n 1)"

printf '== 镜像内工具清单抽查 ==\n'
if command -v jq >/dev/null 2>&1; then
  inv_count="$(jq -r '.dpkgPackages | length' /app/deploy/image-inventory.json 2>/dev/null || echo 0)"
  inv_bun="$(jq -r '.runtimes.bun' /app/deploy/image-inventory.json 2>/dev/null || echo '')"
  check_eq "清单内 bun 版本" "$(bun --version 2>&1 | head -n 1)" "$inv_bun"
  if [ "${inv_count:-0}" -gt 20 ] 2>/dev/null; then
    ok "清单内 dpkg 包数量 = $inv_count"
  else
    fail "清单内 dpkg 包数量异常: $inv_count"
  fi
fi

printf '== 真实 CLI 入口（--help，不调用模型）==\n'
if cli_out="$(/app/bin/ccmax --help 2>/tmp/cli-help.err)"; then
  if printf '%s' "$cli_out" | grep -q 'Usage'; then
    ok "/app/bin/ccmax --help 输出了用法（$(printf '%s\n' "$cli_out" | wc -l | tr -d ' ') 行）"
  else
    fail "/app/bin/ccmax --help 未输出 Usage"
    printf '%s\n' "$cli_out" | head -n 20
  fi
else
  fail "/app/bin/ccmax --help 退出码非 0"
  tail -n 30 /tmp/cli-help.err 2>/dev/null || true
fi

printf '== 禁止隐式 dotenv（workspace .env 不得被加载）==\n'
printf 'CCMAX_SMOKE_DOTENV=leaked\n' > /workspace/.env
probe="$(cd /workspace && bun --no-env-file -e 'console.log(process.env.CCMAX_SMOKE_DOTENV ?? "absent")' 2>/dev/null || echo probe-failed)"
check_eq "--no-env-file 下 workspace .env 未被加载" "absent" "$probe"
control="$(cd /workspace && bun -e 'console.log(process.env.CCMAX_SMOKE_DOTENV ?? "absent")' 2>/dev/null || echo control-failed)"
printf 'info 对照（不带 --no-env-file）: %s\n' "$control"
rm -f /workspace/.env

printf '== 服务启动探针（与镜像 CMD 相同：bun --no-env-file）==\n'
SERVER_HOST=127.0.0.1 bun --no-env-file --preload /app/preload.ts /app/src/server/index.ts \
  > /tmp/server.log 2>&1 &
server_pid=$!
health=""
for _ in $(seq 1 60); do
  health="$(curl -fsS "${BASE_URL}/health" 2>/dev/null || true)"
  [ -n "$health" ] && break
  sleep 1
done
if [ -n "$health" ]; then
  if printf '%s' "$health" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ok "/health 返回 JSON status=ok"
  else
    fail "/health 未返回 status=ok: $health"
  fi
else
  fail "/health 未在 60 秒内就绪"
  tail -n 40 /tmp/server.log 2>/dev/null || true
fi

root_status="$(curl -s -o /tmp/index.html -w '%{http_code}' "${BASE_URL}/" 2>/dev/null || echo 000)"
if [ "$root_status" = "200" ] && grep -qi '<html' /tmp/index.html 2>/dev/null; then
  ok "H5 首页 HTTP $root_status"
else
  fail "H5 首页异常 HTTP $root_status"
fi

printf '== 真实浏览器（agent-browser，仅本地回环）==\n'
AB_SESSION="ccmax-image-smoke-$$"
ab() { agent-browser --session "$AB_SESSION" "$@"; }

browser_opened=0
if ab open "${BASE_URL}/" > /tmp/ab-open.log 2>&1; then
  ok "agent-browser open 成功"
  browser_opened=1
else
  fail "agent-browser open 失败（浏览器可能未被镜像内 agent-browser 发现）"
  tail -n 30 /tmp/ab-open.log 2>/dev/null || true
fi

if [ "$browser_opened" = "1" ]; then
  if ab snapshot > /tmp/ab-snapshot.txt 2>/tmp/ab-snapshot.err && [ -s /tmp/ab-snapshot.txt ]; then
    ok "agent-browser snapshot 成功（$(wc -l < /tmp/ab-snapshot.txt | tr -d ' ') 行）"
  else
    fail "agent-browser snapshot 失败"
    tail -n 20 /tmp/ab-snapshot.err 2>/dev/null || true
  fi
  if ab screenshot /tmp/ab-page.png > /dev/null 2>/tmp/ab-screenshot.err && [ -s /tmp/ab-page.png ]; then
    ok "agent-browser screenshot 成功（$(wc -c < /tmp/ab-page.png | tr -d ' ') 字节）"
  else
    fail "agent-browser screenshot 失败"
    tail -n 20 /tmp/ab-screenshot.err 2>/dev/null || true
  fi
fi
ab close > /dev/null 2>&1 || true

printf '== 结果 ==\n'
if [ "$failures" -eq 0 ]; then
  printf 'SMOKE_OK\n'
else
  printf 'SMOKE_FAILURES=%s\n' "$failures"
  exit 1
fi
INNER

chmod 0755 "$SMOKE_SCRIPT"

info "在隔离临时容器中运行镜像冒烟: ${IMAGE_ID}"
info "容器：--network none，/config 与 /workspace 为 uid=1000,gid=1000 的 tmpfs，不挂载用户目录。"
# --tmpfs 让容器内的挂载点由 UID 1000 拥有，避免宿主目录属主不匹配导致的假失败。
# 只读挂载冒烟脚本本身；不挂载 Docker socket，不使用 --privileged。
set +e
docker run --rm \
  --network none \
  --user 1000:1000 \
  --workdir /workspace \
  --tmpfs "/config:uid=1000,gid=1000,mode=0755" \
  --tmpfs "/workspace:uid=1000,gid=1000,mode=0755" \
  --mount "type=bind,source=${SMOKE_SCRIPT},target=/tmp/smoke.sh,readonly" \
  --entrypoint bash \
  "$IMAGE_ID" /tmp/smoke.sh
smoke_status=$?
set -e

if [ "$smoke_status" -ne 0 ]; then
  # 不用 die：die 会固定改成退出码 1，这里要保留容器真实失败码。
  warn "镜像冒烟失败，退出码 ${smoke_status}"
  exit "$smoke_status"
fi

info "镜像冒烟通过（镜像 ID ${IMAGE_ID}，revision ${IMAGE_REVISION:-unknown}）"
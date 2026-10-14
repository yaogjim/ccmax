#!/usr/bin/env bash
#
# ccmax 产品镜像构建。
#
# 只负责本地构建：默认用 Buildx 构建 linux/amd64 并 --load 到本地镜像库。
# 不推送、不上传、不连接任何服务器，也不启动或更新容器。
#
# 本机 endpoint：任何 Docker 调用之前只读 docker context 元数据，只接受本机
# unix:/// 绝对 socket；DOCKER_HOST、DOCKER_CONTEXT 或当前 current context 指向
# 远端 daemon 时直接拒绝（bind mount 与镜像身份都是本机语义）。
#
# 版本来源：desktop/package.json 的 version（产品版本，当前 1.1.0）。
# 不再使用 `git describe` —— 仓库历史 tag（如 v0.11.3）是上游历史，与产品版本无关，
# 拿它当镜像版本会给出误导性的标签。
#
# --no-load：只构建到构建缓存，不做 --load。此模式下本地标签可能仍指向旧镜像，
# 因此脚本绝不 `docker image inspect` 该标签；构建产物身份只取 buildx --metadata-file。
#
# 退出码：0 成功；1 参数/校验/构建失败。
#
# 用法: deploy/build.sh [选项]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
. "${SCRIPT_DIR}/scripts/common.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKERFILE_REL="deploy/Dockerfile"
VERSION_SOURCE_REL="desktop/package.json"
INVENTORY_IMAGE_PATH="/app/deploy/image-inventory.json"

IMAGE_NAME="ccmax-server-h5"
PLATFORM="linux/amd64"
OUT_DIR=""
AGENT_BROWSER_VERSION="0.39.0"
NODE_MAJOR="24"
BUN_IMAGE="oven/bun:1.3.14"
DEBIAN_IMAGE="debian:bookworm-slim"
EXPLICIT_TAG=""
DO_LOAD="1"
ALLOW_DIRTY="0"
DRY_RUN="0"
RESOLVE_BASE_DIGESTS="1"

usage() {
  cat <<'EOF'
用法: deploy/build.sh [选项]

构建 ccmax 产品镜像（默认 linux/amd64，构建后加载到本地镜像库）。
只做本地构建，不推送、不上传、不操作任何容器。

本机 endpoint：在调用 Docker 之前只读 docker context 元数据，只接受本机
unix:/// 绝对 socket；DOCKER_HOST / DOCKER_CONTEXT / 当前 context 指向远端时拒绝。
--dry-run 不调用 Docker（不写文件），此时无法验证非默认 DOCKER_CONTEXT，会直接拒绝。

版本取自 desktop/package.json（产品版本），不使用 git describe。

选项:
  --tag TAG                    显式镜像标签；默认 <镜像名>:<产品版本>-<短提交>
  --image-name NAME            镜像名（默认 ccmax-server-h5）
  --platform PLATFORM          目标平台（默认 linux/amd64）
  --out DIR                    构建信息输出目录（默认 artifacts/deploy）
  --agent-browser-ver V        agent-browser 精确版本（默认 0.39.0）
  --node-major N               Node 主版本（默认 24；必须 >= 24）
  --bun-image IMAGE            Bun 基础镜像（默认 oven/bun:1.3.14）
  --debian-image IMAGE         Debian 基础镜像（默认 debian:bookworm-slim）
  --no-load                    不执行 --load，只构建到构建缓存；不 inspect 本地标签
  --no-resolve-base-digests    不尝试解析基础镜像 digest（离线时使用）
  --allow-dirty                允许工作区存在未提交改动（构建信息会记录 dirty=true）
  --dry-run                    只打印将执行的命令与构建信息，不调用 Docker、不写文件
  -h, --help                   显示本帮助

示例:
  deploy/build.sh
  deploy/build.sh --tag ccmax-server-h5:1.1.0-abcdef0
  deploy/build.sh --no-load --allow-dirty --out ./artifacts/deploy
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) [ "$#" -ge 2 ] || die "--tag 需要参数"; EXPLICIT_TAG="$2"; shift 2 ;;
    --tag=*) EXPLICIT_TAG="${1#--tag=}"; shift ;;
    --image-name) [ "$#" -ge 2 ] || die "--image-name 需要参数"; IMAGE_NAME="$2"; shift 2 ;;
    --image-name=*) IMAGE_NAME="${1#--image-name=}"; shift ;;
    --platform) [ "$#" -ge 2 ] || die "--platform 需要参数"; PLATFORM="$2"; shift 2 ;;
    --platform=*) PLATFORM="${1#--platform=}"; shift ;;
    --out) [ "$#" -ge 2 ] || die "--out 需要参数"; OUT_DIR="$2"; shift 2 ;;
    --out=*) OUT_DIR="${1#--out=}"; shift ;;
    --agent-browser-ver) [ "$#" -ge 2 ] || die "--agent-browser-ver 需要参数"; AGENT_BROWSER_VERSION="$2"; shift 2 ;;
    --agent-browser-ver=*) AGENT_BROWSER_VERSION="${1#--agent-browser-ver=}"; shift ;;
    --node-major) [ "$#" -ge 2 ] || die "--node-major 需要参数"; NODE_MAJOR="$2"; shift 2 ;;
    --node-major=*) NODE_MAJOR="${1#--node-major=}"; shift ;;
    --bun-image) [ "$#" -ge 2 ] || die "--bun-image 需要参数"; BUN_IMAGE="$2"; shift 2 ;;
    --bun-image=*) BUN_IMAGE="${1#--bun-image=}"; shift ;;
    --debian-image) [ "$#" -ge 2 ] || die "--debian-image 需要参数"; DEBIAN_IMAGE="$2"; shift 2 ;;
    --debian-image=*) DEBIAN_IMAGE="${1#--debian-image=}"; shift ;;
    --no-load) DO_LOAD="0"; shift ;;
    --no-resolve-base-digests) RESOLVE_BASE_DIGESTS="0"; shift ;;
    --allow-dirty) ALLOW_DIRTY="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知选项: $1（使用 --help 查看用法）" ;;
  esac
done

# ── 参数校验：先于任何 Docker 调用 ──
require_cmd git
validate_exact_version "$AGENT_BROWSER_VERSION"
validate_min_node_major "$NODE_MAJOR" 24
[ -n "$PLATFORM" ] || die "--platform 不能为空"
[ -n "$IMAGE_NAME" ] || die "--image-name 不能为空"
case "$IMAGE_NAME" in
  *[A-Z]*) die "镜像名必须是小写，收到: $IMAGE_NAME" ;;
esac
if [ -n "$EXPLICIT_TAG" ]; then
  reject_floating_image_ref "$EXPLICIT_TAG"
fi

[ -f "${REPO_ROOT}/${DOCKERFILE_REL}" ] || die "找不到 ${DOCKERFILE_REL}"
[ -f "${REPO_ROOT}/package.json" ] || die "找不到 package.json，REPO_ROOT=${REPO_ROOT}"
[ -f "${REPO_ROOT}/${VERSION_SOURCE_REL}" ] || die "找不到产品版本来源 ${VERSION_SOURCE_REL}"

# ── 源码身份 ──
# 必须用 `git -C "$REPO_ROOT"`：脚本可能从仓库外的任意目录被调用，
# 只检查「当前目录」是不是 Git 仓库会误判。
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "仓库根不是 Git 工作区，无法记录源码身份: ${REPO_ROOT}"

DIRTY_REPORT="$(git_dirty_report "$REPO_ROOT")"
if [ -n "$DIRTY_REPORT" ]; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    warn "工作区存在未提交改动；默认拒绝构建以保证镜像身份可追溯。"
    printf '%s\n' "$DIRTY_REPORT" | sed 's/^/    /' >&2
    die "请先提交/清理改动，或显式传入 --allow-dirty（构建信息会记录 dirty=true）"
  fi
  warn "工作区存在未提交改动，已按 --allow-dirty 继续；构建信息会记录 dirty=true。"
  DIRTY="true"
else
  DIRTY="false"
fi

GIT_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_SHORT="$(printf '%s' "$GIT_REVISION" | cut -c1-7)"

# 产品版本只来自 desktop/package.json；绝不使用 git describe 的历史 tag。
VERSION="$(read_package_version "${REPO_ROOT}/${VERSION_SOURCE_REL}")"
[ -n "$VERSION" ] || die "无法从 ${VERSION_SOURCE_REL} 读取 version 字段"
VERSION="$(sanitize_tag_fragment "$VERSION")"
[ -n "$VERSION" ] || die "产品版本规范化后为空，请检查 ${VERSION_SOURCE_REL}"

BUILD_TIME="$(utc_timestamp)"

if [ -n "$EXPLICIT_TAG" ]; then
  IMAGE_REF="$EXPLICIT_TAG"
else
  IMAGE_REF="${IMAGE_NAME}:${VERSION}-${GIT_SHORT}"
fi
reject_floating_image_ref "$IMAGE_REF"

# 后续对上下文的相对路径（deploy/Dockerfile、.）都假定 cwd 是仓库根。
cd "$REPO_ROOT"

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="${REPO_ROOT}/artifacts/deploy"
fi
case "$OUT_DIR" in
  /*) : ;;
  *) OUT_DIR="$(pwd)/${OUT_DIR}" ;;
esac

METADATA_FILE="${OUT_DIR}/buildx-metadata.json"
BUILD_INFO_PATH="${OUT_DIR}/build-info.json"

BUILD_ARGS=(
  --build-arg "BUN_IMAGE=${BUN_IMAGE}"
  --build-arg "DEBIAN_IMAGE=${DEBIAN_IMAGE}"
  --build-arg "NODE_MAJOR=${NODE_MAJOR}"
  --build-arg "AGENT_BROWSER_VERSION=${AGENT_BROWSER_VERSION}"
  --build-arg "CCMAX_VERSION=${VERSION}"
  --build-arg "CCMAX_REVISION=${GIT_REVISION}"
  --build-arg "CCMAX_BUILD_TIME=${BUILD_TIME}"
  --build-arg "CCMAX_DIRTY=${DIRTY}"
)

DOCKER_CMD=(docker buildx build
  --platform "$PLATFORM"
  --file "$DOCKERFILE_REL"
  --tag "$IMAGE_REF"
  --metadata-file "$METADATA_FILE"
  "${BUILD_ARGS[@]}"
)
if [ "$DO_LOAD" = "1" ]; then
  DOCKER_CMD+=(--load)
fi
DOCKER_CMD+=(.)

if [ "$DRY_RUN" = "1" ]; then
  # --dry-run 绝不调用 Docker：这里只做静态 endpoint 校验（不 inspect、不写文件），
  # 已知的远端 DOCKER_HOST 或非默认 DOCKER_CONTEXT 会在打印计划前直接拒绝。
  require_local_docker_endpoint docker static >/dev/null
  info "dry-run：不调用 Docker，不写入任何文件。"
  info "将执行: ${DOCKER_CMD[*]}"
  printf '%s\n' '{'
  printf '  "dryRun": true,\n'
  printf '  "imageRef": %s,\n' "$(json_string "$IMAGE_REF")"
  printf '  "imageName": %s,\n' "$(json_string "$IMAGE_NAME")"
  printf '  "platform": %s,\n' "$(json_string "$PLATFORM")"
  printf '  "productVersion": %s,\n' "$(json_string "$VERSION")"
  printf '  "versionSource": %s,\n' "$(json_string "$VERSION_SOURCE_REL")"
  printf '  "sourceRevision": %s,\n' "$(json_string "$GIT_REVISION")"
  printf '  "shortRevision": %s,\n' "$(json_string "$GIT_SHORT")"
  printf '  "buildTime": %s,\n' "$(json_string "$BUILD_TIME")"
  printf '  "dirty": %s,\n' "$DIRTY"
  printf '  "agentBrowserVersion": %s,\n' "$(json_string "$AGENT_BROWSER_VERSION")"
  printf '  "nodeMajor": %s,\n' "$(json_string "$NODE_MAJOR")"
  printf '  "baseImages": [\n'
  printf '    { "ref": %s, "role": "bun" },\n' "$(json_string "$BUN_IMAGE")"
  printf '    { "ref": %s, "role": "debian" }\n' "$(json_string "$DEBIAN_IMAGE")"
  printf '  ],\n'
  printf '  "load": %s,\n' "$([ "$DO_LOAD" = "1" ] && echo true || echo false)"
  printf '  "metadataFile": %s,\n' "$(json_string "$METADATA_FILE")"
  printf '  "outDir": %s\n' "$(json_string "$OUT_DIR")"
  printf '%s\n' '}'
  exit 0
fi

# ── 实际构建 ──
# daemon 查询之前先确认 endpoint 是本机：远端 daemon 上 bind mount/备份语义不成立。
# Docker 守护进程不可用时给出明确原因，而不是让 buildx 报底层错误。
require_cmd docker
require_local_docker_endpoint docker inspect >/dev/null
if ! docker info >/dev/null 2>&1; then
  die "无法连接 Docker 守护进程；请先确认 Docker/Colima 已启动（本脚本不会自动启动它）"
fi

# 尽力解析基础镜像 digest：先查本地，再用 imagetools 查 registry。
# 失败不回退到构建机信息，只记为 null —— 绝不用构建机版本冒充镜像内容。
resolve_base_digest() {
  local ref="$1" digest=""
  [ "$RESOLVE_BASE_DIGESTS" = "1" ] || return 0
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null | tr -d '\r\n' || true)"
  if [ -z "$digest" ]; then
    digest="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>/dev/null | tr -d '\r\n' || true)"
  fi
  printf '%s' "$digest"
}

BUN_IMAGE_DIGEST="$(resolve_base_digest "$BUN_IMAGE")"
DEBIAN_IMAGE_DIGEST="$(resolve_base_digest "$DEBIAN_IMAGE")"

mkdir -p "$OUT_DIR"
rm -f "$METADATA_FILE"

info "构建 ${IMAGE_REF}（平台 ${PLATFORM}）"
info "执行: ${DOCKER_CMD[*]}"
"${DOCKER_CMD[@]}"

[ -f "$METADATA_FILE" ] || warn "buildx 未生成元数据文件: ${METADATA_FILE}"

# 只有 --load 之后本地标签才确定指向刚构建的镜像，此时才 inspect。
# --no-load 时镜像标签在本地可能仍指向旧镜像，inspect 会给出错误身份，因此禁止。
IMAGE_ID="null"
IMAGE_DIGEST="$(json_flat_string "$METADATA_FILE" 'containerimage.digest')"
IMAGE_REVISION=""
IMAGE_REVISION_SOURCE="build-arg"
REPO_DIGESTS="[]"
IMAGE_LABELS="null"
IMAGE_CREATED="null"
IMAGE_ARCH="null"
IMAGE_OS="null"
TOOL_INVENTORY="null"
TOOL_INVENTORY_NOTE=""

if [ "$DO_LOAD" = "1" ]; then
  IMAGE_ID_RAW="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$IMAGE_ID_RAW" ] || die "构建结束后找不到镜像 ${IMAGE_REF}（--load 应已加载标签）"
  IMAGE_ID="$(json_string "$IMAGE_ID_RAW")"

  REPO_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$REPO_DIGESTS" ] || REPO_DIGESTS="[]"
  IMAGE_LABELS="$(docker image inspect --format '{{json .Config.Labels}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$IMAGE_LABELS" ] || IMAGE_LABELS="null"
  IMAGE_CREATED_RAW="$(docker image inspect --format '{{.Created}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  IMAGE_ARCH_RAW="$(docker image inspect --format '{{.Architecture}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  IMAGE_OS_RAW="$(docker image inspect --format '{{.Os}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
  if [ -n "$IMAGE_CREATED_RAW" ]; then IMAGE_CREATED="$(json_string "$IMAGE_CREATED_RAW")"; fi
  if [ -n "$IMAGE_ARCH_RAW" ]; then IMAGE_ARCH="$(json_string "$IMAGE_ARCH_RAW")"; fi
  if [ -n "$IMAGE_OS_RAW" ]; then IMAGE_OS="$(json_string "$IMAGE_OS_RAW")"; fi

  # 镜像自身的 revision 来自镜像标签：这才是「镜像身份」，与构建机的源码 revision 区分开。
  IMAGE_REVISION="$(printf '%s' "$IMAGE_LABELS" \
    | sed -n 's/.*"org\.opencontainers\.image\.revision":"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -n "$IMAGE_REVISION" ]; then
    IMAGE_REVISION_SOURCE="image-label"
  fi

  # 从镜像内提取工具清单（docker create + cp，不 start、不挂载宿主目录）。
  INVENTORY_TMP="$(mktemp "${TMPDIR:-/tmp}/ccmax-inventory.XXXXXX")"
  SCRATCH_ID="$(docker_scratch_create "$IMAGE_REF")"
  if docker_scratch_copy "$SCRATCH_ID" "$INVENTORY_IMAGE_PATH" "$INVENTORY_TMP"; then
    if [ -s "$INVENTORY_TMP" ]; then
      TOOL_INVENTORY="$(cat "$INVENTORY_TMP")"
      TOOL_INVENTORY_NOTE="image:${INVENTORY_IMAGE_PATH}"
    else
      TOOL_INVENTORY_NOTE="empty:${INVENTORY_IMAGE_PATH}"
    fi
  else
    warn "镜像内缺少 ${INVENTORY_IMAGE_PATH}，无法记录镜像内工具清单。"
    TOOL_INVENTORY_NOTE="missing:${INVENTORY_IMAGE_PATH}"
  fi
  docker_scratch_remove "$SCRATCH_ID" || true
  rm -f "$INVENTORY_TMP"
else
  IMAGE_REVISION="$GIT_REVISION"
  TOOL_INVENTORY_NOTE="not-loaded:--no-load 时无法从镜像读取；请在 deploy/export.sh 的分发包中查看"
fi
[ -n "$IMAGE_REVISION" ] || { IMAGE_REVISION="$GIT_REVISION"; IMAGE_REVISION_SOURCE="build-arg"; }

{
  printf '%s\n' '{'
  printf '  "schemaVersion": 2,\n'
  printf '  "imageRef": %s,\n' "$(json_string "$IMAGE_REF")"
  printf '  "imageName": %s,\n' "$(json_string "$IMAGE_NAME")"
  printf '  "imageId": %s,\n' "$IMAGE_ID"
  printf '  "imageDigest": %s,\n' "$([ -n "$IMAGE_DIGEST" ] && json_string "$IMAGE_DIGEST" || echo null)"
  printf '  "repoDigests": %s,\n' "$REPO_DIGESTS"
  printf '  "labels": %s,\n' "$IMAGE_LABELS"
  printf '  "imageCreated": %s,\n' "$IMAGE_CREATED"
  printf '  "architecture": %s,\n' "$IMAGE_ARCH"
  printf '  "os": %s,\n' "$IMAGE_OS"
  printf '  "platform": %s,\n' "$(json_string "$PLATFORM")"
  printf '  "loaded": %s,\n' "$([ "$DO_LOAD" = "1" ] && echo true || echo false)"
  printf '  "productVersion": %s,\n' "$(json_string "$VERSION")"
  printf '  "versionSource": %s,\n' "$(json_string "$VERSION_SOURCE_REL")"
  printf '  "imageRevision": %s,\n' "$(json_string "$IMAGE_REVISION")"
  printf '  "imageRevisionSource": %s,\n' "$(json_string "$IMAGE_REVISION_SOURCE")"
  printf '  "sourceRevision": %s,\n' "$(json_string "$GIT_REVISION")"
  printf '  "shortRevision": %s,\n' "$(json_string "$GIT_SHORT")"
  printf '  "buildTime": %s,\n' "$(json_string "$BUILD_TIME")"
  printf '  "dirty": %s,\n' "$DIRTY"
  printf '  "agentBrowserVersion": %s,\n' "$(json_string "$AGENT_BROWSER_VERSION")"
  printf '  "nodeMajor": %s,\n' "$(json_string "$NODE_MAJOR")"
  printf '  "baseImages": [\n'
  printf '    { "role": "bun", "ref": %s, "digest": %s },\n' \
    "$(json_string "$BUN_IMAGE")" "$([ -n "$BUN_IMAGE_DIGEST" ] && json_string "$BUN_IMAGE_DIGEST" || echo null)"
  printf '    { "role": "debian", "ref": %s, "digest": %s }\n' \
    "$(json_string "$DEBIAN_IMAGE")" "$([ -n "$DEBIAN_IMAGE_DIGEST" ] && json_string "$DEBIAN_IMAGE_DIGEST" || echo null)"
  printf '  ],\n'
  printf '  "toolInventory": %s,\n' "$TOOL_INVENTORY"
  printf '  "toolInventoryNote": %s,\n' "$(json_string "$TOOL_INVENTORY_NOTE")"
  printf '  "metadataFile": %s,\n' "$(json_string "$METADATA_FILE")"
  printf '  "dockerfile": %s,\n' "$(json_string "$DOCKERFILE_REL")"
  printf '  "dockerBuildCommand": %s\n' "$(json_string "${DOCKER_CMD[*]}")"
  printf '%s\n' '}'
} > "$BUILD_INFO_PATH"

info "镜像 ${IMAGE_REF} 构建完成（loaded=${DO_LOAD}）"
info "构建信息写入 ${BUILD_INFO_PATH}"
#!/usr/bin/env bash
#
# ccmax 产品镜像导出。
#
# 只做本地导出：把一个已存在的镜像保存为压缩包，并从镜像内提取少量产品文件，
# 生成覆盖「镜像归档 + 全部产品文件」的 SHA256 校验和与身份清单。
# 不推送、不上传、不连接任何服务器，也不启动任何容器。
#
# 本机 endpoint：在任何 Docker 调用之前只读 docker context 元数据，只接受本机
# unix:/// 绝对 socket；DOCKER_HOST、DOCKER_CONTEXT 或当前 current context 指向
# 远端 daemon 时直接拒绝（归档与提取都只在本机成立）。
#
# 从镜像内提取的方式被严格限制：
#   - 只用 `docker create` + `docker cp`：容器从不 start，绝不挂载宿主的 config/workspace，
#     因此不会读写用户真实数据；
#   - 只提取固定的产品文件白名单（service.sh、deploy.env.example、README.md、
#     image-smoke.sh、scripts/common.sh 与镜像内生成的 image-inventory.json）；
#   - 清理一律 `docker rm -v`，同时移除匿名卷。
# 这样分发包里带的就是「镜像里那一版脚本」，而不是导出机上可能已被修改的工作区副本。
#
# 镜像身份锁定（TOCTOU）：
#   用户传入的可能是浮动标签。脚本先把标签解析成镜像 ID，之后归档、`docker create`
#   与全部元数据读取都锁定该 ID，避免标签在 inspect 与 save 之间被重新指向时，
#   归档内容与清单描述的不是同一个镜像。清单里同时记录原始 ref 与该 ID。
#
# revision 语义（必须分清，不能混为一谈）：
#   - image.revision     = 构建该镜像时的提交，来自镜像标签 org.opencontainers.image.revision；
#   - exporter.revision  = 执行本次导出的仓库提交。
#   两者可能不同；清单同时记录，便于判断「拿旧镜像配新脚本」这类偏差。
#
# 退出码：0 成功；1 参数/校验/导出失败。
#
# 用法: deploy/export.sh --image REF [选项]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
. "${SCRIPT_DIR}/scripts/common.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 允许从镜像提取的产品文件：`镜像内绝对路径=分发包内相对路径`。
# 这个白名单必须保持「有限且安全」：不提取源码、provider 配置、会话数据或密钥。
PRODUCT_FILES=(
  "/app/deploy/service.sh=deploy/service.sh"
  "/app/deploy/deploy.env.example=deploy/deploy.env.example"
  "/app/deploy/image-smoke.sh=deploy/image-smoke.sh"
  "/app/deploy/scripts/common.sh=deploy/scripts/common.sh"
  "/app/deploy/image-inventory.json=deploy/image-inventory.json"
)
# 可选产品文件：镜像里存在就打包，不存在则在清单里显式记录缺失，不静默忽略。
OPTIONAL_PRODUCT_FILES=(
  "/app/deploy/README.md=deploy/README.md"
)

IMAGE_REF=""
OUT_DIR=""
BUNDLE_NAME=""
ALLOW_DIRTY="0"

usage() {
  cat <<'EOF'
用法: deploy/export.sh --image REF [选项]

把本地已存在的镜像导出为压缩归档，从镜像内提取有限的产品文件，并生成
覆盖归档与产品文件的 SHA256 校验和与身份清单。不会启动容器、不挂载用户目录。

选项:
  --image REF      必需。镜像 ID（sha256:...）或精确标签；拒绝 latest。
  --out DIR        输出目录（默认 artifacts/deploy）
  --name NAME      分包目录名；只允许单层 [A-Za-z0-9._-]，拒绝路径穿越
  --allow-dirty    允许工作区存在未提交改动（清单会记录 exporter.dirty=true）
  -h, --help       显示本帮助

示例:
  deploy/export.sh --image ccmax-server-h5:1.1.0-abcdef0
  deploy/export.sh --image sha256:0123... --out ./artifacts/deploy
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) [ "$#" -ge 2 ] || die "--image 需要参数"; IMAGE_REF="$2"; shift 2 ;;
    --image=*) IMAGE_REF="${1#--image=}"; shift ;;
    --out) [ "$#" -ge 2 ] || die "--out 需要参数"; OUT_DIR="$2"; shift 2 ;;
    --out=*) OUT_DIR="${1#--out=}"; shift ;;
    --name) [ "$#" -ge 2 ] || die "--name 需要参数"; BUNDLE_NAME="$2"; shift 2 ;;
    --name=*) BUNDLE_NAME="${1#--name=}"; shift ;;
    --allow-dirty) ALLOW_DIRTY="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "未知选项: $1（使用 --help 查看用法）" ;;
    *)
      [ -z "$IMAGE_REF" ] || die "镜像引用只能给出一次"
      IMAGE_REF="$1"
      shift
      ;;
  esac
done

# ── 参数校验：先于任何 Docker 调用 ──
[ -n "$IMAGE_REF" ] || die "必须用 --image 显式指定镜像（镜像 ID 或精确标签）"
reject_floating_image_ref "$IMAGE_REF"

require_cmd gzip
require_cmd docker

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="${REPO_ROOT}/artifacts/deploy"
fi
case "$OUT_DIR" in
  /*) : ;;
  *) OUT_DIR="$(pwd)/${OUT_DIR}" ;;
esac

if [ -z "$BUNDLE_NAME" ]; then
  BUNDLE_NAME="$(printf '%s' "$IMAGE_REF" | sed -e 's/^sha256://' -e 's/[^A-Za-z0-9_.-]/-/g' | cut -c1-80)"
fi
# 显式拒绝路径穿越与非法片段；--name 是唯一允许调用方影响目标路径的入口。
assert_safe_bundle_name "$BUNDLE_NAME"

# 逐条校验提取白名单的目标相对路径，任何一条不合法就整体失败。
for entry in "${PRODUCT_FILES[@]}" "${OPTIONAL_PRODUCT_FILES[@]}"; do
  assert_safe_relative_path "产品文件目标路径" "${entry#*=}"
done

BUNDLE_DIR="${OUT_DIR}/${BUNDLE_NAME}"
# 明确拒绝已存在的分包目录，避免把两次导出混在一起。
if [ -e "$BUNDLE_DIR" ]; then
  die "分包目录已存在，拒绝覆盖: ${BUNDLE_DIR}（请先移除或改用 --name）"
fi

exporter_revision="unknown"
exporter_short="unknown"
exporter_dirty="unknown"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  dirty_report="$(git_dirty_report "$REPO_ROOT")"
  if [ -n "$dirty_report" ]; then
    if [ "$ALLOW_DIRTY" != "1" ]; then
      warn "工作区存在未提交改动；默认拒绝导出以保证记录的身份可信。"
      printf '%s\n' "$dirty_report" | sed 's/^/    /' >&2
      die "请先提交/清理改动，或显式传入 --allow-dirty（清单会记录 exporter.dirty=true）"
    fi
    warn "工作区存在未提交改动，已按 --allow-dirty 继续；清单会记录 exporter.dirty=true。"
    exporter_dirty="true"
  else
    exporter_dirty="false"
  fi
  exporter_revision="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  exporter_short="$(printf '%s' "$exporter_revision" | cut -c1-7)"
fi

exported_at="$(utc_timestamp)"

# daemon 查询之前先确认 endpoint 是本机（DOCKER_HOST / DOCKER_CONTEXT / 当前 context）。
require_local_docker_endpoint docker inspect >/dev/null

if ! docker info >/dev/null 2>&1; then
  die "无法连接 Docker 守护进程；请先确认 Docker/Colima 已启动（本脚本不会自动启动它）"
fi

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$IMAGE_ID" ] || die "本地找不到镜像 ${IMAGE_REF}，请先构建或用精确标签指定"
[ "$IMAGE_ID" != "<no value>" ] || die "本地找不到镜像 ${IMAGE_REF}，请先构建或用精确标签指定"

# 标签一旦解析为镜像 ID，后续所有读取、归档与提取都以镜像 ID 为准。
# 否则 tag 可能在 inspect 与 save/create 之间被重新指向别的镜像，
# 造成「归档内容」与「清单元数据」描述的不是同一个镜像（TOCTOU）。
INSPECT_TARGET="$IMAGE_ID"

IMAGE_CREATED="$(docker image inspect --format '{{.Created}}' "$INSPECT_TARGET" 2>/dev/null | tr -d '\r\n' || true)"
IMAGE_ARCH="$(docker image inspect --format '{{.Architecture}}' "$INSPECT_TARGET" 2>/dev/null | tr -d '\r\n' || true)"
IMAGE_OS="$(docker image inspect --format '{{.Os}}' "$INSPECT_TARGET" 2>/dev/null | tr -d '\r\n' || true)"
REPO_DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "$INSPECT_TARGET" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$REPO_DIGESTS" ] || REPO_DIGESTS="[]"
IMAGE_LABELS="$(docker image inspect --format '{{json .Config.Labels}}' "$INSPECT_TARGET" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$IMAGE_LABELS" ] || IMAGE_LABELS="null"

# 镜像身份：revision 来自镜像自身标签，与 exporter_revision 区分开。
IMAGE_REVISION="$(printf '%s' "$IMAGE_LABELS" \
  | sed -n 's/.*"org\.opencontainers\.image\.revision":"\([^"]*\)".*/\1/p' | head -n 1)"
IMAGE_REVISION_SOURCE="image-label"
if [ -z "$IMAGE_REVISION" ]; then
  IMAGE_REVISION="unknown"
  IMAGE_REVISION_SOURCE="missing-label"
fi
IMAGE_VERSION="$(printf '%s' "$IMAGE_LABELS" \
  | sed -n 's/.*"org\.opencontainers\.image\.version":"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$IMAGE_VERSION" ]; then
  IMAGE_VERSION="unknown"
fi

mkdir -p "$OUT_DIR"

# 原子导出：全部内容先写进同级的隐藏临时目录，成功后再 mv 到位。
TMP_BUNDLE="$(mktemp -d "${OUT_DIR}/.${BUNDLE_NAME}.tmp.XXXXXX")"
SCRATCH_ID=""

cleanup() {
  local status=$?
  if [ -n "$SCRATCH_ID" ]; then
    docker_scratch_remove "$SCRATCH_ID" || true
    SCRATCH_ID=""
  fi
  if [ -n "${TMP_BUNDLE:-}" ] && [ -d "${TMP_BUNDLE:-}" ]; then
    rm -rf "$TMP_BUNDLE"
  fi
  exit "$status"
}
trap cleanup EXIT

# ── 镜像归档 ──
# 归档目标用固定到镜像 ID 的 INSPECT_TARGET，而不是用户传入的浮动标签。
WORK_TAR="${TMP_BUNDLE}/image.tar"
info "从 ${IMAGE_REF}（${IMAGE_ID}）导出镜像归档"
docker save --output "$WORK_TAR" "$INSPECT_TARGET"
[ -f "$WORK_TAR" ] || die "docker save 未生成归档: $WORK_TAR"

info "压缩镜像归档"
gzip -9 -c "$WORK_TAR" > "${TMP_BUNDLE}/image.tar.gz"
rm -f "$WORK_TAR"
[ -s "${TMP_BUNDLE}/image.tar.gz" ] || die "镜像归档压缩失败"

# ── 从镜像内提取产品文件（不 start、不挂载用户目录）──
SCRATCH_ID="$(docker_scratch_create "$INSPECT_TARGET")"
info "从临时容器 ${SCRATCH_ID} 只读提取产品文件（容器不会启动）"

bundled_entries=""
missing_optional=""
first_bundled="1"
first_missing="1"
sums_lines=""
append_bundled() {
  local bundle_rel="$1" image_source="$2"
  local dest="${TMP_BUNDLE}/${bundle_rel}"
  mkdir -p "$(dirname "$dest")"
  local sha bytes ws_path ws_sha matches
  sha="$(sha256_file "$dest")"
  bytes="$(wc -c < "$dest" | tr -d ' ')"
  ws_path="${REPO_ROOT}/${bundle_rel}"
  if [ -f "$ws_path" ]; then
    ws_sha="$(sha256_file "$ws_path")"
    matches="false"
    if [ "$ws_sha" = "$sha" ]; then matches="true"; fi
  else
    ws_sha=""
    matches="null"
  fi
  [ "$first_bundled" = "1" ] || bundled_entries="${bundled_entries},"$'\n'
  first_bundled="0"
  bundled_entries="${bundled_entries}    {"
  bundled_entries="${bundled_entries}$(printf ' "path": %s,' "$(json_string "$bundle_rel")")"
  bundled_entries="${bundled_entries}$(printf ' "sha256": %s,' "$(json_string "$sha")")"
  bundled_entries="${bundled_entries}$(printf ' "bytes": %s,' "$bytes")"
  bundled_entries="${bundled_entries}$(printf ' "imageSource": %s,' "$(json_string "$image_source")")"
  bundled_entries="${bundled_entries}$(printf ' "workspacePath": %s,' "$(json_string "$bundle_rel")")"
  bundled_entries="${bundled_entries}$(printf ' "workspaceSha256": %s,' "$([ -n "$ws_sha" ] && json_string "$ws_sha" || echo null)")"
  bundled_entries="${bundled_entries}$(printf ' "matchesWorkspace": %s ' "$matches")"
  bundled_entries="${bundled_entries}}"
  [ -z "$sums_lines" ] || sums_lines="${sums_lines}"$'\n'
  sums_lines="${sums_lines}$(printf '%s  %s' "$sha" "$bundle_rel")"
}

for entry in "${PRODUCT_FILES[@]}"; do
  image_source="${entry%%=*}"
  bundle_rel="${entry#*=}"
  dest="${TMP_BUNDLE}/${bundle_rel}"
  mkdir -p "$(dirname "$dest")"
  docker_scratch_copy "$SCRATCH_ID" "$image_source" "$dest" \
    || die "镜像内缺少必需的产品文件: ${image_source}"
  append_bundled "$bundle_rel" "$image_source"
done

for entry in "${OPTIONAL_PRODUCT_FILES[@]}"; do
  image_source="${entry%%=*}"
  bundle_rel="${entry#*=}"
  dest="${TMP_BUNDLE}/${bundle_rel}"
  mkdir -p "$(dirname "$dest")"
  if docker_scratch_copy "$SCRATCH_ID" "$image_source" "$dest"; then
    append_bundled "$bundle_rel" "$image_source"
  else
    warn "镜像内缺少可选产品文件，已在清单中记录缺失: ${image_source}"
    [ "$first_missing" = "1" ] || missing_optional="${missing_optional},"
    first_missing="0"
    missing_optional="${missing_optional}$(json_string "$bundle_rel")"
  fi
done

# ── 校验和：覆盖镜像归档与全部已打包产品文件 ──
ARCHIVE_SHA="$(sha256_file "${TMP_BUNDLE}/image.tar.gz")"
ARCHIVE_BYTES="$(wc -c < "${TMP_BUNDLE}/image.tar.gz" | tr -d ' ')"
{
  printf '%s  %s\n' "$ARCHIVE_SHA" "image.tar.gz"
  [ -z "$sums_lines" ] || printf '%s\n' "$sums_lines"
} > "${TMP_BUNDLE}/SHA256SUMS"

# ── 身份清单 ──
{
  printf '%s\n' '{'
  printf '  "schemaVersion": 2,\n'
  printf '  "exportedAt": %s,\n' "$(json_string "$exported_at")"
  printf '  "image": {\n'
  printf '    "ref": %s,\n' "$(json_string "$IMAGE_REF")"
  printf '    "id": %s,\n' "$(json_string "$IMAGE_ID")"
  printf '    "created": %s,\n' "$(json_string "$IMAGE_CREATED")"
  printf '    "architecture": %s,\n' "$(json_string "$IMAGE_ARCH")"
  printf '    "os": %s,\n' "$(json_string "$IMAGE_OS")"
  printf '    "version": %s,\n' "$(json_string "$IMAGE_VERSION")"
  printf '    "revision": %s,\n' "$(json_string "$IMAGE_REVISION")"
  printf '    "revisionSource": %s,\n' "$(json_string "$IMAGE_REVISION_SOURCE")"
  printf '    "repoDigests": %s,\n' "$REPO_DIGESTS"
  printf '    "labels": %s\n' "$IMAGE_LABELS"
  printf '  },\n'
  printf '  "exporter": {\n'
  printf '    "repository": %s,\n' "$(json_string "ccmax")"
  printf '    "revision": %s,\n' "$(json_string "$exporter_revision")"
  printf '    "shortRevision": %s,\n' "$(json_string "$exporter_short")"
  printf '    "dirty": %s\n' "$exporter_dirty"
  printf '  },\n'
  printf '  "revisionNote": %s,\n' \
    "$(json_string "image.revision 是构建镜像时的提交；exporter.revision 是执行导出的仓库提交，两者可能不同。")"
  printf '  "artifacts": [\n'
  printf '    { "path": %s, "sha256": %s, "bytes": %s }\n' \
    "$(json_string "image.tar.gz")" "$(json_string "$ARCHIVE_SHA")" "$ARCHIVE_BYTES"
  printf '  ],\n'
  printf '  "bundledFiles": [\n'
  printf '%s\n' "$bundled_entries"
  printf '  ],\n'
  printf '  "optionalFilesMissing": [%s],\n' "$missing_optional"
  printf '  "extraction": {\n'
  printf '    "method": %s,\n' "$(json_string "docker create + docker cp（容器从不启动，不挂载宿主 config/workspace）")"
  printf '    "containerCleanup": %s\n' "$(json_string "docker rm -v")"
  printf '  }\n'
  printf '%s\n' '}'
} > "${TMP_BUNDLE}/manifest.json"

# 清单必须是合法 JSON；导出机的 bun 已随仓库提供，用它做一次结构化校验。
if command -v bun >/dev/null 2>&1; then
  CCMAX_MANIFEST_PATH="${TMP_BUNDLE}/manifest.json" \
    bun -e 'JSON.parse(await Bun.file(process.env.CCMAX_MANIFEST_PATH).text())' \
    || die "生成的 manifest.json 不是合法 JSON"
fi

# 原子落地：同一文件系统内 mv 是原子的。
mv "$TMP_BUNDLE" "$BUNDLE_DIR"
TMP_BUNDLE=""

info "导出完成: ${BUNDLE_DIR}/image.tar.gz"
info "SHA256: ${ARCHIVE_SHA}"
info "校验和: ${BUNDLE_DIR}/SHA256SUMS（覆盖镜像归档与全部已打包产品文件）"
info "清单: ${BUNDLE_DIR}/manifest.json"
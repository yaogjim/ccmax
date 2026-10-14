#!/usr/bin/env bash
#
# ccmax Docker 部署脚本共享工具函数。
#
# 仅被 deploy/ 下的构建与导出脚本 source。保持 POSIX 友好的纯 Bash 实现，
# 以便在 macOS 默认的 bash 3.2 上运行，不依赖 GNU 专有命令。
#
# 本文件不读取、不写入任何真实配置；调用方负责把所有输出限制在显式指定的目录内。

# shellcheck shell=bash

# 注意：调用方负责 `set -euo pipefail`。此处不重复设置，避免影响调用方的选项。

DEPLOY_LOG_PREFIX="[deploy]"

info() {
  printf '%s %s\n' "$DEPLOY_LOG_PREFIX" "$*" >&2
}

warn() {
  printf '%s 警告: %s\n' "$DEPLOY_LOG_PREFIX" "$*" >&2
}

# 统一失败出口：所有面向用户的错误都走这里，退出码固定为 1。
die() {
  printf '%s 错误: %s\n' "$DEPLOY_LOG_PREFIX" "$*" >&2
  exit 1
}

# 依赖命令存在性检查。缺少必需命令时立即失败，不做隐式降级。
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令: $1"
}

# 解析脚本自身所在的绝对目录，避免依赖调用方的当前工作目录。
script_dir() {
  local source="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  cd "$(dirname "$source")" >/dev/null 2>&1 && pwd
}

# 把相对路径解析为绝对路径（目录必须已存在）。macOS 没有 readlink -f，因此用 cd。
abspath() {
  local target="$1"
  [ -e "$target" ] || die "路径不存在: $target"
  cd "$target" >/dev/null 2>&1 && pwd
}

# 计算文件的 SHA256。macOS 提供 shasum，Linux 提供 sha256sum，两者都支持。
sha256_file() {
  local file="$1"
  [ -f "$file" ] || die "无法计算校验和，文件不存在: $file"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "需要 sha256sum 或 shasum 来计算校验和"
  fi
}

# 字符串转 JSON 字面量（含首尾双引号）。转义反斜杠、双引号与常见控制字符。
json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

# 生成 UTC 的 ISO-8601 时间戳，作为构建/导出身份的一部分。
utc_timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# 从 package.json 中提取 version 字段。不依赖 node/bun，只用 sed。
read_package_version() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

# 把任意字符串规范化为合法的 Docker 标签片段：仅保留 [A-Za-z0-9_.-]，其余替换为 -。
sanitize_tag_fragment() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-' | sed -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'
}

# 校验 agent-browser 版本必须是精确的三段稳定版本号，禁止 latest/范围/预发布。
validate_exact_version() {
  local value="$1"
  case "$value" in
    *[!0-9.]*|"") die "只接受精确的稳定版本号（形如 0.39.0），收到: ${value:-<空>}" ;;
  esac
  local parts
  parts="$(printf '%s' "$value" | awk -F. '{print NF}')"
  [ "$parts" = "3" ] || die "只接受三段版本号（形如 0.39.0），收到: $value"
  printf '%s' "$value" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || die "只接受三段数字版本号（形如 0.39.0），收到: $value"
}

# 校验 Node 主版本是不低于下限的纯数字：agent-browser 的安装与运行要求 Node 24+，
# 低于下限时镜像会做出「装得上但跑不起来」的假成功产物，因此构建期直接拒绝。
validate_min_node_major() {
  local value="$1" minimum="$2"
  case "$value" in
    *[!0-9]*|"") die "Node 主版本必须是数字，收到: ${value:-<空>}" ;;
  esac
  [ "$value" -ge "$minimum" ] \
    || die "Node 主版本必须 >= ${minimum}（agent-browser 的安装与运行要求），收到: $value"
}

# 拒绝 latest 这类浮动引用。镜像引用必须精确、可追溯。
reject_floating_image_ref() {
  local ref="$1"
  [ -n "$ref" ] || die "镜像引用不能为空"
  case "$ref" in
    latest|*:latest) die "拒绝使用浮动标签 latest，必须显式指定精确标签或镜像 ID: $ref" ;;
  esac
}

# 工作区是否干净（忽略未跟踪文件之外的差异）。输出 porcelain 结果供调用方判断。
git_dirty_report() {
  local repo_root="$1"
  git -C "$repo_root" status --porcelain --untracked-files=all 2>/dev/null || true
}

# 单个路径片段是否安全：非空、不是 . / ..，且只含字母数字与 . _ -。
is_safe_path_segment() {
  case "$1" in
    ""|.|..) return 1 ;;
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

# 分包目录名：只允许单个安全片段，显式拒绝路径穿越与绝对路径。
assert_safe_bundle_name() {
  local value="$1"
  is_safe_path_segment "$value" \
    || die "分包名只允许单层字母、数字、点、下划线与连字符，收到: ${value:-<空>}"
}

# 相对路径白名单校验：逐段检查，拒绝绝对路径、空段、. / ..、反斜杠与非法字符。
# 用于「从镜像内提取产品文件」这类必须精确限定的场景。
assert_safe_relative_path() {
  local label="$1" value="$2"
  [ -n "$value" ] || die "${label}不能为空"
  case "$value" in
    /*) die "${label}必须是相对路径，拒绝绝对路径: $value" ;;
    *'\\'*) die "${label}禁止使用反斜杠: $value" ;;
    *'//'*) die "${label}禁止出现空路径段: $value" ;;
  esac
  local old_ifs="$IFS" segment
  IFS='/'
  for segment in $value; do
    is_safe_path_segment "$segment" \
      || die "${label}含非法路径段 '${segment}': $value"
  done
  IFS="$old_ifs"
}

# 把「相对路径」安全地拼到一个已存在的根目录下，并强制校验拼接结果仍在根内。
# 依赖 assert_safe_relative_path 先挡住穿越，这里再做一次前缀兜底。
safe_join_under() {
  local root="$1" rel="$2"
  assert_safe_relative_path "路径" "$rel"
  printf '%s/%s' "${root%/}" "$rel"
}

# 从「扁平 JSON 对象」里取顶层字符串字段。用于读取 buildx --metadata-file 这类
# 顶层键值结构；不依赖 jq，只用 sed，且只匹配顶层缩进，不会误取嵌套的同名字段。
# 文件不存在或字段缺失时输出空串。
json_flat_string() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p" "$file" \
    | head -n 1
}

# ── 镜像内只读提取 ───────────────────────────────────────────────────────────
# 只用 docker create（绝不 start）+ docker cp，绝不挂载宿主目录、绝不写入用户挂载点。
# 调用方必须成对使用：cid=$(docker_scratch_create IMG) → docker cp ... → docker_scratch_remove "$cid"
docker_scratch_create() {
  local image="$1"
  require_cmd docker
  docker create "$image" /bin/true 2>/dev/null || die "无法从镜像创建临时容器: $image"
}

# 清理临时容器：必须 rm -v（同时移除匿名卷），失败也不让整个流程静默成功。
docker_scratch_remove() {
  local container_id="${1:-}"
  [ -n "$container_id" ] || return 0
  if ! docker rm -v "$container_id" >/dev/null 2>&1; then
    warn "临时容器清理失败（可手动 docker rm -v ${container_id}）：$container_id"
    return 1
  fi
  return 0
}

# 从已创建的临时容器里只读拷贝一个文件，并校验目标确实生成。
docker_scratch_copy() {
  local container_id="$1" source_path="$2" dest_path="$3"
  docker cp "${container_id}:${source_path}" "$dest_path" >/dev/null 2>&1 || return 1
  [ -e "$dest_path" ] || return 1
  return 0
}

# ── Docker endpoint 本机边界 ────────────────────────────────────────────────
# 本目录脚本都按「单一本地宿主机」设计：bind mount 用本机路径，备份 tar 也读本机目录。
# daemon 一旦在远端，这些语义会静默失效。因此在任何 daemon 查询或变更之前，先只读
# docker 客户端 context 元数据，只接受本机 unix socket endpoint。
#
# 只允许 unix:/// 加绝对 socket 路径；tcp / ssh / npipe / http / unix 相对路径等
# 任何其它形式都指向远端或非常规 daemon，一律拒绝。
# 另外：context inspect 成功但 endpoint 为空（或 docker 模板渲染出的 '<no value>'）
# 说明无法确认指向哪个 daemon，也必须拒绝，不能猜成「平台默认本机」。

# 单个 endpoint 字符串是否是本机 unix socket。
is_local_unix_endpoint() {
  case "$1" in
    unix:///*) return 0 ;;
    *) return 1 ;;
  esac
}

# endpoint 输出是否「可确认」：空串与 docker 模板的 '<no value>' 都表示无法确认。
is_confirmable_endpoint() {
  case "$1" in
    ''|'<no value>') return 1 ;;
    *) return 0 ;;
  esac
}

# 读取 docker 客户端 context 元数据中的 docker endpoint Host。
# 这是纯客户端读取：不查询 daemon、不修改任何配置。
#   $1 docker 可执行文件；$2 context 名（为空表示当前 context）
# 成功输出 Host（可能为空或 '<no value>'，调用方必须用 is_confirmable_endpoint 判定）
# 并返回 0；读取失败返回非 0。
docker_context_endpoint_host() {
  local bin="$1" name="$2" current=""
  if [ -n "$name" ]; then
    "$bin" context inspect --format '{{.Endpoints.docker.Host}}' "$name" 2>/dev/null
    return $?
  fi
  # 无参 inspect 读取当前 context；旧客户端不支持时退回「先取名字，再按名 inspect」。
  if "$bin" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null; then
    return 0
  fi
  current="$("$bin" context show 2>/dev/null)" || return 1
  [ -n "$current" ] || return 1
  "$bin" context inspect --format '{{.Endpoints.docker.Host}}' "$current" 2>/dev/null
}

# 解析并校验本机 docker endpoint，成功时把「本机 endpoint 标识」写到 stdout。
#   $1 docker 可执行文件（默认 docker）
#   $2 模式：inspect（默认，允许只读 docker context inspect）
#            static（绝不调用 docker，用于 build --dry-run）
# 校验顺序（任一不满足即 die）：
#   1. DOCKER_HOST 是显式 endpoint 覆盖，必须本机；
#   2. DOCKER_CONTEXT 选中的 context endpoint 也必须本机 —— 即使 DOCKER_HOST 已给出也要
#      检查，否则「本机 DOCKER_HOST + 远端 context 别名」能绕过第 1 步；DOCKER_CONTEXT
#      覆盖默认的 current context；
#   3. 未显式指定 endpoint 时，当前 current context 也可能被切成远端 daemon；读取失败，
#      或返回空 / '<no value>' 这类无法确认的 endpoint 时，一律 fail closed。
# 唯一例外：static 模式绝不调用 docker，因此只在「没有任何显式 endpoint 线索」时按默认
# 本机场景打印占位值（build --dry-run 的调用方忽略该返回值）。
require_local_docker_endpoint() {
  local bin="${1:-docker}" mode="${2:-inspect}"
  local host="${DOCKER_HOST:-}" ctx="${DOCKER_CONTEXT:-}" endpoint="" resolved=""

  if [ -n "$host" ]; then
    is_local_unix_endpoint "$host" \
      || die "只支持本机 Docker endpoint：检测到非本机 DOCKER_HOST=${host}。bind mount 与备份都是本机语义，只允许 unix:/// 绝对 socket。"
    resolved="$host"
  fi

  if [ -n "$ctx" ] && [ "$ctx" != default ]; then
    if [ "$mode" != inspect ] || ! command -v "$bin" >/dev/null 2>&1; then
      die "设置了非默认 DOCKER_CONTEXT=${ctx}，但当前模式不调用 docker，无法用 docker context inspect 确认它指向本机 daemon；拒绝继续（fail closed）。"
    fi
    endpoint="$(docker_context_endpoint_host "$bin" "$ctx")" \
      || die "无法用 docker context inspect 解析 DOCKER_CONTEXT=${ctx} 的本机 endpoint；拒绝继续（fail closed）。"
    is_confirmable_endpoint "$endpoint" \
      || die "DOCKER_CONTEXT=${ctx} 的 endpoint 为空或无值（${endpoint:-<空>}），无法确认它指向本机 daemon；拒绝继续（fail closed）。"
    is_local_unix_endpoint "$endpoint" \
      || die "DOCKER_CONTEXT=${ctx} 指向非本机 endpoint=${endpoint}，只允许 unix:/// 绝对 socket。"
    resolved="$endpoint"
  fi

  if [ -z "$resolved" ] && [ "$mode" = inspect ]; then
    if ! command -v "$bin" >/dev/null 2>&1; then
      die "找不到 docker 客户端（${bin}），无法用 docker context inspect 确认当前 endpoint 为本机；拒绝继续（fail closed）。"
    fi
    endpoint="$(docker_context_endpoint_host "$bin" "")" \
      || die "无法用 docker context inspect 读取当前 docker context；在无法确认 daemon 为本机时拒绝继续（fail closed）。"
    is_confirmable_endpoint "$endpoint" \
      || die "当前 docker context 的 endpoint 为空或无值（${endpoint:-<空>}），无法确认它指向本机 daemon；拒绝继续（fail closed）。"
    is_local_unix_endpoint "$endpoint" \
      || die "当前 docker context 指向非本机 endpoint=${endpoint}，只允许 unix:/// 绝对 socket（请 docker context use default 切回本机）。"
    resolved="$endpoint"
  fi

  printf '%s\n' "${resolved:-unix-default}"
}
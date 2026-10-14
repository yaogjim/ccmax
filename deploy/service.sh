#!/usr/bin/env bash
#
# ccmax Docker 部署生命周期脚本
#
# 该脚本只管理「已存在镜像」的容器生命周期：
#   start    首次创建并启动受管容器（--takeover 时安全接管同名未受管容器）
#   update   用新配置/新镜像替换现有受管容器（先停写、备份、保留旧容器）
#   rollback 回退到上一次 update 保留的旧容器（需显式确认数据兼容）
#   status   只读报告当前实例状态（不修改任何东西）
#   stop     停止容器（保留容器本身，不删除）
#
# 它不负责构建镜像、导出镜像或编写 Dockerfile；镜像由构建流程产出后通过
# CCMAX_IMAGE 指定为精确 tag 或 digest。
#
# 设计约束：
#   * 配置文件使用严格 `KEY=value` 解析，绝不 source / eval 任意 shell
#   * 所有输入校验都发生在任何 docker 变更操作之前（require_image / 挂载读取都属于 preflight）
#   * 不自动创建空的 config / workspace 目录（缺失即失败并提示部署方）
#   * 密钥文件必须是外部文件且 mode 0600；其值永不写入 stdout / stderr / 日志
#   * 备份归档以 umask 077 创建、备份目录以 0700 创建，避免密钥与数据 world-readable
#   * --dry-run 不写任何数据，也不创建、停止、重命名任何容器
#   * 权限检查以容器运行用户（CCMAX_UID/CCMAX_GID）为准，而不是「我是 root 所以能写」
#   * 挂载结构（/config、/workspace 的源目录）绝不静默变更：目录变化必须人工迁移
#   * config/workspace 不接受顶层符号链接（tar 只归档链接本身，备份会看似成功却不可恢复）
#   * 只支持本机 Docker daemon：在任何 daemon 查询或变更前只读 docker context 元数据，
#     DOCKER_HOST / DOCKER_CONTEXT / 当前 current context 指向非本机 endpoint 时明确拒绝
#     （bind mount、权限检查与备份都只在本机成立）
#   * 并发锁按「解析后的真实本机 endpoint」+ 容器名，以及 + 单个数据目录路径组织，
#     不包含配置文件路径；共享任一数据目录的两个实例互斥，context 别名不能绕过
#   * 镜像自身 Dockerfile ENV 定义的键（PATH/NODE_* 等）不计入「部署方缺失的环境变量键」
#
set -euo pipefail

EXIT_OK=0
EXIT_USAGE=2
EXIT_CONFIG=3
EXIT_VALIDATE=4
EXIT_LOCK=5
EXIT_DOCKER=6
EXIT_REFUSE=7
EXIT_HEALTH=8

# docker inspect 使用的固定模板。改动这些字符串需要同步更新 deploy/service.test.ts
# 中的假 docker 实现。
FMT_ID='{{.Id}}'
FMT_IMAGE='{{.Config.Image}}'
FMT_IMAGE_ID='{{.Image}}'
FMT_USER='{{.Config.User}}'
FMT_NETWORK='{{.HostConfig.NetworkMode}}'
FMT_RESTART='{{.HostConfig.RestartPolicy.Name}}'
FMT_INIT='{{if .HostConfig.Init}}true{{else}}false{{end}}'
FMT_RUNNING='{{.State.Running}}'
FMT_HEALTH='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
FMT_LABELS='{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}'
FMT_ENV='{{range .Config.Env}}{{.}}{{"\n"}}{{end}}'
FMT_MOUNTS='{{range .Mounts}}{{.Type}}:{{.Source}}:{{.Destination}}{{"\n"}}{{end}}'

# 受管容器标签名。
LBL_MANAGED='ccmax.deploy.managed'
LBL_SCHEMA='ccmax.deploy.schema'
LBL_CREATED='ccmax.deploy.created'
LBL_IMAGE='ccmax.deploy.image'
LBL_IMAGE_ID='ccmax.deploy.image.id'
LBL_SPEC='ccmax.deploy.spec.fingerprint'
LBL_CONFIG='ccmax.deploy.config.fingerprint'
LBL_SECRETS='ccmax.deploy.secrets.fingerprint'
LBL_ENV_KEYS='ccmax.deploy.env.keys'

# 容器内固定注入、且必须由脚本（而不是部署配置）掌控的环境变量。
# 这些变量决定容器的运行时身份，绝不允许由密钥文件覆盖。
FIXED_ENV_KEYS='HOME CLAUDE_CONFIG_DIR SERVER_HOST SERVER_PORT'
FIXED_ENV_PAIRS='HOME=/workspace CLAUDE_CONFIG_DIR=/config SERVER_HOST=0.0.0.0'

# 密钥文件里禁止出现的键：容器固定运行时变量 + 进程 bootstrap 变量。
# 允许它们会绕过挂载/端口校验，或在容器内注入任意代码路径。
RESERVED_ENV_KEYS='HOME CLAUDE_CONFIG_DIR SERVER_HOST SERVER_PORT PATH NODE_OPTIONS BUN_OPTIONS BUN_INSTALL NODE_ENV CC_HAHA_SKIP_DOTENV CC_HAHA_ROOT CLAUDE_H5_DIST_DIR LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV SHELLOPTS GLOBIGNORE CDPATH IFS PWD'

# 允许出现在部署配置中的键白名单。未知键直接失败，避免拼写错误被静默忽略。
ALLOWED_KEYS='CCMAX_IMAGE CCMAX_CONTAINER_NAME CCMAX_RUNTIME_DIR CCMAX_CONFIG_SUBDIR CCMAX_WORKSPACE_SUBDIR CCMAX_BACKUP_SUBDIR CCMAX_PORT CCMAX_CONTAINER_PORT CCMAX_NETWORK_MODE CCMAX_UID CCMAX_GID CCMAX_RESTART_POLICY CCMAX_STOP_TIMEOUT CCMAX_INIT CCMAX_HEALTH_TIMEOUT CCMAX_HEALTH_INTERVAL CCMAX_SECRETS_FILE CCMAX_NO_NEW_PRIVILEGES CCMAX_DOCKER_BIN CCMAX_LOCK_BASE'

SCRIPT_DIR=$(cd -P "$(dirname "$0")" && pwd -P)

CMD=''
DRY_RUN=0
ACK_DATA=0
TAKEOVER=0
ALLOW_RECONFIGURE=0
CONFIG_FILE=${CCMAX_DEPLOY_CONFIG:-}
STAMP=''
LOCK_HELD=0
DESIRED_IMAGE_ID=''
# 解析后的本机 docker endpoint 标识；由 reject_remote_daemon 在任何 daemon 查询前填入，
# 供并发锁使用（因此 context 别名与同一 socket 的不同拼写都会归一到同一个标识）。
LOCAL_DOCKER_ENDPOINT=''

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
plan() { printf '[dry-run] %s\n' "$*"; }

die() {
  local code=$1
  shift
  err "[错误] $*"
  exit "$code"
}

refuse() {
  local code=$1
  shift
  err "[拒绝] $*"
  exit "$code"
}

usage() {
  cat <<'USAGE'
ccmax Docker 部署生命周期工具

用法:
  deploy/service.sh <命令> [选项]

命令:
  start      首次创建并启动受管容器（已存在受管容器时拒绝，请改用 update）
  update     停止旧容器 -> 完整备份 -> 保留旧容器并创建新容器（失败不自动回滚数据）
  rollback   回退到上一次 update 保留的旧容器（必须 --ack-data-compatible）
  status     只读报告容器/配置/备份/指纹状态（需要可连接的 docker daemon）
  stop       停止容器（保留容器，不删除）

选项:
  -c, --config <路径>        部署配置文件（默认 $CCMAX_DEPLOY_CONFIG 或 $PWD/deploy.env）
  -n, --dry-run              只打印计划，不写数据、不创建/停止/重命名容器
      --takeover             允许 start 接管一个未受管的同名容器（先停写、备份、再替换）
      --allow-reconfigure    update 允许改变用户/网络/端口/环境变量键集合（挂载目录变化永不放开）
      --ack-data-compatible  rollback 必填：人工确认回退后数据兼容
  -h, --help                 显示帮助

退出码: 0 成功 / 2 用法 / 3 配置 / 4 校验 / 5 并发锁 / 6 docker / 7 拒绝 / 8 健康检查

安全语义:
  * 被接管的未受管容器必须先停止（确认 running=false）、完整备份后才 rename，绝不与新容器同时写同一 mount。
  * 挂载结构（/config 与 /workspace 的源目录、挂载类型、挂载目标）不一致时一律拒绝，只能人工迁移。
  * config/workspace 不能是顶层符号链接：tar 会只归档链接本身，备份看似成功却不可恢复。
  * status 在 docker daemon 不可达时返回 docker 错误，不会伪装成 absent。
  * 缺少 HEALTHCHECK 的镜像通过 HTTP /health 明确验证，纯 TCP 连通不算就绪；docker 报告 starting 时继续轮询。
  * 只支持本机 Docker daemon：在任何 daemon 查询前只读 docker context 元数据，DOCKER_HOST、
    DOCKER_CONTEXT 或当前 current context 指向非 unix:/// 绝对 socket 时明确拒绝。
  * --takeover / --allow-reconfigure / --ack-data-compatible 只在对应命令上有效，跨命令使用直接报用法错误。
USAGE
}

# ---------------------------------------------------------------- 通用工具

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    # openssl 是原生实现；macOS 上的 shasum 是 perl 脚本，明显更慢。
    openssl dgst -sha256 | awk '{print $NF}'
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

sha256_file() {
  if [ ! -f "$1" ]; then
    printf 'none\n'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum <"$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 <"$1" | awk '{print $NF}'
  else
    shasum -a 256 <"$1" | cut -d' ' -f1
  fi
}

# 已存在路径的真实绝对路径；不存在时返回失败。
real_path() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

# 可能不存在路径的「真实化」：目录直接解析；文件/不存在路径解析其父目录，再拼上尾段。
real_or_lexical() {
  local target=$1 parent base
  if [ -d "$target" ]; then
    real_path "$target" || printf '%s\n' "$target"
    return 0
  fi
  parent=$(dirname "$target")
  base=$(basename "$target")
  parent=$(real_path "$parent" || printf '%s\n' "$parent")
  printf '%s/%s\n' "${parent%/}" "$base"
}

# 两个路径是否存在包含关系（含相等），按真实路径比较。0 = 重叠。
paths_overlap() {
  local a=$1 b=$2
  case "${a%/}/" in "${b%/}/"*) return 0 ;; esac
  case "${b%/}/" in "${a%/}/"*) return 0 ;; esac
  return 1
}

contains_line() {
  local blob=$1 want=$2 line
  while IFS= read -r line; do
    if [ "$line" = "$want" ]; then
      return 0
    fi
  done < <(printf '%s\n' "$blob")
  return 1
}

nonempty_lines() {
  sed -e '/^[[:space:]]*$/d'
}

stat_owner_mode() {
  if stat -c '%u %g %a' "$1" >/dev/null 2>&1; then
    stat -c '%u %g %a' "$1"
  else
    stat -f '%u %g %Lp' "$1"
  fi
}

# 三位 mode 字符串（去掉前导 0，保证 3 位）。用于权限比较。
mode_triplet() {
  local mode digits
  mode=$(stat_owner_mode "$1" | awk '{print $NF}')
  digits=$mode
  while :; do
    case "$digits" in
      0*) digits=${digits#0} ;;
      *) break ;;
    esac
  done
  while [ "${#digits}" -lt 3 ]; do
    digits="0${digits}"
  done
  printf '%s\n' "$digits"
}

# 目录能否被指定的容器用户读写：按 mode 位判断，而不是以当前用户（可能是 root）试写。
dir_usable_by() {
  local path=$1 want_uid=$2 want_gid=$3
  local out mode digits u g o
  out=$(stat_owner_mode "$path") || return 1
  mode=${out##* }
  digits=${mode: -3}
  u=${digits:0:1}
  g=${digits:1:1}
  o=${digits:2:1}
  local owner group
  owner=$(printf '%s' "$out" | awk '{print $1}')
  group=$(printf '%s' "$out" | awk '{print $2}')
  if [ "$owner" = "$want_uid" ] && [ "$u" = 7 ]; then return 0; fi
  if [ "$group" = "$want_gid" ] && [ "$g" = 7 ]; then return 0; fi
  if [ "$o" = 7 ]; then return 0; fi
  return 1
}

# 拒绝会改变 docker --volume 语义的路径字符（冒号 / 逗号 / 换行）。
# 否则 `--volume "a,b:/config"` 会被 docker 解析成「带选项的挂载」，实际挂载的目录与预期不同。
reject_mount_unsafe_path() {
  local label=$1 value=$2
  case "$value" in
    *:*|*,*|*$'\n'*|*$'\r'*)
      die $EXIT_VALIDATE "$label 不能包含 ':'、',' 或换行（会改变 docker --volume 语义，导致实际挂载目录与预期不同）: $value"
      ;;
  esac
}

# ---------------------------------------------------------------- 配置解析

parse_config() {
  local file=$1 line no=0 key value trimmed
  [ -f "$file" ] || die $EXIT_CONFIG "配置文件不存在: $file"
  [ -r "$file" ] || die $EXIT_CONFIG "配置文件不可读: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    no=$((no + 1))
    line=${line%$'\r'}
    trimmed=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$trimmed" ] && continue
    case "$trimmed" in \#*) continue ;; esac
    case "$trimmed" in
      *'`'*) die $EXIT_CONFIG "第 $no 行包含非法字符（反引号）" ;;
    esac
    case "$trimmed" in
      *=*) ;;
      *) die $EXIT_CONFIG "第 $no 行不是 KEY=value 形式: $trimmed" ;;
    esac
    key=${trimmed%%=*}
    value=${trimmed#*=}
    key=$(printf '%s' "$key" | sed -e 's/[[:space:]]*$//')
    value=$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case "$key" in
      '') die $EXIT_CONFIG "第 $no 行配置键为空" ;;
    esac
    case "$key" in
      *[!A-Z0-9_]*) die $EXIT_CONFIG "第 $no 行配置键非法: $key" ;;
    esac
    case " $ALLOWED_KEYS " in
      *" $key "*) ;;
      *) die $EXIT_CONFIG "第 $no 行是未知配置键: ${key}（白名单之外的键不会被静默忽略）" ;;
    esac
    case "$value" in
      *'$('*) die $EXIT_CONFIG "第 $no 行值包含 \$(" ;;
    esac
    printf -v "$key" '%s' "$value"
  done <"$file"
}

apply_defaults() {
  CCMAX_IMAGE=${CCMAX_IMAGE:-}
  CCMAX_CONTAINER_NAME=${CCMAX_CONTAINER_NAME:-ccmax}
  CCMAX_RUNTIME_DIR=${CCMAX_RUNTIME_DIR:-}
  CCMAX_CONFIG_SUBDIR=${CCMAX_CONFIG_SUBDIR:-config}
  CCMAX_WORKSPACE_SUBDIR=${CCMAX_WORKSPACE_SUBDIR:-workspace}
  CCMAX_BACKUP_SUBDIR=${CCMAX_BACKUP_SUBDIR:-backups}
  CCMAX_PORT=${CCMAX_PORT:-18081}
  CCMAX_CONTAINER_PORT=${CCMAX_CONTAINER_PORT:-18081}
  CCMAX_NETWORK_MODE=${CCMAX_NETWORK_MODE:-bridge}
  CCMAX_UID=${CCMAX_UID:-1000}
  CCMAX_GID=${CCMAX_GID:-1000}
  CCMAX_RESTART_POLICY=${CCMAX_RESTART_POLICY:-unless-stopped}
  CCMAX_STOP_TIMEOUT=${CCMAX_STOP_TIMEOUT:-60}
  CCMAX_INIT=${CCMAX_INIT:-true}
  CCMAX_HEALTH_TIMEOUT=${CCMAX_HEALTH_TIMEOUT:-60}
  CCMAX_HEALTH_INTERVAL=${CCMAX_HEALTH_INTERVAL:-2}
  CCMAX_NO_NEW_PRIVILEGES=${CCMAX_NO_NEW_PRIVILEGES:-true}
  CCMAX_SECRETS_FILE=${CCMAX_SECRETS_FILE:-}
  CCMAX_DOCKER_BIN=${CCMAX_DOCKER_BIN:-docker}
  CCMAX_LOCK_BASE=${CCMAX_LOCK_BASE:-${TMPDIR:-/tmp}}
}

require_numeric() {
  local name=$1 value=$2 min=$3 max=$4
  case "$value" in
    ''|*[!0-9]*) die $EXIT_VALIDATE "$name 必须是数字，当前值: $value" ;;
  esac
  if [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    die $EXIT_VALIDATE "$name 超出范围 $min-${max}，当前值: $value"
  fi
}

validate_image_ref() {
  local img=$1 digest tagpart
  img=$CCMAX_IMAGE
  case "$img" in
    *[!A-Za-z0-9._/:@-]*) die $EXIT_VALIDATE "CCMAX_IMAGE 含非法字符: $img" ;;
  esac
  case "$img" in
    *@*@*) die $EXIT_VALIDATE "CCMAX_IMAGE 含多个 @，非法: $img" ;;
  esac
  case "$img" in
    *@*)
      case "$img" in
        *@sha256:*) digest=${img##*@sha256:} ;;
        *) die $EXIT_VALIDATE "CCMAX_IMAGE 只支持 @sha256:<64hex> digest: $img" ;;
      esac
      case "$digest" in
        ''|*[!0-9a-f]*) die $EXIT_VALIDATE "CCMAX_IMAGE digest 必须是 64 位小写十六进制: $img" ;;
      esac
      [ "${#digest}" -eq 64 ] || die $EXIT_VALIDATE "CCMAX_IMAGE digest 长度必须是 64 位十六进制（当前 ${#digest} 位）: $img"
      ;;
    *)
      # 必须带显式 tag。注意 `registry:5000/repo` 里的冒号是端口而不是 tag，
      # 这类引用会被下面的字符检查（tag 不允许含 '/'）直接拒绝，避免隐式 latest。
      case "$img" in
        *:*) tagpart=${img##*:} ;;
        *) die $EXIT_VALIDATE "CCMAX_IMAGE 必须带精确 tag 或 @sha256 digest（不允许隐式 latest）: $img" ;;
      esac
      case "$tagpart" in
        ''|*[!A-Za-z0-9._-]*)
          die $EXIT_VALIDATE "CCMAX_IMAGE 缺少精确 tag（'${tagpart}' 不是合法 tag；registry:port/repo 形式必须再带 :tag）: $img"
          ;;
      esac
      [ "$tagpart" = 'latest' ] && die $EXIT_VALIDATE "CCMAX_IMAGE 禁止使用 :latest，请指定精确 tag 或 digest: $img"
      ;;
  esac
  return 0
}

validate_static() {
  local subdir_name
  [ -n "$CCMAX_IMAGE" ] || die $EXIT_VALIDATE "CCMAX_IMAGE 未设置；镜像必须显式指定精确 tag 或 digest"
  validate_image_ref "$CCMAX_IMAGE"

  case "$CCMAX_CONTAINER_NAME" in
    ''|*[!A-Za-z0-9_.-]*) die $EXIT_VALIDATE "CCMAX_CONTAINER_NAME 非法: $CCMAX_CONTAINER_NAME" ;;
  esac
  case "$CCMAX_CONTAINER_NAME" in
    [A-Za-z0-9]*) ;;
    *) die $EXIT_VALIDATE "CCMAX_CONTAINER_NAME 必须以字母或数字开头: $CCMAX_CONTAINER_NAME" ;;
  esac

  for subdir_name in "$CCMAX_CONFIG_SUBDIR" "$CCMAX_WORKSPACE_SUBDIR" "$CCMAX_BACKUP_SUBDIR"; do
    case "$subdir_name" in
      ''|.|..|*/*) die $EXIT_VALIDATE "子目录名必须是单层相对目录名: $subdir_name" ;;
    esac
    case "$subdir_name" in
      *[!A-Za-z0-9._-]*) die $EXIT_VALIDATE "子目录名含非法字符: $subdir_name" ;;
    esac
  done
  [ "$CCMAX_CONFIG_SUBDIR" != "$CCMAX_WORKSPACE_SUBDIR" ] || die $EXIT_VALIDATE "config 与 workspace 子目录不能相同"
  [ "$CCMAX_BACKUP_SUBDIR" != "$CCMAX_CONFIG_SUBDIR" ] || die $EXIT_VALIDATE "backups 与 config 子目录不能相同"
  [ "$CCMAX_BACKUP_SUBDIR" != "$CCMAX_WORKSPACE_SUBDIR" ] || die $EXIT_VALIDATE "backups 与 workspace 子目录不能相同"

  require_numeric CCMAX_PORT "$CCMAX_PORT" 1 65535
  require_numeric CCMAX_CONTAINER_PORT "$CCMAX_CONTAINER_PORT" 1 65535
  require_numeric CCMAX_UID "$CCMAX_UID" 0 4294967294
  require_numeric CCMAX_GID "$CCMAX_GID" 0 4294967294
  require_numeric CCMAX_STOP_TIMEOUT "$CCMAX_STOP_TIMEOUT" 1 3600
  require_numeric CCMAX_HEALTH_TIMEOUT "$CCMAX_HEALTH_TIMEOUT" 0 3600
  require_numeric CCMAX_HEALTH_INTERVAL "$CCMAX_HEALTH_INTERVAL" 0 60

  case "$CCMAX_NETWORK_MODE" in
    bridge|host) ;;
    *) die $EXIT_VALIDATE "CCMAX_NETWORK_MODE 只支持 bridge 或 host: $CCMAX_NETWORK_MODE" ;;
  esac
  case "$CCMAX_RESTART_POLICY" in
    no|on-failure|always|unless-stopped) ;;
    *) die $EXIT_VALIDATE "CCMAX_RESTART_POLICY 非法: $CCMAX_RESTART_POLICY" ;;
  esac
  case "$CCMAX_INIT" in
    true|false) ;;
    *) die $EXIT_VALIDATE "CCMAX_INIT 只支持 true 或 false: $CCMAX_INIT" ;;
  esac
  case "$CCMAX_NO_NEW_PRIVILEGES" in
    true|false) ;;
    *) die $EXIT_VALIDATE "CCMAX_NO_NEW_PRIVILEGES 只支持 true 或 false: $CCMAX_NO_NEW_PRIVILEGES" ;;
  esac

  # 挂载路径字符校验在任何 docker 调用之前完成。
  reject_mount_unsafe_path CCMAX_RUNTIME_DIR "$CCMAX_RUNTIME_DIR"
}

resolve_paths() {
  local require_dirs=$1 secrets _data_dir
  [ -n "$CCMAX_RUNTIME_DIR" ] || die $EXIT_VALIDATE "CCMAX_RUNTIME_DIR 未设置；绝对运行时目录必须由部署方指定"
  case "$CCMAX_RUNTIME_DIR" in
    /*) ;;
    *) die $EXIT_VALIDATE "CCMAX_RUNTIME_DIR 必须是绝对路径: $CCMAX_RUNTIME_DIR" ;;
  esac
  [ -d "$CCMAX_RUNTIME_DIR" ] || die $EXIT_VALIDATE "运行时目录不存在（本脚本不会自动创建目录）: $CCMAX_RUNTIME_DIR"
  RUNTIME_REAL=$(real_path "$CCMAX_RUNTIME_DIR") || die $EXIT_VALIDATE "无法解析运行时目录: $CCMAX_RUNTIME_DIR"

  CONFIG_PATH="$RUNTIME_REAL/$CCMAX_CONFIG_SUBDIR"
  WORKSPACE_PATH="$RUNTIME_REAL/$CCMAX_WORKSPACE_SUBDIR"
  BACKUP_PATH="$RUNTIME_REAL/$CCMAX_BACKUP_SUBDIR"

  if [ "$require_dirs" = 1 ]; then
    [ -d "$CONFIG_PATH" ] || die $EXIT_VALIDATE "config 目录不存在（需部署方创建并设置属主，脚本不会自动创建空目录）: $CONFIG_PATH"
    [ -d "$WORKSPACE_PATH" ] || die $EXIT_VALIDATE "workspace 目录不存在（需部署方创建并设置属主，脚本不会自动创建空目录）: $WORKSPACE_PATH"
  fi

  # config / workspace 必须是真实目录，不能是符号链接：
  #   * tar -C "$RUNTIME_REAL" config 遇到顶层符号链接时只归档链接本身、不含任何数据，
  #     备份看似成功实际不可恢复；
  #   * 同时也会让挂载源与「目录不变」校验指向不一致的视图。
  for _data_dir in "$CONFIG_PATH" "$WORKSPACE_PATH"; do
    if [ -L "$_data_dir" ]; then
      refuse $EXIT_REFUSE "config/workspace 不能是符号链接（备份 tar 只会归档链接本身、不含真实数据，看似成功却不可恢复）: ${_data_dir} -> $(readlink "$_data_dir" 2>/dev/null || true)"
    fi
  done

  ABS_CONFIG=$(real_or_lexical "$CONFIG_PATH")

  ABS_WORKSPACE=$(real_or_lexical "$WORKSPACE_PATH")
  ABS_BACKUP=$(real_or_lexical "$BACKUP_PATH")

  reject_mount_unsafe_path "config 路径" "$ABS_CONFIG"
  reject_mount_unsafe_path "workspace 路径" "$ABS_WORKSPACE"
  reject_mount_unsafe_path "备份路径" "$ABS_BACKUP"

  # 备份目录必须与数据目录分离（按真实路径比较，符号链接也算重叠）。
  if paths_overlap "$ABS_BACKUP" "$ABS_CONFIG"; then
    refuse $EXIT_REFUSE "备份目录与 config 目录重叠（含符号链接实际路径），备份无法保证独立可恢复: $ABS_BACKUP"
  fi
  if paths_overlap "$ABS_BACKUP" "$ABS_WORKSPACE"; then
    refuse $EXIT_REFUSE "备份目录与 workspace 目录重叠（含符号链接实际路径），备份无法保证独立可恢复: $ABS_BACKUP"
  fi
  if paths_overlap "$ABS_CONFIG" "$ABS_WORKSPACE"; then
    refuse $EXIT_REFUSE "config 与 workspace 目录重叠（含符号链接实际路径）: $ABS_CONFIG / $ABS_WORKSPACE"
  fi

  SECRETS_REAL=''
  if [ -n "$CCMAX_SECRETS_FILE" ]; then
    case "$CCMAX_SECRETS_FILE" in
      /*) ;;
      *) die $EXIT_VALIDATE "CCMAX_SECRETS_FILE 必须是绝对路径: $CCMAX_SECRETS_FILE" ;;
    esac
    secrets=$CCMAX_SECRETS_FILE
    [ -e "$secrets" ] || die $EXIT_VALIDATE "密钥文件不存在: $secrets"
    [ -f "$secrets" ] || die $EXIT_VALIDATE "密钥文件必须是普通文件: $secrets"
    SECRETS_REAL=$(real_or_lexical "$secrets")
    reject_mount_unsafe_path "密钥文件路径" "$SECRETS_REAL"
    if paths_overlap "$SECRETS_REAL" "$ABS_CONFIG" || paths_overlap "$SECRETS_REAL" "$ABS_WORKSPACE"; then
      refuse $EXIT_REFUSE "密钥文件必须位于 config/workspace 之外，否则会被备份并暴露给容器: $SECRETS_REAL"
    fi
  fi
}

validate_dirs_usable() {
  [ "$1" = 1 ] || return 0
  dir_usable_by "$ABS_CONFIG" "$CCMAX_UID" "$CCMAX_GID" ||
    die $EXIT_VALIDATE "config 目录对容器用户 $CCMAX_UID:$CCMAX_GID 不可读写: ${ABS_CONFIG}（不能只以 root 的 -w 作为判断依据，请调整属主或 mode）"
  dir_usable_by "$ABS_WORKSPACE" "$CCMAX_UID" "$CCMAX_GID" ||
    die $EXIT_VALIDATE "workspace 目录对容器用户 $CCMAX_UID:$CCMAX_GID 不可读写: ${ABS_WORKSPACE}（不能只以 root 的 -w 作为判断依据，请调整属主或 mode）"
}

secrets_mode_ok() {
  local digits
  [ -n "$SECRETS_REAL" ] || return 1
  digits=$(mode_triplet "$SECRETS_REAL")
  [ "$digits" = '600' ]
}

# 密钥文件的严格校验：
#   * mode 必须 0600
#   * 每行必须是 `KEY=value`，KEY 匹配 [A-Za-z_][A-Za-z0-9_]*
#   * 不允许重复 KEY
#   * 不允许覆盖容器固定运行时变量与进程 bootstrap 变量（RESERVED_ENV_KEYS）
#   * 值永不打印
validate_secrets_file() {
  local mode line no=0 key keys='' dup
  [ -n "$SECRETS_REAL" ] || return 0
  mode=$(stat_owner_mode "$SECRETS_REAL" | awk '{print $NF}')
  if ! secrets_mode_ok; then
    die $EXIT_VALIDATE "密钥文件 mode 必须是 0600，当前为 $mode: $SECRETS_REAL"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    no=$((no + 1))
    line=${line%$'\r'}
    line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in
      *=*) ;;
      *) die $EXIT_VALIDATE "密钥文件第 $no 行不是 KEY=value 形式" ;;
    esac
    key=${line%%=*}
    case "$key" in
      [A-Za-z_]*)
        case "$key" in
          *[!A-Za-z0-9_]*) die $EXIT_VALIDATE "密钥文件第 $no 行的键非法（只允许 [A-Za-z_][A-Za-z0-9_]*）: $key" ;;
        esac
        ;;
      *) die $EXIT_VALIDATE "密钥文件第 $no 行的键非法（只允许 [A-Za-z_][A-Za-z0-9_]*）: $key" ;;
    esac
    case " $RESERVED_ENV_KEYS " in
      *" $key "*)
        die $EXIT_VALIDATE "密钥文件第 $no 行试图覆盖容器固定/受控变量 ${key}；这些变量由部署脚本掌控，不能来自密钥文件"
        ;;
    esac
    keys="$keys$key"$'\n'
  done <"$SECRETS_REAL"

  # 注意：这里不用 `| head -n 1`——head 提前关闭管道会让上游收到 SIGPIPE，
  # 在 `set -o pipefail` 下会让整条赋值命令失败。sed 会读完输入，不会触发。
  dup=$(printf '%s' "$keys" | nonempty_lines | LC_ALL=C sort | uniq -d | sed -n '1p')
  [ -z "$dup" ] || die $EXIT_VALIDATE "密钥文件存在重复键: ${dup}（重复键在 docker --env-file 下行为不确定）"
}

secrets_keys() {
  local line key
  [ -n "$SECRETS_REAL" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    key=${line%%=*}
    printf '%s\n' "$key"
  done <"$SECRETS_REAL" | LC_ALL=C sort -u
}

# ---------------------------------------------------------------- 并发锁

# 锁键只包含「身份」信息，绝不包含配置文件路径：
#   * 解析后的真实本机 endpoint（LOCAL_DOCKER_ENDPOINT，由 reject_remote_daemon 填入）——
#     不同 daemon 互不阻塞，同一 daemon 的不同 context 别名 / 不同拼写则命中同一把锁
#   * 容器名 —— 同一实例用不同 -c 文件也会命中同一把锁
#   * config / workspace 真实路径 —— 同一份数据被不同容器名引用时同样互斥

# endpoint 的「归一化标识」：同一个 socket 必须只有一种标识，否则锁键不同，
# 同一份 bind mount 会被两个实例同时操作。只处理已通过本机校验的 unix:/// 形式：
#   unix:///run/docker.sock          -> /run/docker.sock
#   unix:////run//docker.sock/       -> /run/docker.sock
#   unix:///run/./docker.sock        -> /run/docker.sock
#   unix:///run/../run/docker.sock   -> /run/docker.sock
#   unix:///var/run/docker.sock      -> /run/docker.sock（/var/run 是指向 /run 的符号链接时）
# 其余形式（例如没找到 docker 时的 unix-default 占位）原样返回，不做猜测。
canonical_endpoint_id() {
  local raw=$1
  case "$raw" in
    unix:///*) ;;
    *) printf '%s' "$raw"; return 0 ;;
  esac
  (
    local path=${raw#unix://} seg='' out='' dir='' base='' real=''
    # 纯文本归一化：折叠重复斜杠，消掉 . 段与 .. 段（不依赖 path 是否存在）。
    # set -f 关闭 glob，避免 socket 路径里的 * ? [ 被当作模式展开；子 shell 内生效，不外泄。
    set -f
    local IFS='/'
    for seg in $path; do
      case "$seg" in
        ''|.) ;;
        ..) out=${out%/*} ;;
        *) out="$out/$seg" ;;
      esac
    done
    [ -n "$out" ] || out='/'

    # 目录存在时再解析符号链接目录（cd -P），让 /var/run 与 /run 这类别名指向同一把锁。
    # cd 读不到目录（不存在或无权限）时保留上面的文本结果。
    if [ "$out" != '/' ]; then
      dir=${out%/*}
      [ -n "$dir" ] || dir='/'
      base=${out##*/}
      if [ -d "$dir" ] && real=$(cd "$dir" 2>/dev/null && pwd -P) && [ -n "$real" ]; then
        out="${real%/}/$base"
      fi
    fi
    printf '%s' "$out"
  )
}

docker_endpoint_key() {
  printf 'endpoint=%s' "${LOCAL_DOCKER_ENDPOINT:-unix-default}"
}

lock_key() {
  printf 'ccmax-deploy-%s.lock' "$(printf '%s' "$1" | sha256_of | cut -c1-24)"
}

LOCK_DIRS=()

acquire_lock() {
  local endpoint key dir
  if [ "$DRY_RUN" = 1 ]; then
    plan '未获取部署锁（--dry-run 不写任何数据）'
    return 0
  fi
  endpoint=$(docker_endpoint_key)
  # 每把锁只绑定一个资源：
  #   * 容器名 —— 同一实例用不同 -c 文件也会命中同一把锁
  #   * config 真实路径 / workspace 真实路径 —— 同一份数据被不同容器名引用时同样互斥
  # data 锁原先把 config 与 workspace 组合进同一个哈希，导致两个实例只要 config 或
  # workspace 之一不同就互不排斥；拆成两把后，共享任一目录的两个实例都会被拦住。
  for key in "container|${endpoint}|name=${CCMAX_CONTAINER_NAME}" \
    "config|${endpoint}|path=${ABS_CONFIG}" \
    "workspace|${endpoint}|path=${ABS_WORKSPACE}"; do
    dir="${CCMAX_LOCK_BASE%/}/$(lock_key "$key")"
    if ! mkdir "$dir" 2>/dev/null; then
      release_lock
      die $EXIT_LOCK "已有并发部署操作持有锁: ${dir}（如确认为残留锁，请人工确认后删除）"
    fi
    printf '%s\n' "$$" >"$dir/pid" 2>/dev/null || true
    LOCK_DIRS=(${LOCK_DIRS[@]+"${LOCK_DIRS[@]}"} "$dir")
  done
  LOCK_HELD=1
}

release_lock() {
  local dir
  if [ "${#LOCK_DIRS[@]}" -gt 0 ]; then
    for dir in ${LOCK_DIRS[@]+"${LOCK_DIRS[@]}"}; do
      rm -rf "$dir" 2>/dev/null || true
    done
    LOCK_DIRS=()
  fi
  LOCK_HELD=0
}

on_exit() {
  # 必须显式保存并还原退出码：bash 3.2 上 EXIT trap 的返回值会覆盖原退出状态，
  # 那会让「失败必须 exit nonzero」的约定失效。
  local status=$?
  release_lock
  exit "$status"
}

on_signal() {
  err "[ccmax-deploy] 收到 $1，释放锁并退出"
  release_lock
  trap - EXIT
  exit "$2"
}

# ---------------------------------------------------------------- docker 封装

docker_bin() { printf '%s\n' "$CCMAX_DOCKER_BIN"; }

docker_available() {
  command -v "$CCMAX_DOCKER_BIN" >/dev/null 2>&1
}

inspect_field() {
  "$CCMAX_DOCKER_BIN" inspect --format "$2" "$1" 2>/dev/null || true
}

container_exists() {
  "$CCMAX_DOCKER_BIN" inspect --format "$FMT_ID" "$1" >/dev/null 2>&1
}

container_labels() {
  "$CCMAX_DOCKER_BIN" inspect --format "$FMT_LABELS" "$1" 2>/dev/null || true
}

label_value() {
  local name=$1 want=$2 line all
  all=$(container_labels "$name")
  local IFS=$'\n'
  for line in $all; do
    case "$line" in
      "$want"=*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done
  return 1
}

is_managed() {
  [ "$(label_value "$1" "$LBL_MANAGED" || true)" = 'true' ]
}

env_keys_of() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "${line%%=*}"
  done < <("$CCMAX_DOCKER_BIN" inspect --format "$FMT_ENV" "$1" 2>/dev/null || true) | nonempty_lines | LC_ALL=C sort
}

# 只取指定固定键的值（用于 spec 指纹中的 HOME/端口核验），绝不触碰密钥值。
env_value_of() {
  local name=$1 want=$2 line
  while IFS= read -r line; do
    case "$line" in
      "$want"=*) printf '%s\n' "${line#*=}"; return 0 ;;
    esac
  done < <("$CCMAX_DOCKER_BIN" inspect --format "$FMT_ENV" "$name" 2>/dev/null || true)
  return 1
}

fixed_env_of() {
  local name=$1 key
  for key in $FIXED_ENV_KEYS; do
    printf '%s=%s\n' "$key" "$(env_value_of "$name" "$key" || true)"
  done | LC_ALL=C sort
}

mounts_of() {
  { "$CCMAX_DOCKER_BIN" inspect --format "$FMT_MOUNTS" "$1" 2>/dev/null || true; } | nonempty_lines | LC_ALL=C sort
}

# `docker port` 在默认 bridge 网络上会为同一个容器端口分别输出 IPv4（0.0.0.0）
# 与 IPv6（::）两条映射。指纹只关心「容器端口 -> 宿主端口」的集合，因此这里按
# 容器端口去重（保留最小宿主端口，双栈一定相同），否则 desired 单条会被判成漂移。
ports_of() {
  local line cport hspec hport out=''
  while IFS= read -r line; do
    case "$line" in
      *'->'*) ;;
      *) continue ;;
    esac
    cport=${line%%/*}
    hspec=${line##*-> }
    hport=${hspec##*:}
    out="$out
$cport $hport"
  done < <("$CCMAX_DOCKER_BIN" port "$1" 2>/dev/null || true)
  printf '%s\n' "$out" | nonempty_lines | LC_ALL=C sort -u -k1,1 -k2,2n | awk '{print $1":"$2}'
}

# 容器实际映射到的宿主端口（供健康探测使用，rollback 时不能只信 desired config）。
# 与 ports_of 一样按双栈输出去重：IPv4/IPv6 两条映射的宿主端口一定相同。
actual_host_port() {
  local name=$1 line rest
  while IFS= read -r line; do
    case "$line" in
      *'-> '*) rest=${line##*-> }; printf '%s\n' "${rest##*:}"; return 0 ;;
    esac
  done < <("$CCMAX_DOCKER_BIN" port "$name" 2>/dev/null || true)
  printf '\n'
}

# 统一的 spec 指纹算法：desired 与 actual 必须使用同一实现，否则无法做漂移检测。
# 指纹只包含结构性字段、固定环境变量的值（HOME/端口等核验）与受管键名，绝不包含密钥值。
spec_hash_from() {
  local image=$1 user=$2 network=$3 restart=$4 init=$5 mounts=$6 ports=$7 fixed_env=$8
  {
    printf 'image=%s\n' "$image"
    printf 'user=%s\n' "$user"
    printf 'network=%s\n' "$network"
    printf 'restart=%s\n' "$restart"
    printf 'init=%s\n' "$init"
    printf '%s\n' "$mounts"
    printf '%s\n' "$ports"
    printf '%s\n' "$fixed_env"
  } | LC_ALL=C sort | sha256_of
}

config_fingerprint() {
  {
    printf 'image=%s\n' "$CCMAX_IMAGE"
    printf 'container=%s\n' "$CCMAX_CONTAINER_NAME"
    printf 'runtime=%s\n' "$RUNTIME_REAL"
    printf 'config_subdir=%s\n' "$CCMAX_CONFIG_SUBDIR"
    printf 'workspace_subdir=%s\n' "$CCMAX_WORKSPACE_SUBDIR"
    printf 'backup_subdir=%s\n' "$CCMAX_BACKUP_SUBDIR"
    printf 'port=%s\n' "$CCMAX_PORT"
    printf 'container_port=%s\n' "$CCMAX_CONTAINER_PORT"
    printf 'network=%s\n' "$CCMAX_NETWORK_MODE"
    printf 'uid=%s\n' "$CCMAX_UID"
    printf 'gid=%s\n' "$CCMAX_GID"
    printf 'restart=%s\n' "$CCMAX_RESTART_POLICY"
    printf 'stop_timeout=%s\n' "$CCMAX_STOP_TIMEOUT"
    printf 'init=%s\n' "$CCMAX_INIT"
    printf 'health_timeout=%s\n' "$CCMAX_HEALTH_TIMEOUT"
    printf 'health_interval=%s\n' "$CCMAX_HEALTH_INTERVAL"
    printf 'no_new_privileges=%s\n' "$CCMAX_NO_NEW_PRIVILEGES"
  } | LC_ALL=C sort | sha256_of
}

# ---------------------------------------------------------------- spec 构造

# 唯一的容器创建参数构造点：start / update / --dry-run 全部复用，避免重复实现。
build_create_spec() {
  DESIRED_USER="$CCMAX_UID:$CCMAX_GID"
  DESIRED_NETWORK="$CCMAX_NETWORK_MODE"
  DESIRED_RESTART="$CCMAX_RESTART_POLICY"
  DESIRED_INIT="$CCMAX_INIT"

  DESIRED_MOUNTS=$(printf 'bind:%s:/config\nbind:%s:/workspace\n' "$ABS_CONFIG" "$ABS_WORKSPACE" | LC_ALL=C sort)
  # 挂载源目录集合：目录变化必须人工迁移，单独记录便于比对与报错。
  DESIRED_MOUNT_DIRS=$(printf 'config=%s\nworkspace=%s\n' "$ABS_CONFIG" "$ABS_WORKSPACE" | LC_ALL=C sort)

  DESIRED_PORTS=''
  if [ "$DESIRED_NETWORK" != 'host' ]; then
    DESIRED_PORTS="$CCMAX_CONTAINER_PORT:$CCMAX_PORT"
  fi

  BASE_ENV_KEYS=$(printf '%s\n' $FIXED_ENV_KEYS | LC_ALL=C sort)
  DESIRED_ENV_KEYS=$(printf '%s\n%s\n' "$BASE_ENV_KEYS" "$(secrets_keys)" | nonempty_lines | LC_ALL=C sort -u)
  ENV_KEYS_LABEL=$(printf '%s\n' "$DESIRED_ENV_KEYS" | tr '\n' ',' | sed -e 's/,$//')

  # 固定环境变量的具体取值（不是只有键名）：保证 SERVER_PORT/HOME 等被改动时也能被发现。
  DESIRED_FIXED_ENV=$(printf '%s\nSERVER_PORT=%s\n' "$(printf '%s\n' $FIXED_ENV_PAIRS | LC_ALL=C sort)" "$CCMAX_CONTAINER_PORT" | LC_ALL=C sort)

  DESIRED_SPEC_HASH=$(spec_hash_from "$CCMAX_IMAGE" "$DESIRED_USER" "$DESIRED_NETWORK" "$DESIRED_RESTART" "$DESIRED_INIT" "$DESIRED_MOUNTS" "$DESIRED_PORTS" "$DESIRED_FIXED_ENV")
  CONFIG_FP=$(config_fingerprint)
  SECRETS_FP=$(sha256_file "$SECRETS_REAL")
}

build_create_args() {
  CREATE_ARGS=()
  CREATE_ARGS+=(create)
  CREATE_ARGS+=(--name "$CCMAX_CONTAINER_NAME")
  CREATE_ARGS+=(--label "$LBL_MANAGED=true")
  CREATE_ARGS+=(--label "$LBL_SCHEMA=1")
  CREATE_ARGS+=(--label "$LBL_CREATED=$STAMP")
  CREATE_ARGS+=(--label "$LBL_IMAGE=$CCMAX_IMAGE")
  CREATE_ARGS+=(--label "$LBL_IMAGE_ID=$DESIRED_IMAGE_ID")
  CREATE_ARGS+=(--label "$LBL_SPEC=$DESIRED_SPEC_HASH")
  CREATE_ARGS+=(--label "$LBL_CONFIG=$CONFIG_FP")
  CREATE_ARGS+=(--label "$LBL_SECRETS=$SECRETS_FP")
  CREATE_ARGS+=(--label "$LBL_ENV_KEYS=$ENV_KEYS_LABEL")
  CREATE_ARGS+=(--restart "$DESIRED_RESTART")
  CREATE_ARGS+=(--stop-timeout "$CCMAX_STOP_TIMEOUT")
  if [ "$DESIRED_INIT" = 'true' ]; then
    CREATE_ARGS+=(--init)
  fi
  if [ "$CCMAX_NO_NEW_PRIVILEGES" = 'true' ]; then
    CREATE_ARGS+=(--security-opt no-new-privileges)
  fi
  CREATE_ARGS+=(--user "$DESIRED_USER")
  CREATE_ARGS+=(--network "$DESIRED_NETWORK")
  CREATE_ARGS+=(--env "HOME=/workspace")
  CREATE_ARGS+=(--env "CLAUDE_CONFIG_DIR=/config")
  CREATE_ARGS+=(--env "SERVER_HOST=0.0.0.0")
  CREATE_ARGS+=(--env "SERVER_PORT=$CCMAX_CONTAINER_PORT")
  if [ -n "$SECRETS_REAL" ]; then
    # 只把文件路径交给 docker；密钥值不进入命令行、也不会被打印。
    CREATE_ARGS+=(--env-file "$SECRETS_REAL")
  fi
  CREATE_ARGS+=(--volume "$ABS_CONFIG:/config")
  CREATE_ARGS+=(--volume "$ABS_WORKSPACE:/workspace")
  if [ "$DESIRED_NETWORK" != 'host' ]; then
    CREATE_ARGS+=(--publish "$CCMAX_PORT:$CCMAX_CONTAINER_PORT")
  fi
  CREATE_ARGS+=("$CCMAX_IMAGE")
}

# ---------------------------------------------------------------- 状态读取

read_actual_spec() {
  local name=$1
  ACTUAL_ID=$(inspect_field "$name" "$FMT_ID")
  ACTUAL_IMAGE=$(inspect_field "$name" "$FMT_IMAGE")
  ACTUAL_IMAGE_ID=$(inspect_field "$name" "$FMT_IMAGE_ID")
  ACTUAL_USER=$(inspect_field "$name" "$FMT_USER")
  ACTUAL_NETWORK=$(inspect_field "$name" "$FMT_NETWORK")
  ACTUAL_RESTART=$(inspect_field "$name" "$FMT_RESTART")
  ACTUAL_INIT=$(inspect_field "$name" "$FMT_INIT")
  ACTUAL_RUNNING=$(inspect_field "$name" "$FMT_RUNNING")
  ACTUAL_HEALTH=$(inspect_field "$name" "$FMT_HEALTH")
  ACTUAL_MOUNTS=$(mounts_of "$name")
  ACTUAL_PORTS=$(ports_of "$name")
  ACTUAL_ENV_KEYS=$(env_keys_of "$name")
  ACTUAL_FIXED_ENV=$(fixed_env_of "$name")
  ACTUAL_RECORDED_SPEC=$(label_value "$name" "$LBL_SPEC" || true)
  ACTUAL_RECORDED_CONFIG=$(label_value "$name" "$LBL_CONFIG" || true)
  ACTUAL_RECORDED_SECRETS=$(label_value "$name" "$LBL_SECRETS" || true)
  ACTUAL_RECORDED_ENV_KEYS=$(label_value "$name" "$LBL_ENV_KEYS" || true)
  ACTUAL_RECORDED_IMAGE_ID=$(label_value "$name" "$LBL_IMAGE_ID" || true)
  ACTUAL_SPEC_HASH=$(spec_hash_from "$ACTUAL_IMAGE" "$ACTUAL_USER" "$ACTUAL_NETWORK" "$ACTUAL_RESTART" "$ACTUAL_INIT" "$ACTUAL_MOUNTS" "$ACTUAL_PORTS" "$ACTUAL_FIXED_ENV")
}

# 容器是否被脚本之外的人改过：label 记录与实际 inspect 不一致即视为漂移。
detect_drift() {
  DRIFT_NOTES=''
  if [ -z "$ACTUAL_RECORDED_SPEC" ]; then
    DRIFT_NOTES="$DRIFT_NOTES
- 缺少 $LBL_SPEC 标签（可能是旧版本或非受管容器）"
  elif [ "$ACTUAL_RECORDED_SPEC" != "$ACTUAL_SPEC_HASH" ]; then
    DRIFT_NOTES="$DRIFT_NOTES
- spec 指纹不符：记录 ${ACTUAL_RECORDED_SPEC}，实际 $ACTUAL_SPEC_HASH"
  fi

  if [ -n "$ACTUAL_RECORDED_IMAGE_ID" ] && [ -n "$ACTUAL_IMAGE_ID" ] && [ "$ACTUAL_RECORDED_IMAGE_ID" != "$ACTUAL_IMAGE_ID" ]; then
    DRIFT_NOTES="$DRIFT_NOTES
- 容器实际 image ID 与创建记录不一致：记录 ${ACTUAL_RECORDED_IMAGE_ID:0:19}，实际 ${ACTUAL_IMAGE_ID:0:19}"
  fi

  local key
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if contains_line "$ACTUAL_ENV_KEYS" "$key"; then continue; fi
    DRIFT_NOTES="$DRIFT_NOTES
- 记录的环境变量键在容器中不存在: $key"
  done < <(printf '%s\n' "$ACTUAL_RECORDED_ENV_KEYS" | tr ',' '\n' | nonempty_lines | LC_ALL=C sort)

  [ -n "$DRIFT_NOTES" ] && return 0
  return 1
}

# 校验既有容器的挂载结构，拒绝不支持的挂载与目录变化（一律人工迁移，不受任何 flag 绕过）。
validate_actual_mounts() {
  local blob=$1 label=$2 line type source dest found_config='' found_workspace='' rc rw
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    type=${line%%:*}
    dest=${line##*:}
    source=${line#*:}
    source=${source%%:*}
    if [ "$type" != 'bind' ]; then
      refuse $EXIT_REFUSE "$label: 存在不支持的挂载类型 '$type'（脚本只管理 bind 到 /config 与 /workspace，绝不静默丢弃）: $line"
    fi
    case "$dest" in
      /config)
        [ -z "$found_config" ] || refuse $EXIT_REFUSE "$label: /config 挂载重复: $line"
        found_config=$source
        ;;
      /workspace)
        [ -z "$found_workspace" ] || refuse $EXIT_REFUSE "$label: /workspace 挂载重复: $line"
        found_workspace=$source
        ;;
      *)
        refuse $EXIT_REFUSE "$label: 存在脚本未管理的挂载目标 '$dest'（只支持 /config 与 /workspace，绝不静默丢弃）: $line"
        ;;
    esac
  done <<< "$blob"

  [ -n "$found_config" ] || refuse $EXIT_REFUSE "$label: 缺少 /config 挂载"
  [ -n "$found_workspace" ] || refuse $EXIT_REFUSE "$label: 缺少 /workspace 挂载"

  rc=$(real_or_lexical "$found_config")
  rw=$(real_or_lexical "$found_workspace")
  if [ "$rc" != "$ABS_CONFIG" ] || [ "$rw" != "$ABS_WORKSPACE" ]; then
    refuse $EXIT_REFUSE "$label: 挂载目录与当前配置不一致。目录变化会导致新容器读到不同数据，必须人工迁移，不能用任何 flag 绕过。
  当前: config ${found_config} -> 期望 ${ABS_CONFIG}
        workspace ${found_workspace} -> 期望 ${ABS_WORKSPACE}"
  fi
}

# update/takeover 时必须保留下来的内容（用户/网络/端口/环境变量键）。
# 挂载结构不在此列：挂载一律硬性校验（validate_actual_mounts），不允许用 --allow-reconfigure 放开。
# 环境变量键比较忽略镜像自带的默认键（PATH/NODE_* 等）：那些不是部署方配置，
# 不能因此要求部署方在密钥文件里复刻，否则正常镜像也会被误判为需要 --allow-reconfigure。
collect_preserve_changes() {
  PRESERVE_CHANGES=''
  local key
  load_image_default_env_keys
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if contains_line "$DESIRED_ENV_KEYS" "$key"; then continue; fi
    PRESERVE_CHANGES="$PRESERVE_CHANGES
- 新配置缺少环境变量键: ${key}（静默丢弃旧 secret/参数）"
  done < <(provisioned_env_keys_of "$ACTUAL_ENV_KEYS")

  if [ "$ACTUAL_USER" != "$DESIRED_USER" ]; then
    PRESERVE_CHANGES="$PRESERVE_CHANGES
- 运行用户变更: $ACTUAL_USER -> $DESIRED_USER"
  fi
  if [ "$ACTUAL_NETWORK" != "$DESIRED_NETWORK" ]; then
    PRESERVE_CHANGES="$PRESERVE_CHANGES
- 网络模式变更: $ACTUAL_NETWORK -> $DESIRED_NETWORK"
  fi
  if [ "$ACTUAL_PORTS" != "$DESIRED_PORTS" ]; then
    PRESERVE_CHANGES="$PRESERVE_CHANGES
- 端口映射变更: ${ACTUAL_PORTS:-（无）} -> ${DESIRED_PORTS:-（无）}"
  fi

  [ -n "$PRESERVE_CHANGES" ] && return 0
  return 1
}

# 镜像自身 Dockerfile ENV 定义的键集合（例如 PATH / NODE_VERSION / LANG）。
# 这些键由镜像决定、不属于部署方配置，不能要求部署方在密钥文件里复刻一遍。
# 用当前目标镜像的 image config 计算：升级镜像导致默认键集合变化时可被感知。
IMAGE_DEFAULT_ENV_KEYS=''
load_image_default_env_keys() {
  IMAGE_DEFAULT_ENV_KEYS=''
  docker_available || return 0
  IMAGE_DEFAULT_ENV_KEYS=$("$CCMAX_DOCKER_BIN" image inspect --format "$FMT_ENV" "$CCMAX_IMAGE" 2>/dev/null \
    | { while IFS= read -r line; do printf '%s\n' "${line%%=*}"; done; } \
    | nonempty_lines | LC_ALL=C sort -u)
}

# 从「容器实际环境变量键」里剔除镜像默认键，只留下脚本与部署配置共同定义的部分。
# 这样镜像自带 PATH/NODE_* 等不会让 update 误报「新配置缺少环境变量键」。
provisioned_env_keys_of() {
  local blob=$1 key
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    contains_line "$IMAGE_DEFAULT_ENV_KEYS" "$key" && continue
    printf '%s\n' "$key"
  done < <(printf '%s\n' "$blob" | nonempty_lines | LC_ALL=C sort)
}

# ---------------------------------------------------------------- 动作

docker_mutate() {
  if [ "$DRY_RUN" = 1 ]; then
    plan "docker $*"
    return 0
  fi
  log "+ docker $*"
  "$CCMAX_DOCKER_BIN" "$@"
}

# 本脚本面向「单机本地部署」：bind mount、属主/权限检查与备份都是宿主机本地语义。
# 这里在任何 daemon 查询或变更之前只读 docker 客户端 context 元数据（docker context
# inspect），只接受本机 unix socket endpoint。校验顺序（任一不满足即 refuse）：
#   1. DOCKER_HOST 是显式 endpoint 覆盖，必须本机；
#   2. DOCKER_CONTEXT 选中的 context endpoint 也必须本机 —— 即使 DOCKER_HOST 已给出也要
#      检查，否则「本机 DOCKER_HOST + 远端 context 别名」能绕过第 1 步；DOCKER_CONTEXT
#      覆盖默认的 current context；
#   3. 未显式指定 endpoint 时，当前 current context 也可能被切成远端 daemon
#      （docker context use）；读取失败，或返回空 / '<no value>' 这类无法确认的 endpoint
#      时一律 refuse —— 无论是否 --dry-run，因为随后的只读 container/image inspect 也会
#      打到那个未知 daemon 上。
# 唯一例外：完全找不到 docker 客户端、且没有显式非默认 DOCKER_CONTEXT 时，--dry-run 才
# 允许按默认本机场景继续（非 dry-run 会在 require_daemon 处以 docker 错误失败）。

# 单个 endpoint 字符串是否是本机 unix socket（unix:/// 加绝对路径）。
is_local_unix_endpoint() {
  case "$1" in
    unix:///*) return 0 ;;
    *) return 1 ;;
  esac
}

# endpoint 输出是否「可确认」：空串与 docker 模板的 '<no value>' 都表示无法确认。
endpoint_is_confirmable() {
  case "$1" in
    ''|'<no value>') return 1 ;;
    *) return 0 ;;
  esac
}

# 只读客户端 context 元数据：取 context 的 docker endpoint Host。
#   $1 context 名（为空表示当前 context）
# 成功输出 Host（可能为空或 '<no value>'，调用方必须用 endpoint_is_confirmable 判定）
# 并返回 0；读取失败返回非 0。
context_endpoint_host() {
  local name=$1 current
  if [ -n "$name" ]; then
    "$CCMAX_DOCKER_BIN" context inspect --format '{{.Endpoints.docker.Host}}' "$name" 2>/dev/null
    return $?
  fi
  # 无参 inspect 读取当前 context；旧客户端不支持时退回「先取名字，再按名 inspect」。
  if "$CCMAX_DOCKER_BIN" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null; then
    return 0
  fi
  current=$("$CCMAX_DOCKER_BIN" context show 2>/dev/null) || return 1
  [ -n "$current" ] || return 1
  "$CCMAX_DOCKER_BIN" context inspect --format '{{.Endpoints.docker.Host}}' "$current" 2>/dev/null
}

reject_remote_daemon() {
  local host=${DOCKER_HOST:-} ctx=${DOCKER_CONTEXT:-} endpoint resolved=''

  if [ -n "$host" ]; then
    if ! is_local_unix_endpoint "$host"; then
      refuse $EXIT_REFUSE "本脚本只支持本地 Docker daemon（bind mount 必须是本机路径，备份也在本机读取）。检测到非本机 DOCKER_HOST=${host}：只允许 unix:/// 绝对 socket。请在本机执行并取消 DOCKER_HOST/DOCKER_CONTEXT。"
    fi
    resolved=$host
  fi

  if [ -n "$ctx" ] && [ "$ctx" != default ]; then
    if ! docker_available; then
      refuse $EXIT_REFUSE "设置了非默认 DOCKER_CONTEXT=${ctx}，但找不到 docker 客户端（CCMAX_DOCKER_BIN=${CCMAX_DOCKER_BIN}），无法用 docker context inspect 确认它指向本机 daemon；拒绝继续（fail closed）。"
    fi
    if ! endpoint=$(context_endpoint_host "$ctx"); then
      refuse $EXIT_REFUSE "无法用 docker context inspect 解析 DOCKER_CONTEXT=${ctx} 的本机 endpoint；拒绝继续（fail closed）。"
    fi
    if ! endpoint_is_confirmable "$endpoint"; then
      refuse $EXIT_REFUSE "DOCKER_CONTEXT=${ctx} 的 endpoint 为空或无值（${endpoint:-<空>}），无法确认它指向本机 daemon；拒绝继续（fail closed）。"
    fi
    if ! is_local_unix_endpoint "$endpoint"; then
      refuse $EXIT_REFUSE "DOCKER_CONTEXT=${ctx} 指向非本机 endpoint=${endpoint}：只允许 unix:/// 绝对 socket。"
    fi
    resolved=$endpoint
  fi

  if [ -z "$resolved" ] && docker_available; then
    # 只要本机有 docker 客户端，就必须读出「可确认」的 endpoint；解析失败或拿到空 /
    # '<no value>' 都拒绝。这里不区分 --dry-run：--dry-run 仍会做只读的 container/image
    # inspect，打到未知 daemon 上同样越界。
    if ! endpoint=$(context_endpoint_host ''); then
      refuse $EXIT_REFUSE "无法用 docker context inspect 读取当前 docker context；在无法确认 daemon 为本机时拒绝继续（fail closed）。"
    fi
    if ! endpoint_is_confirmable "$endpoint"; then
      refuse $EXIT_REFUSE "当前 docker context 的 endpoint 为空或无值（${endpoint:-<空>}），无法确认它指向本机 daemon；拒绝继续（fail closed）。"
    fi
    if ! is_local_unix_endpoint "$endpoint"; then
      refuse $EXIT_REFUSE "当前 docker context 指向非本机 endpoint=${endpoint}：只允许 unix:/// 绝对 socket（请 docker context use default 切回本机）。"
    fi
    resolved=$endpoint
  fi

  # 走到这里只剩「完全没有 docker 客户端、且没有显式非默认 context」：
  # --dry-run 允许按默认本机场景继续；非 dry-run 会在 require_daemon 处以 docker 错误失败。
  # 锁键用归一化后的 socket 路径：同一 socket 的不同拼写（重复斜杠、./、..、尾斜杠、
  # 符号链接目录）必须命中同一把锁，不同 socket 则必须不同。
  LOCAL_DOCKER_ENDPOINT=$(canonical_endpoint_id "${resolved:-unix-default}")
}

# status 等只读命令也必须能连上 daemon：否则 daemon 不可达会被误报成 absent。
require_daemon() {
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  if ! docker_available; then
    die $EXIT_DOCKER "找不到 docker 命令: $CCMAX_DOCKER_BIN"
  fi
  if ! "$CCMAX_DOCKER_BIN" version >/dev/null 2>&1; then
    die $EXIT_DOCKER "无法连接 Docker daemon（DOCKER_HOST/context 不可达）: 只读的 status 也不会在无 daemon 时报告 absent"
  fi
}

# 解析当前 tag/digest 指向的 image ID（可能不存在）；不打印任何镜像内容。
resolve_image_id() {
  local out
  DESIRED_IMAGE_ID=''
  if ! docker_available; then
    return 1
  fi
  if out=$("$CCMAX_DOCKER_BIN" image inspect --format "$FMT_ID" "$CCMAX_IMAGE" 2>/dev/null); then
    DESIRED_IMAGE_ID=$(printf '%s' "$out" | tr -d '[:space:]')
    [ -n "$DESIRED_IMAGE_ID" ] && return 0
  fi
  DESIRED_IMAGE_ID=''
  return 1
}

require_image() {
  if ! docker_available; then
    if [ "$DRY_RUN" = 1 ]; then
      plan "docker 不可用，跳过镜像检查: $CCMAX_IMAGE"
      return 0
    fi
    die $EXIT_DOCKER "找不到 docker 命令: $CCMAX_DOCKER_BIN"
  fi
  if resolve_image_id; then
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    plan "镜像当前不存在（本脚本不构建镜像）: $CCMAX_IMAGE"
    return 0
  fi
  die $EXIT_DOCKER "目标镜像不存在: ${CCMAX_IMAGE}（本脚本不构建镜像，请先由镜像流程产出精确 tag/digest）"
}

# 缺少 HEALTHCHECK 时用 HTTP /health 明确验证：纯 TCP 连通不代表服务就绪。
# 返回 0 就绪、1 未就绪（可重试）、2 环境缺少探测工具。
http_probe() {
  local port=$1 url rc
  url="http://127.0.0.1:$port/health"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 3 -o /dev/null "$url" >/dev/null 2>&1; then rc=0; else rc=1; fi
    return "$rc"
  fi
  if command -v wget >/dev/null 2>&1; then
    if wget -q -T 3 -O /dev/null "$url" >/dev/null 2>&1; then rc=0; else rc=1; fi
    return "$rc"
  fi
  return 2
}

# 是否存在可用的 HTTP 探测工具（curl 或 wget）。
http_probe_available() {
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1
}

probe_port_for() {
  local name=$1 p
  # network / SERVER_PORT 一律取容器实际值：回滚到旧容器时它可能与当前配置不同，
  # 只看 desired 配置会探测错端口。容器非 host 网络且查不到映射时才回退到配置值。
  if [ "$(inspect_field "$name" "$FMT_NETWORK")" != 'host' ]; then
    p=$(actual_host_port "$name")
    if [ -n "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  else
    p=$(env_value_of "$name" 'SERVER_PORT' || true)
    if [ -n "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  fi
  printf '%s\n' "$CCMAX_PORT"
}

wait_healthy() {
  local name=$1 deadline=$((SECONDS + CCMAX_HEALTH_TIMEOUT)) status running port rc
  # 缺少探测工具时立即失败：重试到超时也只会掩盖「无法验证」这一事实。
  if ! http_probe_available; then
    err "[ccmax-deploy] 环境缺少 curl/wget，无法验证 HTTP /health；纯 TCP 连通不被视为就绪"
    return 1
  fi
  while :; do
    running=$(inspect_field "$name" "$FMT_RUNNING")
    if [ "$running" != 'true' ]; then
      err "[ccmax-deploy] 容器不在运行状态（running=${running:-（空）}），不认为就绪"
      return 1
    fi
    status=$(inspect_field "$name" "$FMT_HEALTH")
    case "$status" in
      healthy)
        log "[ccmax-deploy] 健康检查通过（docker healthcheck: healthy）"
        return 0
        ;;
      unhealthy)
        err "[ccmax-deploy] 容器健康检查为 unhealthy"
        return 1
        ;;
      starting)
        # 健康检查正在首次执行：这是正常中间态，必须继续轮询，
        # 不能因为「还不是 healthy」就立刻判定失败。
        port=''
        ;;
      none)
        port=$(probe_port_for "$name")
        rc=1
        if http_probe "$port"; then
          log "[ccmax-deploy] 镜像未定义 healthcheck，HTTP /health 探测通过（端口 ${port}）"
          return 0
        else
          rc=$?
        fi
        if [ "$rc" = 2 ]; then
          err "[ccmax-deploy] 镜像未定义 HEALTHCHECK，且环境缺少 curl/wget，无法验证 HTTP /health；纯 TCP 连通不被视为就绪"
          return 1
        fi
        ;;
      *)
        err "[ccmax-deploy] 无法解析容器健康状态: ${status:-（空）}"
        return 1
        ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      err "[ccmax-deploy] 等待健康检查超时（${CCMAX_HEALTH_TIMEOUT}s），最后状态: $status"
      return 1
    fi
    sleep "$CCMAX_HEALTH_INTERVAL"
  done
}

wait_healthy_or_plan() {
  if [ "$DRY_RUN" = 1 ]; then
    plan "等待运行状态与健康检查 /health（超时 ${CCMAX_HEALTH_TIMEOUT}s）"
    return 0
  fi
  wait_healthy "$CCMAX_CONTAINER_NAME"
}

report_incident() {
  local reason=$1
  err "[ccmax-deploy] $reason"
  err "[ccmax-deploy] 现场信息（默认不自动回滚：新容器可能已经写入数据）:"
  err "  当前容器: $CCMAX_CONTAINER_NAME (running=$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_RUNNING"), health=$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_HEALTH"))"
  if [ -n "${PREVIOUS_NAME:-}" ]; then
    err "  保留的旧容器: $PREVIOUS_NAME (running=$(inspect_field "$PREVIOUS_NAME" "$FMT_RUNNING"))"
  fi
  if [ -n "${BACKUP_FILE:-}" ]; then
    err "  备份归档: $BACKUP_FILE"
  fi
  if [ -n "${POINTER_FILE:-}" ]; then
    err "  回滚记录: $POINTER_FILE"
  fi
  err "  如确认数据兼容，可用 rollback --ack-data-compatible 回退到旧容器"
}

pointer_file() { printf '%s\n' "$ABS_BACKUP/previous-container"; }
previous_runtime_file() { printf '%s\n' "$ABS_BACKUP/previous-runtime"; }

# 备份前把已存在的回滚指针归档，避免第二次 update 覆盖指针后无法审计旧容器。
archive_existing_pointer() {
  local existing consumed
  existing=$(pointer_file)
  if [ -f "$existing" ]; then
    consumed="$ABS_BACKUP/previous-consumed-$STAMP-$$"
    mv "$existing" "$consumed" 2>/dev/null || true
    log "[ccmax-deploy] 已归档上一份回滚记录: $(basename "$consumed")"
  fi
}

backup_data() {
  local dir_digits
  if [ -e "$ABS_BACKUP" ] || [ -L "$ABS_BACKUP" ]; then
    if [ -L "$ABS_BACKUP" ]; then
      err "[ccmax-deploy] 备份目录是符号链接，拒绝写入（可能指向未预期的位置）: $ABS_BACKUP"
      return 1
    fi
    [ -d "$ABS_BACKUP" ] || return 1
    dir_digits=$(mode_triplet "$ABS_BACKUP")
    if [ "${dir_digits:1}" != '00' ]; then
      err "[ccmax-deploy] 备份目录权限过宽（group/other 可访问，密钥与数据可能泄露）: $ABS_BACKUP mode=${dir_digits}，请先 chmod 700"
      return 1
    fi
  else
    # 备份目录以 umask 077 + mkdir 700 创建：避免 tar 默认 umask 产生 world-readable 归档。
    (umask 077 && mkdir -p "$ABS_BACKUP") || return 1
    chmod 700 "$ABS_BACKUP" 2>/dev/null || true
  fi

  BACKUP_FILE="$ABS_BACKUP/backup-$STAMP.tar.gz"
  if [ -e "$BACKUP_FILE" ]; then
    BACKUP_FILE="$ABS_BACKUP/backup-$STAMP-$$.tar.gz"
  fi
  log "[ccmax-deploy] 备份 $CCMAX_CONFIG_SUBDIR 与 $CCMAX_WORKSPACE_SUBDIR -> $BACKUP_FILE"
  if ! (umask 077 && tar --numeric-owner -czf "$BACKUP_FILE" -C "$RUNTIME_REAL" "$CCMAX_CONFIG_SUBDIR" "$CCMAX_WORKSPACE_SUBDIR"); then
    rm -f "$BACKUP_FILE" 2>/dev/null || true
    return 1
  fi
  if [ ! -s "$BACKUP_FILE" ]; then
    return 1
  fi
  chmod 600 "$BACKUP_FILE" 2>/dev/null || true
  local entries
  entries=$(tar -tzf "$BACKUP_FILE" 2>/dev/null || true)
  # 真实目录在归档里是 "config/"，符号链接是 "config"。顶层链接的归档不含任何数据，
  # 这里只接受目录形式，宁可备份失败也不留下「看似成功却不可恢复」的归档。
  if ! printf '%s\n' "$entries" | grep -q "^$CCMAX_CONFIG_SUBDIR/"; then
    err "[ccmax-deploy] 备份归档缺少 $CCMAX_CONFIG_SUBDIR/ 目录条目（顶层符号链接只会归档链接本身，不含数据）"
    rm -f "$BACKUP_FILE" 2>/dev/null || true
    return 1
  fi
  if ! printf '%s\n' "$entries" | grep -q "^$CCMAX_WORKSPACE_SUBDIR/"; then
    err "[ccmax-deploy] 备份归档缺少 $CCMAX_WORKSPACE_SUBDIR/ 目录条目（顶层符号链接只会归档链接本身，不含数据）"
    rm -f "$BACKUP_FILE" 2>/dev/null || true
    return 1
  fi
  return 0
}

write_pointer() {
  local previous=$1
  POINTER_FILE=$(pointer_file)
  archive_existing_pointer
  # 回滚记录与元数据以 umask 077 写入并显式 chmod 600：它们含有容器名与镜像引用，
  # 不应 world-readable。
  (umask 077
    printf '%s\n' "$previous" >"$POINTER_FILE"
    printf '%s\n' "$RUNTIME_REAL" >"$(previous_runtime_file)"
    cat >"$ABS_BACKUP/last-update.meta" <<META
previous_container=$previous
created=$STAMP
archive=$(basename "${BACKUP_FILE:-未生成}")
image=$CCMAX_IMAGE
image_id=${DESIRED_IMAGE_ID:-}
spec_fingerprint=$DESIRED_SPEC_HASH
config_fingerprint=$CONFIG_FP
secrets_fingerprint=$SECRETS_FP
env_keys=$ENV_KEYS_LABEL
META
  ) || return 1
  chmod 600 "$POINTER_FILE" "$(previous_runtime_file)" "$ABS_BACKUP/last-update.meta" 2>/dev/null || true
  return 0
}

require_dirs_for_command() {
  case "$CMD" in
    start|update|rollback) printf '1\n' ;;
    *) printf '0\n' ;;
  esac
}

require_secrets_for_command() {
  case "$CMD" in
    start|update|rollback) printf '1\n' ;;
    *) printf '0\n' ;;
  esac
}

do_start() {
  local had_existing=0
  if container_exists "$CCMAX_CONTAINER_NAME"; then
    if is_managed "$CCMAX_CONTAINER_NAME"; then
      refuse $EXIT_REFUSE "已存在受管容器 ${CCMAX_CONTAINER_NAME}：请使用 update 或先人工处理，脚本不会覆盖正在运行的实例"
    fi
    if [ "$TAKEOVER" != 1 ]; then
      refuse $EXIT_REFUSE "已存在未受管容器 ${CCMAX_CONTAINER_NAME}：默认拒绝自动接管。请人工确认该容器可处置后，使用 start --takeover（详情见部署 README）"
    fi
    had_existing=1
    TAKEOVER_NAME="${CCMAX_CONTAINER_NAME}__unmanaged__${STAMP}"

    # (1) 只读 preflight：读取既有容器结构并验证兼容性，绝不先动容器。
    read_actual_spec "$CCMAX_CONTAINER_NAME"
    validate_actual_mounts "$ACTUAL_MOUNTS" "接管目标 $CCMAX_CONTAINER_NAME"
    require_image
    build_create_spec
    build_create_args
    if collect_preserve_changes; then
      refuse $EXIT_REFUSE "接管目标与当前配置不兼容，替换会丢失参数/环境变量:$PRESERVE_CHANGES
脚本不会静默丢弃这些内容；请先人工对齐配置或迁移数据后再接管。"
    fi
    log "[ccmax-deploy] --takeover：接管 ${CCMAX_CONTAINER_NAME}（先停写、完整备份，再保留为 ${TAKEOVER_NAME}）"
  else
    require_image
    build_create_spec
    build_create_args
  fi

  if [ "$DRY_RUN" = 1 ]; then
    if [ "$had_existing" = 1 ]; then
      plan "docker stop --time $CCMAX_STOP_TIMEOUT $CCMAX_CONTAINER_NAME"
      plan "校验停写（running=false 才继续）"
      plan "备份归档: $ABS_BACKUP/backup-$STAMP.tar.gz（umask 077，tar --numeric-owner）"
      plan "docker rename $CCMAX_CONTAINER_NAME $TAKEOVER_NAME"
      plan "失败时在新容器启动前恢复 $TAKEOVER_NAME -> $CCMAX_CONTAINER_NAME 并重启旧实例"
    fi
    plan "docker ${CREATE_ARGS[*]}"
    plan "docker start $CCMAX_CONTAINER_NAME"
    plan "等待运行状态与健康检查 /health（超时 ${CCMAX_HEALTH_TIMEOUT}s）"
    return 0
  fi

  if [ "$had_existing" = 1 ]; then
    # (2) 先停旧容器：避免两个 writer 同时挂载同一 mount。
    if ! docker_mutate stop --time "$CCMAX_STOP_TIMEOUT" "$CCMAX_CONTAINER_NAME"; then
      die $EXIT_DOCKER "停止旧容器失败，已中止（现场未改变）"
    fi
    if [ "$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_RUNNING")" != 'false' ]; then
      die $EXIT_DOCKER "旧容器仍在运行，接管中止（现场未改变，未创建新容器）"
    fi
    # (3) 停写状态下备份；备份失败必须恢复旧容器运行。
    if ! backup_data; then
      err "[ccmax-deploy] 备份失败，拒绝继续"
      if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
        err "[ccmax-deploy] 警告：旧容器未能恢复运行，请人工检查 $CCMAX_CONTAINER_NAME"
      fi
      die $EXIT_DOCKER "备份失败：已中止，未重命名、未创建新容器"
    fi
    # (4) 备份成功后才 rename。
    if ! docker_mutate rename "$CCMAX_CONTAINER_NAME" "$TAKEOVER_NAME"; then
      die $EXIT_DOCKER "重命名旧容器失败，已中止（旧容器保持停止，数据完整，备份: ${BACKUP_FILE}）"
    fi
    log "[ccmax-deploy] 旧容器保留为 ${TAKEOVER_NAME}（保留容器，不删除）"
  fi

  # (5) 创建并启动新容器；create 失败时在新容器启动前恢复旧容器。
  if ! docker_mutate "${CREATE_ARGS[@]}"; then
    if [ "$had_existing" = 1 ]; then
      err "[ccmax-deploy] docker create 失败，恢复旧容器名称并尝试重新启动（新容器未启动、数据未改动）"
      if docker_mutate rename "$TAKEOVER_NAME" "$CCMAX_CONTAINER_NAME"; then
        if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
          err "[ccmax-deploy] 警告：旧容器已恢复名称但未能重新启动，请人工检查 $CCMAX_CONTAINER_NAME"
        fi
      else
        err "[ccmax-deploy] 警告：无法恢复旧容器名称，请人工处理: $TAKEOVER_NAME"
      fi
    fi
    die $EXIT_DOCKER "docker create 失败，未启动新容器"
  fi
  if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
    report_incident "新容器启动失败（容器已创建但未运行）"
    exit $EXIT_DOCKER
  fi
  if ! wait_healthy_or_plan; then
    report_incident "新容器健康检查失败"
    exit $EXIT_HEALTH
  fi
  log "[ccmax-deploy] start 完成: $CCMAX_CONTAINER_NAME (image=$CCMAX_IMAGE, port=$CCMAX_PORT)"
}

do_update() {
  if ! container_exists "$CCMAX_CONTAINER_NAME"; then
    refuse $EXIT_REFUSE "不存在容器 ${CCMAX_CONTAINER_NAME}，无法 update；请使用 start 首次部署"
  fi
  if ! is_managed "$CCMAX_CONTAINER_NAME"; then
    refuse $EXIT_REFUSE "容器 $CCMAX_CONTAINER_NAME 不是 ccmax 受管容器（缺少 $LBL_MANAGED 标签）：默认拒绝自动接管，请人工确认后用 start --takeover 处理"
  fi
  require_image
  read_actual_spec "$CCMAX_CONTAINER_NAME"
  validate_actual_mounts "$ACTUAL_MOUNTS" "当前容器 $CCMAX_CONTAINER_NAME"
  build_create_spec
  build_create_args

  if detect_drift; then
    refuse $EXIT_REFUSE "当前实例与受管 label 记录不一致（可能被脚本之外修改）:$DRIFT_NOTES
脚本不提供绕过开关：请人工核对容器后重建（docker rm 后 start），或先人工恢复到记录状态。"
  fi

  if collect_preserve_changes; then
    if [ "$ALLOW_RECONFIGURE" != 1 ]; then
      refuse $EXIT_REFUSE "update 会改变当前实例的用户/网络/端口/环境变量键，默认拒绝以免静默丢失旧参数或 secret:$PRESERVE_CHANGES
如确认要重新配置，请显式传 --allow-reconfigure"
    fi
    log "[ccmax-deploy] --allow-reconfigure：接受以下重新配置:$PRESERVE_CHANGES"
  fi

  if [ "$ACTUAL_IMAGE" != "$CCMAX_IMAGE" ]; then
    log "[ccmax-deploy] 镜像变更: $ACTUAL_IMAGE -> $CCMAX_IMAGE"
  elif [ -n "$ACTUAL_RECORDED_IMAGE_ID" ] && [ -n "$DESIRED_IMAGE_ID" ] && [ "$ACTUAL_RECORDED_IMAGE_ID" != "$DESIRED_IMAGE_ID" ]; then
    log "[ccmax-deploy] 同名 tag $CCMAX_IMAGE 已指向不同 image（tag 漂移）: 记录 ${ACTUAL_RECORDED_IMAGE_ID:0:19} -> 现在 ${DESIRED_IMAGE_ID:0:19}"
  fi
  if [ -n "$ACTUAL_RECORDED_CONFIG" ] && [ "$ACTUAL_RECORDED_CONFIG" != "$CONFIG_FP" ]; then
    log "[ccmax-deploy] 非密钥配置自创建以来已变化（记录 ${ACTUAL_RECORDED_CONFIG:0:12} -> 现在 ${CONFIG_FP:0:12}）"
  fi
  if [ -n "$ACTUAL_RECORDED_SECRETS" ] && [ "$ACTUAL_RECORDED_SECRETS" != "$SECRETS_FP" ]; then
    log "[ccmax-deploy] 密钥文件内容已变化（只比较哈希，不输出值）"
  fi

  PREVIOUS_NAME="${CCMAX_CONTAINER_NAME}__previous__${STAMP}-$$"
  POINTER_FILE=$(pointer_file)

  if [ "$DRY_RUN" = 1 ]; then
    plan "docker stop --time $CCMAX_STOP_TIMEOUT $CCMAX_CONTAINER_NAME"
    plan "校验容器已停止（备份必须建立在停写状态上）"
    plan "备份归档: $ABS_BACKUP/backup-$STAMP.tar.gz（umask 077，tar --numeric-owner）"
    plan "docker rename $CCMAX_CONTAINER_NAME $PREVIOUS_NAME"
    plan "写入回滚记录: $POINTER_FILE"
    plan "docker ${CREATE_ARGS[*]}"
    plan "docker start $CCMAX_CONTAINER_NAME"
    plan "等待运行状态与健康检查 /health（超时 ${CCMAX_HEALTH_TIMEOUT}s）"
    return 0
  fi

  if ! docker_mutate stop --time "$CCMAX_STOP_TIMEOUT" "$CCMAX_CONTAINER_NAME"; then
    die $EXIT_DOCKER "停止旧容器失败，已中止（现场未改变）"
  fi
  if [ "$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_RUNNING")" != 'false' ]; then
    die $EXIT_DOCKER "旧容器仍在运行，备份无法保证一致性，已中止（现场未改变）"
  fi

  if ! backup_data; then
    err "[ccmax-deploy] 备份失败，拒绝继续"
    if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
      err "[ccmax-deploy] 警告：旧容器未能恢复运行，请人工检查 $CCMAX_CONTAINER_NAME"
    fi
    die $EXIT_DOCKER "备份失败：已中止，未创建新容器"
  fi

  if ! docker_mutate rename "$CCMAX_CONTAINER_NAME" "$PREVIOUS_NAME"; then
    die $EXIT_DOCKER "重命名旧容器失败，已中止（旧容器保持停止，数据完整，备份: ${BACKUP_FILE}）"
  fi
  write_pointer "$PREVIOUS_NAME"
  log "[ccmax-deploy] 旧容器保留为 ${PREVIOUS_NAME}（保留容器，不删除）"

  if ! docker_mutate "${CREATE_ARGS[@]}"; then
    err "[ccmax-deploy] docker create 失败，回滚容器名称并恢复旧实例（新容器未启动、未改动数据）"
    if docker_mutate rename "$PREVIOUS_NAME" "$CCMAX_CONTAINER_NAME"; then
      rm -f "$POINTER_FILE" 2>/dev/null || true
      if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
        err "[ccmax-deploy] 警告：旧容器已恢复名称但未能重新启动，请人工检查 $CCMAX_CONTAINER_NAME"
      fi
    else
      err "[ccmax-deploy] 警告：无法恢复旧容器名称，请人工处理: $PREVIOUS_NAME"
    fi
    die $EXIT_DOCKER "docker create 失败（备份: ${BACKUP_FILE}）"
  fi

  if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
    report_incident "新容器启动失败"
    exit $EXIT_DOCKER
  fi
  if ! wait_healthy_or_plan; then
    report_incident "新容器健康检查失败"
    exit $EXIT_HEALTH
  fi
  log "[ccmax-deploy] update 完成: $CCMAX_CONTAINER_NAME (image=$CCMAX_IMAGE, 旧容器 $PREVIOUS_NAME 已保留, 备份 $BACKUP_FILE)"
}

read_pointer() {
  local rec_runtime
  POINTER_FILE=$(pointer_file)
  [ -f "$POINTER_FILE" ] || refuse $EXIT_REFUSE "没有可回滚的记录: ${POINTER_FILE}（缺少该文件说明没有成功保留的旧容器，或指针已被消费）"
  PREVIOUS_NAME=$(head -n 1 "$POINTER_FILE" | tr -d '[:space:]')
  [ -n "$PREVIOUS_NAME" ] || refuse $EXIT_REFUSE "回滚记录为空: $POINTER_FILE"
  case "$PREVIOUS_NAME" in
    *[!A-Za-z0-9_.-]*) refuse $EXIT_REFUSE "回滚记录中的容器名非法: $PREVIOUS_NAME" ;;
  esac
  # 回滚目标必须是本脚本本次运行创建的保留容器：防止指针被改写后启动任意容器。
  case "$PREVIOUS_NAME" in
    "${CCMAX_CONTAINER_NAME}__previous__"*) ;;
    *)
      refuse $EXIT_REFUSE "回滚记录中的容器名不属于受管前缀 ${CCMAX_CONTAINER_NAME}__previous__，拒绝启动任意容器: $PREVIOUS_NAME"
      ;;
  esac
  if [ -f "$(previous_runtime_file)" ]; then
    rec_runtime=$(head -n 1 "$(previous_runtime_file)" | tr -d '[:space:]')
    if [ -n "$rec_runtime" ] && [ "$rec_runtime" != "$RUNTIME_REAL" ]; then
      refuse $EXIT_REFUSE "回滚记录的运行时目录与当前配置不同（记录 ${rec_runtime}，当前 ${RUNTIME_REAL}）：默认拒绝，避免回滚到另一份数据视图"
    fi
  fi
}

consume_pointer() {
  local consumed
  consumed="$ABS_BACKUP/previous-consumed-$STAMP-$$"
  mv "$(pointer_file)" "$consumed" 2>/dev/null || rm -f "$(pointer_file)" 2>/dev/null || true
  rm -f "$(previous_runtime_file)" 2>/dev/null || true
  log "[ccmax-deploy] 回滚记录已消费: $(basename "$consumed")（再次 rollback 将被拒绝）"
}

do_rollback() {
  if [ "$ACK_DATA" != 1 ]; then
    die $EXIT_USAGE "rollback 会改变运行中的数据视图：必须显式传 --ack-data-compatible 确认数据兼容"
  fi
  read_pointer
  container_exists "$PREVIOUS_NAME" || refuse $EXIT_REFUSE "回滚目标容器不存在: $PREVIOUS_NAME"

  # 所有校验都在停止/重命名之前完成：校验失败时当前实例保持原状。
  read_actual_spec "$PREVIOUS_NAME"
  if [ "$ACTUAL_RUNNING" != 'false' ]; then
    refuse $EXIT_REFUSE "回滚目标 $PREVIOUS_NAME 仍在运行，拒绝回滚（避免两个 writer 同时挂载同一数据目录）"
  fi
  validate_actual_mounts "$ACTUAL_MOUNTS" "回滚目标 $PREVIOUS_NAME"
  if detect_drift; then
    refuse $EXIT_REFUSE "回滚目标 $PREVIOUS_NAME 与其 label 指纹不一致，默认拒绝（脚本不提供绕过开关）:$DRIFT_NOTES"
  fi

  HAS_CURRENT=0
  CURRENT_RUNNING='false'
  if container_exists "$CCMAX_CONTAINER_NAME"; then
    if ! is_managed "$CCMAX_CONTAINER_NAME"; then
      refuse $EXIT_REFUSE "当前同名容器 $CCMAX_CONTAINER_NAME 不是受管容器：默认拒绝自动处置"
    fi
    HAS_CURRENT=1
    read_actual_spec "$CCMAX_CONTAINER_NAME"
    validate_actual_mounts "$ACTUAL_MOUNTS" "当前容器 $CCMAX_CONTAINER_NAME"
    if detect_drift; then
      refuse $EXIT_REFUSE "当前实例与受管 label 记录不一致，默认拒绝自动回滚:${DRIFT_NOTES}"
    fi
    CURRENT_RUNNING=$ACTUAL_RUNNING
  fi

  RENAME_CURRENT=''

  if [ "$DRY_RUN" = 1 ]; then
    if [ "$HAS_CURRENT" = 1 ]; then
      plan "docker stop --time $CCMAX_STOP_TIMEOUT ${CCMAX_CONTAINER_NAME}（避免两个实例并发）"
      plan "校验当前容器已停止（running=false）"
      plan "docker rename $CCMAX_CONTAINER_NAME ${CCMAX_CONTAINER_NAME}__rollback-from__$STAMP-$$"
    fi
    plan "docker rename $PREVIOUS_NAME $CCMAX_CONTAINER_NAME"
    plan "docker start $CCMAX_CONTAINER_NAME"
    plan "等待运行状态与健康检查 /health（探测容器实际映射端口）"
    plan "消费回滚记录 $POINTER_FILE"
    plan "不触碰 $ABS_CONFIG 与 ${ABS_WORKSPACE}（脚本不迁移任何数据）"
    return 0
  fi

  if [ "$HAS_CURRENT" = 1 ]; then
    if [ "$CURRENT_RUNNING" = 'true' ]; then
      if ! docker_mutate stop --time "$CCMAX_STOP_TIMEOUT" "$CCMAX_CONTAINER_NAME"; then
        die $EXIT_DOCKER "停止当前容器失败，已中止（未改动任何容器）"
      fi
    fi
    if [ "$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_RUNNING")" != 'false' ]; then
      die $EXIT_DOCKER "当前容器未能停止，拒绝重命名/回滚（现场未改变）"
    fi
    RENAME_CURRENT="${CCMAX_CONTAINER_NAME}__rollback-from__${STAMP}-$$"
    if ! docker_mutate rename "$CCMAX_CONTAINER_NAME" "$RENAME_CURRENT"; then
      die $EXIT_DOCKER "重命名当前容器失败，已中止（回滚目标仍是 ${PREVIOUS_NAME}）"
    fi
    log "[ccmax-deploy] 当前容器保留为 ${RENAME_CURRENT}（已停止，避免两实例并发）"
  fi

  if ! docker_mutate rename "$PREVIOUS_NAME" "$CCMAX_CONTAINER_NAME"; then
    die $EXIT_DOCKER "恢复旧容器名称失败，请人工检查 $PREVIOUS_NAME"
  fi
  if ! docker_mutate start "$CCMAX_CONTAINER_NAME"; then
    report_incident "回滚启动失败"
    exit $EXIT_DOCKER
  fi
  if ! wait_healthy_or_plan; then
    report_incident "回滚后健康检查失败"
    exit $EXIT_HEALTH
  fi
  consume_pointer
  log "[ccmax-deploy] rollback 完成: $CCMAX_CONTAINER_NAME"
  if [ -n "$RENAME_CURRENT" ]; then
    log "[ccmax-deploy] 被替换的容器保留为 ${RENAME_CURRENT}（已停止，未删除）"
  fi
}

do_stop() {
  if ! container_exists "$CCMAX_CONTAINER_NAME"; then
    log "[ccmax-deploy] 容器不存在，无需停止: $CCMAX_CONTAINER_NAME"
    return 0
  fi
  if ! is_managed "$CCMAX_CONTAINER_NAME"; then
    refuse $EXIT_REFUSE "容器 $CCMAX_CONTAINER_NAME 不是受管容器：默认拒绝停止，请人工处理"
  fi
  if ! docker_mutate stop --time "$CCMAX_STOP_TIMEOUT" "$CCMAX_CONTAINER_NAME"; then
    die $EXIT_DOCKER "停止容器失败: $CCMAX_CONTAINER_NAME"
  fi
  if [ "$DRY_RUN" != 1 ]; then
    if [ "$(inspect_field "$CCMAX_CONTAINER_NAME" "$FMT_RUNNING")" != 'false' ]; then
      die $EXIT_DOCKER "容器仍在运行，请人工检查: $CCMAX_CONTAINER_NAME"
    fi
  fi
  log "[ccmax-deploy] stop 完成: ${CCMAX_CONTAINER_NAME}（容器保留，未删除；如需删除请人工执行 docker rm）"
}

do_status() {
  # status 需要 read 实例状态，因此同样需要可连接的 daemon（否则 absent 会被误报成成功）。
  require_daemon
  resolve_image_id || true
  build_create_spec
  load_image_default_env_keys
  log "container=$CCMAX_CONTAINER_NAME"
  log "config_file=$CONFIG_FILE"
  log "runtime_dir=$RUNTIME_REAL"
  log "docker_endpoint=$(docker_endpoint_key)"
  log "config_dir=$ABS_CONFIG exists=$([ -d "$ABS_CONFIG" ] && printf true || printf false)"
  log "workspace_dir=$ABS_WORKSPACE exists=$([ -d "$ABS_WORKSPACE" ] && printf true || printf false)"
  log "backup_dir=$ABS_BACKUP exists=$([ -d "$ABS_BACKUP" ] && printf true || printf false)"
  if [ -n "$SECRETS_REAL" ]; then
    log "secrets_file=$SECRETS_REAL mode_ok=$(secrets_mode_ok && printf true || printf false)"
  else
    log "secrets_file=-"
  fi
  log "desired_image=$CCMAX_IMAGE"
  log "desired_image_id=${DESIRED_IMAGE_ID:-（未解析）}"
  log "desired_port=$CCMAX_PORT"
  log "desired_container_port=$CCMAX_CONTAINER_PORT"
  log "desired_network=$DESIRED_NETWORK"
  log "desired_user=$DESIRED_USER"

  if ! container_exists "$CCMAX_CONTAINER_NAME"; then
    log "exists=false"
    log "state=absent"
  else
    read_actual_spec "$CCMAX_CONTAINER_NAME"
    log "exists=true"
    log "managed=$([ "$(label_value "$CCMAX_CONTAINER_NAME" "$LBL_MANAGED" || true)" = 'true' ] && printf true || printf false)"
    log "id=${ACTUAL_ID:0:12}"
    log "image=$ACTUAL_IMAGE"
    log "image_id=$ACTUAL_IMAGE_ID"
    log "image_id_recorded=${ACTUAL_RECORDED_IMAGE_ID:-（无）}"
    log "image_matches_config=$([ "$ACTUAL_IMAGE" = "$CCMAX_IMAGE" ] && printf true || printf false)"
    log "image_id_drift=$([ -n "$ACTUAL_RECORDED_IMAGE_ID" ] && [ -n "$DESIRED_IMAGE_ID" ] && [ "$ACTUAL_RECORDED_IMAGE_ID" != "$DESIRED_IMAGE_ID" ] && printf true || printf false)"
    log "running=$ACTUAL_RUNNING"
    log "state=$([ "$ACTUAL_RUNNING" = 'true' ] && printf running || printf nonrunning)"
    log "health=$ACTUAL_HEALTH"
    log "user=$ACTUAL_USER"
    log "network=$ACTUAL_NETWORK"
    log "restart=$ACTUAL_RESTART"
    log "mounts=$(printf '%s' "$ACTUAL_MOUNTS" | tr '\n' ' ' | sed -e 's/ $//')"
    log "ports=${ACTUAL_PORTS:-（无）}"
    log "env_key_count=$(printf '%s\n' "$ACTUAL_ENV_KEYS" | nonempty_lines | wc -l | tr -d ' ')"
    log "spec_fingerprint=$ACTUAL_SPEC_HASH"
    log "spec_fingerprint_recorded=${ACTUAL_RECORDED_SPEC:-（无）}"
    if detect_drift; then
      log "drift=true"
      log "drift_notes=$(printf '%s' "$DRIFT_NOTES" | tr '\n' ' ' | sed -e 's/  */ /g')"
    else
      log "drift=false"
    fi
    # 两侧都剔除镜像默认键：Dockerfile 也会声明 HOME/SERVER_* 等脚本固定键，
    # 只剥 actual 会让 provisioned(actual) 变成 desired 的真子集，健康实例被误报不匹配。
    # 未知的非镜像键仍留在 actual 一侧，不会被当成匹配。
    if [ "$(provisioned_env_keys_of "$ACTUAL_ENV_KEYS")" = "$(provisioned_env_keys_of "$DESIRED_ENV_KEYS")" ]; then
      log "env_keys_match_desired=true"
    else
      log "env_keys_match_desired=false"
    fi
  fi

  if [ -f "$(pointer_file)" ]; then
    log "previous_container=$(head -n 1 "$(pointer_file)" | tr -d '[:space:]')"
  else
    log "previous_container=-"
  fi
}

# ---------------------------------------------------------------- main

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      start|update|rollback|status|stop)
        if [ -n "$CMD" ]; then
          die $EXIT_USAGE "只能指定一个命令（已有 ${CMD}，又收到 $1）"
        fi
        CMD=$1
        shift
        ;;
      -c|--config)
        [ $# -ge 2 ] || die $EXIT_USAGE "--config 缺少参数"
        CONFIG_FILE=$2
        shift 2
        ;;
      --config=*)
        CONFIG_FILE=${1#--config=}
        shift
        ;;
      -n|--dry-run)
        DRY_RUN=1
        shift
        ;;
      --takeover)
        TAKEOVER=1
        shift
        ;;
      --allow-reconfigure)
        ALLOW_RECONFIGURE=1
        shift
        ;;
      --ack-data-compatible)
        ACK_DATA=1
        shift
        ;;
      -h|--help)
        usage
        exit $EXIT_OK
        ;;
      *)
        die $EXIT_USAGE "未知参数: $1（使用 --help 查看用法）"
        ;;
    esac
  done
  [ -n "$CMD" ] || die $EXIT_USAGE "缺少命令（start|update|rollback|status|stop）"
  if [ -z "$CONFIG_FILE" ]; then
    CONFIG_FILE="$PWD/deploy.env"
  fi
}

main() {
  parse_args "$@"
  # 选项只在对应命令上有意义：跨命令静默忽略会让「这些 flag 不得削弱某条不变量」难以推理
  # （例如 --takeover/--allow-reconfigure 都不是挂载目录变化的绕过开关），因此这里显式拒绝。
  if [ "$TAKEOVER" = 1 ] && [ "$CMD" != 'start' ]; then
    die $EXIT_USAGE "--takeover 只能用于 start（当前命令：${CMD}）"
  fi
  if [ "$ALLOW_RECONFIGURE" = 1 ] && [ "$CMD" != 'update' ]; then
    die $EXIT_USAGE "--allow-reconfigure 只能用于 update（当前命令：${CMD}）"
  fi
  if [ "$ACK_DATA" = 1 ] && [ "$CMD" != 'rollback' ]; then
    die $EXIT_USAGE "--ack-data-compatible 只能用于 rollback（当前命令：${CMD}）"
  fi
  parse_config "$CONFIG_FILE"
  apply_defaults
  validate_static
  resolve_paths "$(require_dirs_for_command)"
  validate_dirs_usable "$(require_dirs_for_command)"
  if [ "$(require_secrets_for_command)" = 1 ]; then
    validate_secrets_file
  fi
  # 所有本地静态校验通过后、任何 daemon 查询或变更之前，先确认 endpoint 是本机。
  # 放在这里而不是更早，是为了让「输入校验先于任何 docker 调用」的既有不变量继续成立。
  reject_remote_daemon

  STAMP=$(date -u +%Y%m%dT%H%M%SZ)

  trap 'on_exit' EXIT
  trap 'on_signal INT 130' INT
  trap 'on_signal TERM 143' TERM
  trap 'on_signal HUP 129' HUP

  case "$CMD" in
    start|update|rollback|stop)
      acquire_lock
      ;;
    status)
      ;;
  esac

  case "$CMD" in
    start) do_start ;;
    update) do_update ;;
    rollback) do_rollback ;;
    status) do_status ;;
    stop) do_stop ;;
    *) die $EXIT_USAGE "未知命令: $CMD" ;;
  esac

  release_lock
  exit $EXIT_OK
}

main "$@"
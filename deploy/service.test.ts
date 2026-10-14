import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个用例会 spawn 多次 bash + 假 docker，默认 5s 超时对组合场景偏紧。
setDefaultTimeout(30000)

// deploy/service.sh 的回归测试。
//
// 全部依赖都是 hermetic 的：
//   * 临时 HOME / 临时运行时目录 / 临时锁目录，不触碰开发者真实 ~/.claude、密钥链或任何服务器
//   * 一个 POSIX sh 假 docker 状态机（见 FAKE_DOCKER_SOURCE），只实现 service.sh 用到的最小接口
//   * 不访问公网、不启动真实模型、不连接任何 provider
//
// 假 docker 只认 service.sh 里固定的 --format 字符串：脚本换了 inspect 模板而测试没跟着更新时，
// 测试会以「不支持的 inspect --format」立刻失败，而不是静默放过。

const SERVICE = join(import.meta.dir, 'service.sh')
const EXAMPLE_ENV = join(import.meta.dir, 'deploy.env.example')
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000
const GID = typeof process.getgid === 'function' ? process.getgid() : 1000
const SECRET_VALUE = 'SUPER_SECRET_TOKEN_do_not_leak_9f8e7d'
// 镜像自带的 Dockerfile ENV（PATH 等）：不应被脚本要求出现在部署密钥文件里。
const DEFAULT_IMAGE_ENV = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'NODE_VERSION=22.5.0',
  'LANG=C.UTF-8',
]

const FAKE_DOCKER_SOURCE = `#!/bin/sh
# 假 docker：用「每个字段一个文件」的状态目录实现 service.sh 需要的最小子集。
# 只记录 env-file 的键名，不落任何密钥值。
set -eu

STATE=\${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE 未设置}
mkdir -p "$STATE/containers"
printf '%s\\n' "$*" >> "$STATE/log"

FAILS=",\${FAKE_DOCKER_FAIL:-},"
HEALTH=\${FAKE_DOCKER_HEALTH:-healthy}
SLEEP_MS=\${FAKE_DOCKER_SLEEP_MS:-0}
# 模拟 docker healthcheck 的 starting 中间态：健康状态为 starting 时，每次被 inspect
# 计数递增，达到该次数才转为 healthy（用于验证脚本会轮询而不是立刻判失败）。
START_POLLS=\${FAKE_DOCKER_START_POLLS:-3}

die() { printf '%s\\n' "$*" >&2; exit 1; }

fail_if() {
  case "$FAILS" in *",$1,"*) die "fake docker: 注入失败 $1" ;; esac
}

cdir() { printf '%s/containers/%s' "$STATE" "$1"; }

cget() {
  f="$STATE/containers/$1/$2"
  if [ -f "$f" ]; then
    cat "$f"
  fi
}

wait_sleep() {
  if [ "$SLEEP_MS" -gt 0 ]; then
    sleep "$((SLEEP_MS / 1000)).$((SLEEP_MS % 1000))"
  fi
}

image_id_of() {
  found_id=''
  while read -r iid iref; do
    if [ "$iref" = "$1" ]; then
      found_id=$iid
    fi
  done < "$STATE/images"
  [ -n "$found_id" ] || die "Error: No such image: $1"
  printf '%s' "$found_id"
}

# 镜像 Dockerfile ENV 定义的键值。真实 docker 会把它们合并进容器的 .Config.Env，
# 这里同样在渲染容器 env 时叠加，用于验证脚本不会把镜像默认键当成部署方缺失的键。
image_env_of() {
  if [ -f "$STATE/imageenv" ]; then
    while read -r iref ienv; do
      if [ "$iref" = "$1" ]; then printf '%s\\n' "$ienv"; fi
    done < "$STATE/imageenv"
  fi
}

render() {
  fmt=$1
  name=$2
  case "$fmt" in
    '{{.Id}}') cget "$name" id ;;
    '{{.Config.Image}}') cget "$name" image ;;
    '{{.Image}}') cget "$name" imageId ;;
    '{{.Config.User}}') cget "$name" user ;;
    '{{.HostConfig.NetworkMode}}') cget "$name" network ;;
    '{{.HostConfig.RestartPolicy.Name}}') cget "$name" restart ;;
    '{{if .HostConfig.Init}}true{{else}}false{{end}}') cget "$name" init ;;
    '{{.State.Running}}') cget "$name" running ;;
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
      h=$(cget "$name" health)
      if [ "$h" = 'starting' ]; then
        polls=0
        if [ -f "$(cdir "$name")/healthPolls" ]; then polls=$(cat "$(cdir "$name")/healthPolls"); fi
        polls=$((polls + 1))
        printf '%s' "$polls" > "$(cdir "$name")/healthPolls"
        if [ "$polls" -ge "$START_POLLS" ]; then
          printf '%s' 'healthy' > "$(cdir "$name")/health"
          printf '%s' 'healthy'
        else
          printf '%s' 'starting'
        fi
      else
        printf '%s' "$h"
      fi
      ;;
    '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\\n"}}{{end}}')
      if [ -f "$STATE/containers/$name/labels" ]; then cat "$STATE/containers/$name/labels"; fi
      ;;
    '{{range .Config.Env}}{{.}}{{"\\n"}}{{end}}')
      # 真实 docker 的 .Config.Env = 镜像 ENV + --env + --env-file 键。
      img=$(cget "$name" image)
      if [ -n "$img" ]; then image_env_of "$img"; fi
      if [ -f "$STATE/containers/$name/env" ]; then cat "$STATE/containers/$name/env"; fi
      if [ -f "$STATE/containers/$name/envFileKeys" ]; then
        while IFS= read -r ek; do
          if [ -n "$ek" ]; then printf '%s=value-from-env-file\\n' "$ek"; fi
        done < "$STATE/containers/$name/envFileKeys"
      fi
      ;;
    '{{range .Mounts}}{{.Type}}:{{.Source}}:{{.Destination}}{{"\\n"}}{{end}}')
      if [ -f "$STATE/containers/$name/mounts" ]; then cat "$STATE/containers/$name/mounts"; fi
      ;;
    *) die "fake docker: 不支持的 inspect --format: $fmt" ;;
  esac
}

cmd=\${1:-}
shift || true

case "$cmd" in
  version)
    printf '%s\\n' 'Docker version 99.0.0-fake'
    ;;

  inspect)
    fail_if inspect
    [ "\${1:-}" = '--format' ] || die 'fake docker: 只支持 inspect --format <fmt> <name>'
    fmt=\${2:-}
    name=\${3:-}
    [ -d "$(cdir "$name")" ] || die "Error: No such object: $name"
    render "$fmt" "$name"
    ;;

  image)
    fail_if imageinspect
    [ "\${1:-}" = 'inspect' ] || die "fake docker: 不支持的 image 子命令"
    [ "\${2:-}" = '--format' ] || die 'fake docker: 只支持 image inspect --format <fmt> <image>'
    case "\${3:-}" in
      '{{.Id}}') image_id_of "\${4:-}" ;;
      '{{range .Config.Env}}{{.}}{{"\\n"}}{{end}}') image_env_of "\${4:-}" ;;
      *) die "fake docker: 不支持的 image inspect --format: \${3:-}" ;;
    esac
    printf '\\n'
    ;;

  create)
    fail_if create
    name=''
    image=''
    user=''
    network='default'
    restart='no'
    init='false'
    stop_timeout='-1'
    : > "$STATE/.tmp_labels"
    : > "$STATE/.tmp_env"
    : > "$STATE/.tmp_envfiles"
    : > "$STATE/.tmp_mounts"
    : > "$STATE/.tmp_ports"
    : > "$STATE/.tmp_security"

    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --label) printf '%s\\n' "$2" >> "$STATE/.tmp_labels"; shift 2 ;;
        --env) printf '%s\\n' "$2" >> "$STATE/.tmp_env"; shift 2 ;;
        --env-file) printf '%s\\n' "$2" >> "$STATE/.tmp_envfiles"; shift 2 ;;
        --user) user=$2; shift 2 ;;
        --network) network=$2; shift 2 ;;
        --restart) restart=$2; shift 2 ;;
        --init) init='true'; shift ;;
        --stop-timeout) stop_timeout=$2; shift 2 ;;
        --security-opt) printf '%s\\n' "$2" >> "$STATE/.tmp_security"; shift 2 ;;
        --volume)
          v=$2
          printf 'bind:%s\\n' "$v" >> "$STATE/.tmp_mounts"
          shift 2
          ;;
        --publish|-p)
          p=$2
          printf '%s:%s\\n' "\${p##*:}" "\${p%%:*}" >> "$STATE/.tmp_ports"
          shift 2
          ;;
        --workdir) shift 2 ;;
        -*)
          die "fake docker: 不支持的 create 参数: $1"
          ;;
        *)
          if [ -z "$image" ]; then image=$1; fi
          shift
          ;;
      esac
    done

    [ -n "$name" ] || die 'fake docker: create 缺少 --name'
    [ -n "$image" ] || die 'fake docker: create 缺少镜像'
    [ -d "$STATE/containers/$name" ] && die "Error: Conflict. The container name \\"/$name\\" is already in use"
    image_id_of "$image" > /dev/null

    d="$STATE/containers/$name"
    mkdir -p "$d"
    printf 'sha256:container-%s' "$name" > "$d/id"
    printf '%s' "$image" > "$d/image"
    printf '%s' "$(image_id_of "$image")" > "$d/imageId"
    printf '%s' "$user" > "$d/user"
    printf '%s' "$network" > "$d/network"
    printf '%s' "$restart" > "$d/restart"
    printf '%s' "$init" > "$d/init"
    printf '%s' "$stop_timeout" > "$d/stopTimeout"
    printf 'false' > "$d/running"
    printf 'none' > "$d/health"
    printf '0' > "$d/healthPolls"
    cp "$STATE/.tmp_labels" "$d/labels"
    cp "$STATE/.tmp_env" "$d/env"
    cp "$STATE/.tmp_mounts" "$d/mounts"
    cp "$STATE/.tmp_ports" "$d/ports"
    cp "$STATE/.tmp_security" "$d/securityOpts"
    : > "$d/envFileKeys"
    while IFS= read -r ef; do
      if [ -n "$ef" ]; then
        [ -f "$ef" ] || die "Error: env file not found: $ef"
        sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' "$ef" | while IFS= read -r line; do
          printf '%s\\n' "\${line%%=*}" >> "$d/envFileKeys"
        done
      fi
    done < "$STATE/.tmp_envfiles"

    rm -f "$STATE/.tmp_labels" "$STATE/.tmp_env" "$STATE/.tmp_envfiles" "$STATE/.tmp_mounts" "$STATE/.tmp_ports" "$STATE/.tmp_security"
    printf '%s\\n' "$name"
    ;;

  start)
    fail_if start
    name=\${1:-}
    [ -d "$(cdir "$name")" ] || die "Error: No such container: $name"
    wait_sleep
    case "$HEALTH" in
      unhealthy) h='unhealthy' ;;
      none) h='none' ;;
      starting) h='starting' ;;
      *) h='healthy' ;;
    esac
    printf 'true' > "$(cdir "$name")/running"
    printf '%s' "$h" > "$(cdir "$name")/health"
    printf '0' > "$(cdir "$name")/healthPolls"
    printf '%s\\n' "$name"
    ;;

  stop)
    fail_if stop
    stop_time=''
    while [ $# -gt 1 ]; do
      case "$1" in
        --time) stop_time=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    name=\${1:-}
    [ -d "$(cdir "$name")" ] || die "Error: No such container: $name"
    wait_sleep
    printf 'false' > "$(cdir "$name")/running"
    printf 'none' > "$(cdir "$name")/health"
    printf '%s' "$stop_time" > "$(cdir "$name")/lastStopTime"
    printf '%s\\n' "$name"
    ;;

  rename)
    fail_if rename
    old=\${1:-}
    new=\${2:-}
    [ -d "$(cdir "$old")" ] || die "Error: No such container: $old"
    [ -d "$(cdir "$new")" ] && die "Error: Conflict. The name \\"/$new\\" is already in use"
    mv "$(cdir "$old")" "$(cdir "$new")"
    printf '%s\\n' "$new"
    ;;

  port)
    name=\${1:-}
    [ -d "$(cdir "$name")" ] || die "Error: No such container: $name"
    if [ -f "$(cdir "$name")/ports" ]; then
      while IFS=: read -r cport hport; do
        if [ -n "$cport" ]; then
          # 默认 bridge 网络上 docker port 会同时输出 IPv4 与 IPv6 两条映射。
          printf '%s/tcp -> 0.0.0.0:%s\\n' "$cport" "$hport"
          printf '%s/tcp -> [::]:%s\\n' "$cport" "$hport"
        fi
      done < "$(cdir "$name")/ports"
    fi
    ;;

  rm)
    fail_if rm
    while [ $# -gt 1 ]; do shift; done
    name=\${1:-}
    rm -rf "$(cdir "$name")"
    printf '%s\\n' "$name"
    ;;

  context)
    ctx_host="\${FAKE_DOCKER_CONTEXT_HOST:-}"
    ctx_fail="\${FAKE_DOCKER_CONTEXT_FAIL:-}"
    sub=''
    for arg in "$@"; do sub=$arg; break; done
    if [ "$sub" != 'inspect' ]; then
      echo 'fake docker: context 只支持 inspect' >&2
      exit 1
    fi
    shift
    if [ "$1" != '--format' ] || [ "$2" != '{{.Endpoints.docker.Host}}' ]; then
      echo 'fake docker: 不支持的 context inspect 参数' >&2
      exit 1
    fi
    if [ -n "$ctx_fail" ]; then
      echo 'fake docker: 注入 context inspect 失败' >&2
      exit 1
    fi
    if [ -n "$ctx_host" ]; then
      echo "$ctx_host"
    fi
    exit 0
    ;;

  *)
    die "fake docker: 不支持的命令: $cmd"
    ;;
esac
`

type ContainerState = {
  id: string
  image: string
  imageId: string
  user: string
  network: string
  restart: string
  init: boolean
  running: boolean
  health: string
  labels: Record<string, string>
  env: string[]
  envFileKeys: string[]
  mounts: Array<{ type: string; source: string; destination: string }>
  ports: Array<{ container: number; host: number }>
  securityOpts: string[]
}

type Fixture = {
  root: string
  bin: string
  state: string
  home: string
  lockBase: string
  runtime: string
  configDir: string
  workspaceDir: string
  backupDir: string
  secretsPath: string
  configPath: string
}

type FixtureOptions = {
  config?: Record<string, string>
  secrets?: string[] | null
  secretsMode?: number
  images?: string[]
  imageEnv?: string[]
  createRuntime?: boolean
  createDataDirs?: boolean
  configDirMode?: number
  backupDirMode?: number
  secretsInsideConfig?: boolean
  configSymlink?: boolean
  workspaceSymlink?: boolean
}

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true })
  }
})

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ccmax-deploy-test-'))
  scratchDirs.push(root)
  const bin = join(root, 'bin')
  const state = join(root, 'state')
  const home = join(root, 'home')
  const lockBase = join(root, 'locks')
  const runtime = join(root, 'runtime')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(state, 'containers'), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(lockBase, { recursive: true })

  const dockerPath = join(bin, 'docker')
  writeFileSync(dockerPath, FAKE_DOCKER_SOURCE)
  chmodSync(dockerPath, 0o755)

  if (options.createRuntime !== false) mkdirSync(runtime, { recursive: true })

  const configDir = join(runtime, 'config')
  const workspaceDir = join(runtime, 'workspace')
  const backupDir = join(runtime, 'backups')
  if (options.createRuntime !== false && options.createDataDirs !== false) {
    mkdirSync(configDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
    chmodSync(configDir, 0o700)
    chmodSync(workspaceDir, 0o700)
  }
  if (options.configDirMode !== undefined) chmodSync(configDir, options.configDirMode)
  if (options.backupDirMode !== undefined) {
    mkdirSync(backupDir, { recursive: true })
    chmodSync(backupDir, options.backupDirMode)
  }
  // 顶层符号链接场景：真实目录另放一处，config/workspace 只放链接。
  // tar 遇到这种顶层链接只会归档链接本身，备份不含任何数据。
  const symlinked: Array<[boolean | undefined, string, string]> = [
    [options.configSymlink, configDir, 'real-config'],
    [options.workspaceSymlink, workspaceDir, 'real-workspace'],
  ]
  for (const [enabled, linkPath, realName] of symlinked) {
    if (!enabled) continue
    const realDir = join(root, realName)
    rmSync(linkPath, { recursive: true, force: true })
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'payload.txt'), `${realName} data\n`)
    symlinkSync(realDir, linkPath)
  }

  const secretsPath = options.secretsInsideConfig ? join(configDir, 'secrets.env') : join(root, 'secrets.env')

  const fixture: Fixture = {
    root,
    bin,
    state,
    home,
    lockBase,
    runtime,
    configDir,
    workspaceDir,
    backupDir,
    secretsPath,
    configPath: join(root, 'deploy.env'),
  }

  const images = options.images ?? ['ccmax:test-1']
  writeFileSync(join(state, 'images'), images.map((ref, i) => `sha256:image-${i} ${ref}`).join('\n') + '\n')

  // 镜像 Dockerfile ENV 定义的默认环境变量。真实镜像几乎都会有 PATH 等默认键，
  // 这里默认带上一组，用来验证脚本不会把它们当成「部署方必须复刻的键」。
  const imageEnv = options.imageEnv ?? DEFAULT_IMAGE_ENV
  writeFileSync(join(state, 'imageenv'), images.flatMap((ref) => imageEnv.map((entry) => `${ref} ${entry}`)).join('\n') + '\n')

  const config: Record<string, string> = defaultConfig(fixture)
  if (options.secrets !== null) {
    const lines = options.secrets ?? [`ANTHROPIC_AUTH_TOKEN=${SECRET_VALUE}`, 'ANTHROPIC_BASE_URL=https://example.invalid/anthropic']
    writeFileSync(secretsPath, `${lines.join('\n')}\n`)
    chmodSync(secretsPath, options.secretsMode ?? 0o600)
  } else {
    delete config.CCMAX_SECRETS_FILE
  }

  writeConfigFile(fixture, { ...config, ...(options.config ?? {}) })
  return fixture
}

function defaultConfig(fx: Fixture): Record<string, string> {
  return {
    CCMAX_IMAGE: 'ccmax:test-1',
    CCMAX_CONTAINER_NAME: 'ccmax-test',
    CCMAX_RUNTIME_DIR: fx.runtime,
    CCMAX_CONFIG_SUBDIR: 'config',
    CCMAX_WORKSPACE_SUBDIR: 'workspace',
    CCMAX_BACKUP_SUBDIR: 'backups',
    CCMAX_PORT: '18081',
    CCMAX_CONTAINER_PORT: '18081',
    CCMAX_NETWORK_MODE: 'bridge',
    CCMAX_UID: String(UID),
    CCMAX_GID: String(GID),
    CCMAX_RESTART_POLICY: 'unless-stopped',
    CCMAX_STOP_TIMEOUT: '60',
    CCMAX_INIT: 'true',
    CCMAX_HEALTH_TIMEOUT: '5',
    CCMAX_HEALTH_INTERVAL: '0',
    CCMAX_NO_NEW_PRIVILEGES: 'true',
    CCMAX_DOCKER_BIN: 'docker',
    CCMAX_LOCK_BASE: fx.lockBase,
    CCMAX_SECRETS_FILE: fx.secretsPath,
  }
}

function writeConfigFile(fx: Fixture, config: Record<string, string>, extraLines: string[] = []) {
  const lines = ['# 测试用 ccmax 部署配置', '', '# 注释行与空行必须被忽略']
  for (const [key, value] of Object.entries(config)) lines.push(`${key}=${value}`)
  lines.push(...extraLines)
  writeFileSync(fx.configPath, `${lines.join('\n')}\n`)
}

function rewriteConfig(fx: Fixture, overrides: Record<string, string>) {
  writeConfigFile(fx, { ...defaultConfig(fx), ...overrides })
}

function addImage(fx: Fixture, ref: string) {
  const path = join(fx.state, 'images')
  const content = readFileSync(path, 'utf8')
  const count = content.split('\n').filter(Boolean).length
  writeFileSync(path, `${content}sha256:image-${count} ${ref}\n`)
  // 新镜像同样有 Dockerfile ENV：不登记的话脚本会把它当成「部署方缺失的键」。
  const envPath = join(fx.state, 'imageenv')
  const envContent = readFileSync(envPath, 'utf8')
  writeFileSync(envPath, `${envContent}${DEFAULT_IMAGE_ENV.map((entry) => `${ref} ${entry}`).join('\n')}\n`)
}

/** 假 docker 默认返回的本机 context endpoint：解析器现在拒绝空值，因此必须给一个可确认的本机 socket。 */
const FAKE_LOCAL_CONTEXT_HOST = 'unix:///var/run/docker.sock'

type RunOptions = {
  health?: string
  fail?: string
  sleepMs?: number
  startPolls?: number
  dockerHost?: string
  /** DOCKER_CONTEXT：选择 context；非 default 时脚本会只读 docker context inspect 校验它。 */
  dockerContext?: string
  /** 假 docker 的 context endpoint Host（模拟当前 context 或命名 context 的 endpoint）。传 '' 模拟「成功但空」。 */
  dockerContextHost?: string
  /** 让假 docker 的 context inspect 失败，用于验证 fail closed。 */
  dockerContextFail?: boolean
}

function spawnOptions(fx: Fixture, options: RunOptions = {}) {
  return {
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
      HOME: fx.home,
      TMPDIR: fx.home,
      // 显式清空 DOCKER_HOST/DOCKER_CONTEXT：脚本拒绝非本机 daemon，测试必须 hermetic。
      DOCKER_HOST: options.dockerHost ?? '',
      DOCKER_CONTEXT: options.dockerContext ?? '',
      FAKE_DOCKER_STATE: fx.state,
      FAKE_DOCKER_HEALTH: options.health ?? 'healthy',
      // 默认给本机 socket，否则 context inspect 会「成功但空」，脚本按 fail closed 拒绝。
      FAKE_DOCKER_CONTEXT_HOST: options.dockerContextHost ?? FAKE_LOCAL_CONTEXT_HOST,
      ...(options.dockerContextFail ? { FAKE_DOCKER_CONTEXT_FAIL: '1' } : {}),
      ...(options.fail ? { FAKE_DOCKER_FAIL: options.fail } : {}),
      ...(options.sleepMs ? { FAKE_DOCKER_SLEEP_MS: String(options.sleepMs) } : {}),
      ...(options.startPolls ? { FAKE_DOCKER_START_POLLS: String(options.startPolls) } : {}),
    },
    cwd: fx.root,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  }
}

function run(fx: Fixture, args: string[], options: RunOptions = {}) {
  const hasConfigFlag = args.some((a) => a === '-c' || a === '--config' || a.startsWith('--config='))
  const argv = hasConfigFlag ? args : [...args, '-c', fx.configPath]
  const proc = Bun.spawnSync(['bash', SERVICE, ...argv], spawnOptions(fx, options))
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    log: dockerLog(fx),
  }
}

function dockerLog(fx: Fixture): string {
  const path = join(fx.state, 'log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function clearLog(fx: Fixture) {
  writeFileSync(join(fx.state, 'log'), '')
}

function dockerCalls(fx: Fixture, verb: string): string[] {
  return dockerLog(fx)
    .split('\n')
    .filter((line) => line.startsWith(`${verb} `) || line === verb)
}

function mutatingCalls(fx: Fixture): string[] {
  return dockerLog(fx)
    .split('\n')
    .filter((line) => /^(create|start|stop|rename|rm) /.test(line))
}

function linesOf(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : []
}

function containerDir(fx: Fixture, name: string) {
  return join(fx.state, 'containers', name)
}

function containerNames(fx: Fixture): string[] {
  const dir = join(fx.state, 'containers')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function containerRecord(fx: Fixture, name: string): ContainerState | null {
  const dir = containerDir(fx, name)
  if (!existsSync(dir)) return null
  const read = (field: string) => {
    const path = join(dir, field)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const labels: Record<string, string> = {}
  for (const line of linesOf(join(dir, 'labels'))) {
    const idx = line.indexOf('=')
    if (idx > 0) labels[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return {
    id: read('id'),
    image: read('image'),
    imageId: read('imageId'),
    user: read('user'),
    network: read('network'),
    restart: read('restart'),
    init: read('init') === 'true',
    running: read('running') === 'true',
    health: read('health') || 'none',
    labels,
    env: linesOf(join(dir, 'env')),
    envFileKeys: linesOf(join(dir, 'envFileKeys')),
    mounts: linesOf(join(dir, 'mounts')).map((line) => {
      const [type, source, destination] = line.split(':')
      return { type, source, destination }
    }),
    ports: linesOf(join(dir, 'ports')).map((line) => {
      const [container, host] = line.split(':')
      return { container: Number(container), host: Number(host) }
    }),
    securityOpts: linesOf(join(dir, 'securityOpts')),
  }
}

function writeFields(fx: Fixture, name: string, fields: Record<string, string | boolean | string[] | Record<string, string> | Array<{ container: number; host: number }> | Array<{ type: string; source: string; destination: string }>>) {
  const dir = containerDir(fx, name)
  if (!existsSync(dir)) throw new Error(`容器不存在: ${name}`)
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'labels') {
      const entries = Object.entries(value as Record<string, string>).map(([k, v]) => `${k}=${v}`)
      writeFileSync(join(dir, 'labels'), entries.length ? `${entries.join('\n')}\n` : '')
    } else if (key === 'mounts') {
      const entries = (value as Array<{ type: string; source: string; destination: string }>).map((m) => `${m.type}:${m.source}:${m.destination}`)
      writeFileSync(join(dir, 'mounts'), entries.length ? `${entries.join('\n')}\n` : '')
    } else if (key === 'ports') {
      const entries = (value as Array<{ container: number; host: number }>).map((p) => `${p.container}:${p.host}`)
      writeFileSync(join(dir, 'ports'), entries.length ? `${entries.join('\n')}\n` : '')
    } else if (Array.isArray(value)) {
      writeFileSync(join(dir, key), value.length ? `${(value as string[]).join('\n')}\n` : '')
    } else if (typeof value === 'boolean') {
      writeFileSync(join(dir, key), value ? 'true' : 'false')
    } else {
      writeFileSync(join(dir, key), String(value))
    }
  }
}

function seedContainer(fx: Fixture, name: string, extra: Record<string, unknown> = {}) {
  const dir = containerDir(fx, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'id'), `sha256:seeded-${name}`)
  writeFileSync(join(dir, 'image'), 'ccmax:test-1')
  writeFileSync(join(dir, 'user'), '')
  writeFileSync(join(dir, 'network'), 'bridge')
  writeFileSync(join(dir, 'restart'), 'no')
  writeFileSync(join(dir, 'init'), 'false')
  writeFileSync(join(dir, 'stopTimeout'), '-1')
  writeFileSync(join(dir, 'running'), 'false')
  writeFileSync(join(dir, 'health'), 'none')
  writeFileSync(join(dir, 'labels'), '')
  writeFileSync(join(dir, 'env'), '')
  writeFileSync(join(dir, 'envFileKeys'), '')
  writeFileSync(join(dir, 'mounts'), '')
  writeFileSync(join(dir, 'ports'), '')
  writeFileSync(join(dir, 'securityOpts'), '')
  if (Object.keys(extra).length > 0) {
    writeFields(fx, name, extra as Record<string, string | boolean | string[]>)
  }
}

// 播种一个「与当前配置结构一致」的未受管容器：用于验证 --takeover 的安全路径。
function seedCompatibleUnmanaged(fx: Fixture, name: string) {
  seedContainer(fx, name, {
    user: `${UID}:${GID}`,
    network: 'bridge',
    ports: [{ container: 18081, host: 18081 }],
    mounts: [
      { type: 'bind', source: realpathSync(fx.configDir), destination: '/config' },
      { type: 'bind', source: realpathSync(fx.workspaceDir), destination: '/workspace' },
    ],
    env: [
      'HOME=/workspace',
      'CLAUDE_CONFIG_DIR=/config',
      'SERVER_HOST=0.0.0.0',
      'SERVER_PORT=18081',
      'ANTHROPIC_AUTH_TOKEN=value-from-env-file',
      'ANTHROPIC_BASE_URL=value-from-env-file',
    ],
    envFileKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  })
}

// 让某个 tag 指向新的 image id（模拟 tag 被重新打指）。
function repointImage(fx: Fixture, ref: string, newId: string) {
  const path = join(fx.state, 'images')
  const content = readFileSync(path, 'utf8')
  writeFileSync(path, `${content}${newId} ${ref}\n`)
}

function allFixtureFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) allFixtureFiles(path, acc)
    else if (entry.isFile()) acc.push(path)
  }
  return acc
}

describe('配置解析（严格 KEY=value，绝不 source）', () => {
  test('注释与空行被忽略，start --dry-run 打印完整计划', () => {
    const fx = makeFixture()
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('[dry-run]')
    expect(r.stdout).toContain('create')
  })

  test('未知配置键直接失败，不执行任何 docker 命令', () => {
    const fx = makeFixture()
    writeFileSync(fx.configPath, `CCMAX_TYPO_KEY=1\n${readFileSync(fx.configPath, 'utf8')}`)
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('未知配置键')
    expect(r.log.trim()).toBe('')
  })

  test('export/source 形式被拒绝', () => {
    const fx = makeFixture()
    writeFileSync(fx.configPath, 'export CCMAX_IMAGE=ccmax:evil\n')
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('配置键非法')
  })

  test('反引号命令替换被拒绝且不执行', () => {
    const fx = makeFixture()
    const marker = join(fx.root, 'pwned')
    writeFileSync(fx.configPath, `CCMAX_CONTAINER_NAME=\`touch ${marker}\`\n`)
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(3)
    expect(existsSync(marker)).toBe(false)
  })

  test('值里的 $(...) 被拒绝且不执行', () => {
    const fx = makeFixture()
    const marker = join(fx.root, 'pwned2')
    writeFileSync(fx.configPath, `CCMAX_CONTAINER_NAME=$(touch ${marker})\n`)
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(3)
    expect(existsSync(marker)).toBe(false)
  })

  test('配置文件缺失时报配置错误', () => {
    const fx = makeFixture()
    const r = run(fx, ['start', '--dry-run', '-c', join(fx.root, 'nope.env')])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('配置文件不存在')
  })

  test('随仓库发布的 deploy.env.example 能被严格解析器接受', () => {
    const fx = makeFixture({ images: ['ccmax:local'], config: { CCMAX_IMAGE: 'ccmax:local' } })
    const raw = readFileSync(EXAMPLE_ENV, 'utf8')
      .replace(/^CCMAX_RUNTIME_DIR=.*$/m, `CCMAX_RUNTIME_DIR=${fx.runtime}`)
      .replace(/^CCMAX_UID=.*$/m, `CCMAX_UID=${UID}`)
      .replace(/^CCMAX_GID=.*$/m, `CCMAX_GID=${GID}`)
      .concat(`\nCCMAX_LOCK_BASE=${fx.lockBase}\nCCMAX_HEALTH_TIMEOUT=5\nCCMAX_HEALTH_INTERVAL=0\n`)
    writeFileSync(fx.configPath, raw)
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ccmax:local')
  })
})

describe('输入校验先于任何 docker 变更', () => {
  test('缺少 CCMAX_RUNTIME_DIR 时不做任何 docker 调用', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_RUNTIME_DIR: '' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('CCMAX_RUNTIME_DIR')
    expect(r.log.trim()).toBe('')
  })

  test('缺少镜像时不做任何 docker 调用', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_IMAGE: '' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('CCMAX_IMAGE')
    expect(r.log.trim()).toBe('')
  })

  test(':latest 与隐式 tag 被拒绝', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:latest' })
    const latest = run(fx, ['start'])
    expect(latest.code).toBe(4)
    expect(latest.stderr).toContain('latest')

    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax' })
    const implicit = run(fx, ['start'])
    expect(implicit.code).toBe(4)
    expect(implicit.stderr).toContain('精确 tag')
    expect(implicit.log.trim()).toBe('')
  })

  test('digest 形式被接受', () => {
    const digest = `ccmax@sha256:${'a'.repeat(64)}`
    const fx = makeFixture({ images: [digest], config: { CCMAX_IMAGE: digest } })
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(0)
  })

  test('registry:port/repo 这种「假 tag」被拒绝', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_IMAGE: 'registry.local:5000/ccmax' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('tag')
    expect(r.log.trim()).toBe('')
  })

  test('digest 长度不是 64 hex 时被拒绝', () => {
    const fx = makeFixture({ images: ['ccmax:test-1'] })
    rewriteConfig(fx, { CCMAX_IMAGE: `ccmax@sha256:${'a'.repeat(40)}` })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('64')
    expect(r.log.trim()).toBe('')
  })

  test('路径含冒号/逗号时在任何 docker 调用前拒绝', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_RUNTIME_DIR: `${fx.runtime}:x` })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain("':'")
    expect(r.log.trim()).toBe('')
  })

  test('目标镜像不存在时拒绝且不创建容器', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:missing-tag' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(6)
    expect(r.stderr).toContain('目标镜像不存在')
    expect(dockerCalls(fx, 'create')).toHaveLength(0)
  })

  test('运行时目录不存在时不自动创建', () => {
    const fx = makeFixture({ createRuntime: false })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(existsSync(fx.runtime)).toBe(false)
    expect(r.log.trim()).toBe('')
  })

  test('config/workspace 目录不存在时不自动创建空目录', () => {
    const fx = makeFixture({ createDataDirs: false })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('不会自动创建空目录')
    expect(existsSync(fx.configDir)).toBe(false)
    expect(existsSync(fx.workspaceDir)).toBe(false)
    expect(r.log.trim()).toBe('')
  })

  test('权限检查以容器 uid 为准，而不是 root 的试写结果', () => {
    const fx = makeFixture({ configDirMode: 0o700 })
    rewriteConfig(fx, { CCMAX_UID: '4242', CCMAX_GID: '4242' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('不可读写')
    expect(r.stderr).toContain('不能只以 root')
    expect(r.log.trim()).toBe('')
  })

  test('属主匹配且 mode 700 时通过权限检查', () => {
    const fx = makeFixture()
    expect(run(fx, ['start', '--dry-run']).code).toBe(0)
  })

  test('密钥文件 mode 非 0600 时拒绝且不泄漏值', () => {
    const fx = makeFixture({ secretsMode: 0o644 })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('0600')
    expect(r.output).not.toContain(SECRET_VALUE)
    expect(r.log.trim()).toBe('')
  })

  test('密钥文件位于 config 目录内时拒绝（避免被备份并暴露给容器）', () => {
    const fx = makeFixture({ secretsInsideConfig: true })
    const r = run(fx, ['start'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('必须位于 config/workspace 之外')
    expect(r.log.trim()).toBe('')
  })

  test('密钥文件键不符合 [A-Za-z_][A-Za-z0-9_]* 时拒绝', () => {
    const fx = makeFixture({ secrets: ['1BAD-KEY=value'] })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('键非法')
    expect(r.log.trim()).toBe('')
  })

  test('密钥文件存在重复键时拒绝', () => {
    const fx = makeFixture({ secrets: ['ANTHROPIC_AUTH_TOKEN=a', 'ANTHROPIC_AUTH_TOKEN=b'] })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('重复键')
    expect(r.log.trim()).toBe('')
  })

  test('密钥文件试图覆盖容器固定变量时拒绝（HOME/SERVER_PORT/PATH 等）', () => {
    for (const key of ['HOME', 'SERVER_PORT', 'PATH', 'NODE_OPTIONS', 'BUN_OPTIONS']) {
      const fx = makeFixture({ secrets: [`${key}=/evil`] })
      const r = run(fx, ['start'])
      expect(r.code).toBe(4)
      expect(r.stderr).toContain('受控变量')
      expect(r.log.trim()).toBe('')
    }
  })

  test('备份目录与 config 目录通过符号链接重叠时拒绝', () => {
    const fx = makeFixture()
    mkdirSync(join(fx.configDir, 'backups'), { recursive: true })
    symlinkSync(join(fx.configDir, 'backups'), fx.backupDir)
    const r = run(fx, ['start'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('重叠')
  })

  test('备份子目录与数据子目录同名时拒绝', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_BACKUP_SUBDIR: 'workspace' })
    const r = run(fx, ['start'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('子目录不能相同')
  })

  test('网络模式与重启策略枚举被校验', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_NETWORK_MODE: 'container:other' })
    expect(run(fx, ['start']).code).toBe(4)
    rewriteConfig(fx, { CCMAX_RESTART_POLICY: 'sometimes' })
    expect(run(fx, ['start']).code).toBe(4)
  })
})

describe('start', () => {
  test('创建并启动容器，带齐安全与运行时参数', () => {
    const fx = makeFixture()
    const r = run(fx, ['start'])
    expect(r.code).toBe(0)

    const create = dockerCalls(fx, 'create')[0]
    expect(create).toContain('--name ccmax-test')
    expect(create).toContain('--init')
    expect(create).toContain('--restart unless-stopped')
    expect(create).toContain('--stop-timeout 60')
    expect(create).toContain(`--user ${UID}:${GID}`)
    expect(create).toContain('--network bridge')
    expect(create).toContain('--publish 18081:18081')
    expect(create).toContain(`--volume ${realpathSync(fx.configDir)}:/config`)
    expect(create).toContain(`--volume ${realpathSync(fx.workspaceDir)}:/workspace`)
    expect(create).toContain(`--env-file ${realpathSync(fx.secretsPath)}`)
    expect(create).toContain('--env HOME=/workspace')
    expect(create).toContain('--env CLAUDE_CONFIG_DIR=/config')
    expect(create).toContain('--env SERVER_HOST=0.0.0.0')
    expect(create).toContain('--env SERVER_PORT=18081')
    expect(create).toContain('--security-opt no-new-privileges')
    expect(create).toContain('ccmax:test-1')
    expect(create).not.toContain('--privileged')
    expect(create).not.toContain('docker.sock')
    expect(create).not.toContain('--cap-add')
    expect(create).not.toContain('--pid')
    expect(create).not.toContain('--device')

    const record = containerRecord(fx, 'ccmax-test') as ContainerState
    expect(record.running).toBe(true)
    expect(record.health).toBe('healthy')
    expect(record.labels['ccmax.deploy.managed']).toBe('true')
    expect(record.labels['ccmax.deploy.spec.fingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(record.labels['ccmax.deploy.config.fingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(record.labels['ccmax.deploy.secrets.fingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(record.labels['ccmax.deploy.env.keys']).toBe('ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,CLAUDE_CONFIG_DIR,HOME,SERVER_HOST,SERVER_PORT')
    expect(r.stdout).toContain('start 完成')
  })

  test('已存在受管容器时拒绝重复 start（提示改用 update）', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const second = run(fx, ['start'])
    expect(second.code).toBe(7)
    expect(second.stderr).toContain('已存在受管容器')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('未受管同名容器默认拒绝（无任何变更）', () => {
    const fx = makeFixture()
    seedContainer(fx, 'ccmax-test')
    const denied = run(fx, ['start'])
    expect(denied.code).toBe(7)
    expect(denied.stderr).toContain('未受管容器')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('--takeover 先停写、备份，再 rename 旧容器并创建新容器', () => {
    const fx = makeFixture()
    writeFileSync(join(fx.configDir, 'settings.json'), '{"marker":"config"}\n')
    seedCompatibleUnmanaged(fx, 'ccmax-test')
    clearLog(fx)

    const r = run(fx, ['start', '--takeover'])
    expect(r.code).toBe(0)

    const log = dockerLog(fx).split('\n').filter(Boolean)
    const idxStop = log.findIndex((l) => l.startsWith('stop '))
    const idxRename = log.findIndex((l) => l.startsWith('rename '))
    const idxCreate = log.findIndex((l) => l.startsWith('create '))
    expect(idxStop).toBeGreaterThanOrEqual(0)
    expect(idxStop).toBeLessThan(idxRename)
    expect(idxRename).toBeLessThan(idxCreate)

    const renamed = containerNames(fx).filter((n) => n.startsWith('ccmax-test__unmanaged__'))
    expect(renamed).toHaveLength(1)
    // 旧容器被保留（未删除、已停止）；新容器是受管容器且在运行
    expect(containerRecord(fx, renamed[0])?.running).toBe(false)
    expect(containerRecord(fx, renamed[0])?.labels['ccmax.deploy.managed']).toBeUndefined()
    expect(containerRecord(fx, 'ccmax-test')?.labels['ccmax.deploy.managed']).toBe('true')
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    expect(dockerCalls(fx, 'rm')).toHaveLength(0)

    const archives = readdirSync(fx.backupDir).filter((f) => f.endsWith('.tar.gz'))
    expect(archives).toHaveLength(1)
    const listing = Bun.spawnSync(['tar', '-tzf', join(fx.backupDir, archives[0])]).stdout.toString()
    expect(listing).toContain('config/settings.json')
  })

  test('--takeover 对挂载目录不同的容器明确拒绝（不静默换 mount）', () => {
    const fx = makeFixture()
    seedContainer(fx, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/some/other/config', destination: '/config' },
        { type: 'bind', source: '/some/other/workspace', destination: '/workspace' },
      ],
    })
    clearLog(fx)
    const r = run(fx, ['start', '--takeover'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('挂载目录与当前配置不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('--takeover 对脚本未管理的额外挂载明确拒绝（不静默丢弃）', () => {
    const fx = makeFixture()
    seedCompatibleUnmanaged(fx, 'ccmax-test')
    writeFields(fx, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/extra/data', destination: '/extra' },
        { type: 'bind', source: realpathSync(fx.configDir), destination: '/config' },
        { type: 'bind', source: realpathSync(fx.workspaceDir), destination: '/workspace' },
      ],
    })
    clearLog(fx)
    const r = run(fx, ['start', '--takeover'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('未管理的挂载目标')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('--takeover 时 create 失败会恢复旧容器名称并重启旧实例', () => {
    const fx = makeFixture()
    seedCompatibleUnmanaged(fx, 'ccmax-test')
    clearLog(fx)
    const r = run(fx, ['start', '--takeover'], { fail: 'create' })
    expect(r.code).toBe(6)
    expect(containerNames(fx)).toContain('ccmax-test')
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    expect(containerNames(fx).some((n) => n.startsWith('ccmax-test__unmanaged__'))).toBe(false)
  })

  test('--takeover 时旧容器未能停止则中止，不 rename 也不 create', () => {
    const fx = makeFixture()
    seedCompatibleUnmanaged(fx, 'ccmax-test')
    clearLog(fx)
    const r = run(fx, ['start', '--takeover'], { fail: 'stop' })
    expect(r.code).toBe(6)
    expect(dockerCalls(fx, 'rename')).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)
  })

  test('健康检查失败时退出非零并保留现场，不删除容器', () => {
    const fx = makeFixture()
    const r = run(fx, ['start'], { health: 'unhealthy' })
    expect(r.code).toBe(8)
    expect(r.stderr).toContain('unhealthy')
    expect(containerNames(fx)).toContain('ccmax-test')
    expect(mutatingCalls(fx).some((c) => c.startsWith('rm '))).toBe(false)
  })

  test('镜像没有 healthcheck 时用 HTTP /health 验证，服务不就绪则失败', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_PORT: '1', CCMAX_CONTAINER_PORT: '1', CCMAX_HEALTH_TIMEOUT: '1' })
    const r = run(fx, ['start'], { health: 'none' })
    expect(r.code).toBe(8)
    expect(r.output).toContain('超时')
  })

  test('两个不同实例参数各自生效（bridge + host 网络）', () => {
    const bridge = makeFixture({ config: { CCMAX_CONTAINER_NAME: 'ccmax-a', CCMAX_PORT: '18081' } })
    expect(run(bridge, ['start']).code).toBe(0)
    const bridgeCreate = dockerCalls(bridge, 'create')[0]
    expect(bridgeCreate).toContain('--name ccmax-a')
    expect(bridgeCreate).toContain('--network bridge')
    expect(bridgeCreate).toContain('--publish 18081:18081')

    const host = makeFixture({
      config: {
        CCMAX_CONTAINER_NAME: 'ccmax-b',
        CCMAX_NETWORK_MODE: 'host',
        CCMAX_PORT: '19082',
        CCMAX_CONTAINER_PORT: '19082',
      },
    })
    expect(run(host, ['start']).code).toBe(0)
    const hostCreate = dockerCalls(host, 'create')[0]
    expect(hostCreate).toContain('--name ccmax-b')
    expect(hostCreate).toContain('--network host')
    expect(hostCreate).toContain('--env SERVER_PORT=19082')
    expect(hostCreate).not.toContain('--publish')
    expect(hostCreate).not.toContain('18081')
    expect(hostCreate).not.toBe(bridgeCreate)
  })

  test('dry-run 不产生任何变更调用', () => {
    const fx = makeFixture()
    const r = run(fx, ['start', '--dry-run'])
    expect(r.code).toBe(0)
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(r.stdout).toContain('--publish 18081:18081')
    expect(containerNames(fx)).toHaveLength(0)
  })
})

describe('status', () => {
  test('未创建时报告 absent 且不修改任何东西', () => {
    const fx = makeFixture()
    const r = run(fx, ['status'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('exists=false')
    expect(r.stdout).toContain('state=absent')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('非运行容器报告 nonrunning，且不泄漏密钥值', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFields(fx, 'ccmax-test', { running: false, health: 'none' })
    clearLog(fx)
    const r = run(fx, ['status'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('running=false')
    expect(r.stdout).toContain('state=nonrunning')
    expect(r.stdout).toContain('drift=false')
    expect(r.output).not.toContain(SECRET_VALUE)
  })

  test('指纹漂移被报告，且 status 不产生变更', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFields(fx, 'ccmax-test', { network: 'host', ports: [] })
    clearLog(fx)
    const r = run(fx, ['status'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('drift=true')
    expect(r.stdout).toContain('spec 指纹不符')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('缺少 spec 标签的容器被视为漂移（stale fingerprint）', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    const record = containerRecord(fx, 'ccmax-test') as ContainerState
    delete record.labels['ccmax.deploy.spec.fingerprint']
    writeFields(fx, 'ccmax-test', { labels: record.labels })
    const r = run(fx, ['status'])
    expect(r.stdout).toContain('drift=true')
    expect(r.stdout).toContain('缺少 ccmax.deploy.spec.fingerprint 标签')
  })

  test('密钥文件 mode 异常时 status 只报告不失败', () => {
    const fx = makeFixture({ secretsMode: 0o644 })
    const r = run(fx, ['status'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('mode_ok=false')
    expect(r.output).not.toContain(SECRET_VALUE)
  })

  test('docker daemon 不可达时 status 返回 docker 错误，而不是 absent 成功', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_DOCKER_BIN: 'ccmax-no-such-docker-binary' })
    const r = run(fx, ['status'])
    expect(r.code).toBe(6)
    expect(r.stdout).not.toContain('state=absent')
    expect(r.stderr).toContain('docker')
  })

  test('同名 tag 被重新打指时报告 image_id_drift', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const before = run(fx, ['status'])
    expect(before.stdout).toContain('image_id_drift=false')

    repointImage(fx, 'ccmax:test-1', 'sha256:image-repointed')
    const after = run(fx, ['status'])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain('image_id_drift=true')
  })
})

describe('update', () => {
  test('正常更新：停写、完整备份、保留旧容器、创建并启动新容器', () => {
    const fx = makeFixture()
    writeFileSync(join(fx.configDir, 'settings.json'), '{"marker":"config"}\n')
    writeFileSync(join(fx.workspaceDir, 'project.txt'), 'workspace data\n')
    expect(run(fx, ['start']).code).toBe(0)

    addImage(fx, 'ccmax:test-2')
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:test-2' })
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(0)

    const log = dockerLog(fx).split('\n').filter(Boolean)
    const idxStop = log.findIndex((l) => l.startsWith('stop '))
    const idxRename = log.findIndex((l) => l.startsWith('rename '))
    const idxCreate = log.findIndex((l) => l.startsWith('create '))
    const idxStart = log.findIndex((l) => l.startsWith('start '))
    expect(idxStop).toBeGreaterThanOrEqual(0)
    expect(idxStop).toBeLessThan(idxRename)
    expect(idxRename).toBeLessThan(idxCreate)
    expect(idxCreate).toBeLessThan(idxStart)
    expect(log[idxStop]).toContain('--time 60')

    const previous = containerNames(fx).filter((n) => n.startsWith('ccmax-test__previous__'))
    expect(previous).toHaveLength(1)
    expect(containerRecord(fx, previous[0])?.running).toBe(false)
    expect(containerRecord(fx, 'ccmax-test')?.image).toBe('ccmax:test-2')
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)

    expect(readFileSync(join(fx.backupDir, 'previous-container'), 'utf8').trim()).toBe(previous[0])

    const archives = readdirSync(fx.backupDir).filter((f) => f.endsWith('.tar.gz'))
    expect(archives).toHaveLength(1)
    const archivePath = join(fx.backupDir, archives[0])
    expect(statSync(archivePath).size).toBeGreaterThan(0)
    // 备份目录 0700、归档 0600：避免 tar 默认 umask 造成 world-readable secrets
    expect(statSync(fx.backupDir).mode & 0o777).toBe(0o700)
    expect(statSync(archivePath).mode & 0o777).toBe(0o600)
    const listing = Bun.spawnSync(['tar', '-tzf', archivePath]).stdout.toString()
    expect(listing).toContain('config/settings.json')
    expect(listing).toContain('workspace/project.txt')

    const meta = readFileSync(join(fx.backupDir, 'last-update.meta'), 'utf8')
    expect(meta).toContain(`previous_container=${previous[0]}`)
    expect(meta).not.toContain(SECRET_VALUE)
    expect(r.stdout).toContain('update 完成')
  })

  test('端口等结构参数变化默认拒绝（防止静默丢参数）', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    rewriteConfig(fx, { CCMAX_PORT: '19082' })
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('端口映射变更')
    expect(mutatingCalls(fx)).toHaveLength(0)

    const allowed = run(fx, ['update', '--allow-reconfigure'])
    expect(allowed.code).toBe(0)
    expect(containerRecord(fx, 'ccmax-test')?.ports[0].host).toBe(19082)
  })

  test('新配置缺少密钥键时拒绝（不会静默丢掉 secret）', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFileSync(fx.secretsPath, `ANTHROPIC_AUTH_TOKEN=${SECRET_VALUE}\n`)
    chmodSync(fx.secretsPath, 0o600)
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('缺少环境变量键: ANTHROPIC_BASE_URL')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('密钥值轮换（键集合不变）被允许，日志只出现哈希', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    const before = containerRecord(fx, 'ccmax-test') as ContainerState
    writeFileSync(fx.secretsPath, `ANTHROPIC_AUTH_TOKEN=rotated-${SECRET_VALUE}\nANTHROPIC_BASE_URL=https://example.invalid/anthropic\n`)
    chmodSync(fx.secretsPath, 0o600)
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(0)
    const after = containerRecord(fx, 'ccmax-test') as ContainerState
    expect(after.labels['ccmax.deploy.secrets.fingerprint']).not.toBe(before.labels['ccmax.deploy.secrets.fingerprint'])
    expect(r.output).not.toContain('rotated-')
    expect(r.output).not.toContain(SECRET_VALUE)
  })

  test('docker create 失败时恢复旧容器名称并重新启动旧实例', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['update'], { fail: 'create' })
    expect(r.code).toBe(6)
    expect(containerNames(fx).some((n) => n.startsWith('ccmax-test__previous__'))).toBe(false)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    expect(r.stderr).toContain('docker create 失败')
    expect(readdirSync(fx.backupDir).some((f) => f.endsWith('.tar.gz'))).toBe(true)
  })

  test('新容器启动失败时不自动回滚，保留旧容器与备份现场', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['update'], { fail: 'start' })
    expect(r.code).toBe(6)
    const previous = containerNames(fx).filter((n) => n.startsWith('ccmax-test__previous__'))
    expect(previous).toHaveLength(1)
    expect(containerRecord(fx, previous[0])?.running).toBe(false)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(false)
    expect(r.stderr).toContain('现场信息')
    expect(r.stderr).toContain('rollback --ack-data-compatible')
  })

  test('新容器健康检查失败时不自动回滚，退出码为健康检查错误', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['update'], { health: 'unhealthy' })
    expect(r.code).toBe(8)
    expect(containerNames(fx).some((n) => n.startsWith('ccmax-test__previous__'))).toBe(true)
    expect(containerRecord(fx, 'ccmax-test')?.health).toBe('unhealthy')
    expect(r.stderr).toContain('不自动回滚')
  })

  test('备份失败时拒绝继续，旧容器恢复运行且不创建新容器', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    mkdirSync(fx.backupDir, { recursive: true })
    chmodSync(fx.backupDir, 0o500)
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(6)
    expect(r.stderr).toContain('备份失败')
    expect(dockerCalls(fx, 'rename')).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    chmodSync(fx.backupDir, 0o700)
  })

  test('未受管容器不接受 update', () => {
    const fx = makeFixture()
    seedContainer(fx, 'ccmax-test')
    const r = run(fx, ['update'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('不是 ccmax 受管容器')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('指纹漂移时 update 默认拒绝，且已移除 --adopt 绕过开关', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFields(fx, 'ccmax-test', { user: '0:0' })
    clearLog(fx)
    const denied = run(fx, ['update'])
    expect(denied.code).toBe(7)
    expect(denied.stderr).toContain('不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)

    const removed = run(fx, ['update', '--adopt'])
    expect(removed.code).toBe(2)
    expect(removed.stderr).toContain('未知参数')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('挂载目录变化时 update 硬拒绝，--allow-reconfigure 也不能绕过', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFields(fx, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/moved/config', destination: '/config' },
        { type: 'bind', source: '/moved/workspace', destination: '/workspace' },
      ],
    })
    clearLog(fx)
    const denied = run(fx, ['update', '--allow-reconfigure'])
    expect(denied.code).toBe(7)
    expect(denied.stderr).toContain('挂载目录与当前配置不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('存在非 bind 或未管理的挂载时 update 明确拒绝（不静默丢弃）', () => {
    const volume = makeFixture()
    expect(run(volume, ['start']).code).toBe(0)
    writeFields(volume, 'ccmax-test', {
      mounts: [
        { type: 'volume', source: 'somevolume', destination: '/data' },
        { type: 'bind', source: realpathSync(volume.configDir), destination: '/config' },
        { type: 'bind', source: realpathSync(volume.workspaceDir), destination: '/workspace' },
      ],
    })
    clearLog(volume)
    const rv = run(volume, ['update'])
    expect(rv.code).toBe(7)
    expect(rv.stderr).toContain('不支持的挂载类型')
    expect(mutatingCalls(volume)).toHaveLength(0)

    const extra = makeFixture()
    expect(run(extra, ['start']).code).toBe(0)
    writeFields(extra, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/extra/data', destination: '/extra' },
        { type: 'bind', source: realpathSync(extra.configDir), destination: '/config' },
        { type: 'bind', source: realpathSync(extra.workspaceDir), destination: '/workspace' },
      ],
    })
    clearLog(extra)
    const re = run(extra, ['update'])
    expect(re.code).toBe(7)
    expect(re.stderr).toContain('未管理的挂载目标')
    expect(mutatingCalls(extra)).toHaveLength(0)
  })

  test('备份目录权限过宽时拒绝备份，旧容器恢复运行且不 rename', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    mkdirSync(fx.backupDir, { recursive: true })
    chmodSync(fx.backupDir, 0o755)
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(6)
    expect(r.stderr).toContain('备份目录权限过宽')
    expect(dockerCalls(fx, 'rename')).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
  })

  test('备份目录是符号链接时拒绝备份', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    const target = join(fx.root, 'backups-target-file')
    writeFileSync(target, 'not a directory\n')
    symlinkSync(target, fx.backupDir)
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(6)
    expect(r.stderr).toContain('符号链接')
    expect(dockerCalls(fx, 'rename')).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
  })

  test('同名 tag 被重新打指时 update 报告 tag 漂移', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    addImage(fx, 'ccmax:test-2')
    repointImage(fx, 'ccmax:test-1', 'sha256:image-repointed')
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('tag 漂移')
  })

  test('没有容器时 update 拒绝并提示用 start', () => {
    const fx = makeFixture()
    const r = run(fx, ['update'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('请使用 start')
  })

  test('update --dry-run 只输出计划，不产生变更调用与备份文件', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['update', '--dry-run'])
    expect(r.code).toBe(0)
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(r.stdout).toContain('备份归档')
    expect(existsSync(join(fx.backupDir, 'previous-container'))).toBe(false)
    expect(existsSync(fx.backupDir)).toBe(false)
  })
})

describe('rollback', () => {
  function prepared() {
    const fx = makeFixture()
    writeFileSync(join(fx.configDir, 'settings.json'), '{"marker":"config"}\n')
    writeFileSync(join(fx.workspaceDir, 'project.txt'), 'workspace data\n')
    expect(run(fx, ['start']).code).toBe(0)
    addImage(fx, 'ccmax:test-2')
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:test-2' })
    expect(run(fx, ['update']).code).toBe(0)
    clearLog(fx)
    return fx
  }

  test('缺少 --ack-data-compatible 时拒绝且不做任何变更', () => {
    const fx = prepared()
    const r = run(fx, ['rollback'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--ack-data-compatible')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回退到旧容器：当前容器停止并保留，旧容器恢复原名运行，数据目录不动', () => {
    const fx = prepared()
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(0)
    expect(containerRecord(fx, 'ccmax-test')?.image).toBe('ccmax:test-1')
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    const replaced = containerNames(fx).filter((n) => n.startsWith('ccmax-test__rollback-from__'))
    expect(replaced).toHaveLength(1)
    expect(containerRecord(fx, replaced[0])?.running).toBe(false)
    expect(readFileSync(join(fx.configDir, 'settings.json'), 'utf8')).toBe('{"marker":"config"}\n')
    expect(readFileSync(join(fx.workspaceDir, 'project.txt'), 'utf8')).toBe('workspace data\n')
    expect(r.stdout).toContain('rollback 完成')
  })

  test('缺少回滚记录时拒绝', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('没有可回滚的记录')
  })

  test('回滚目标不存在时拒绝', () => {
    const fx = prepared()
    const previous = readFileSync(join(fx.backupDir, 'previous-container'), 'utf8').trim()
    rmSync(containerDir(fx, previous), { recursive: true, force: true })
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('回滚目标容器不存在')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回滚目标指纹不符时默认拒绝，且校验发生在停止当前容器之前', () => {
    const fx = prepared()
    const previous = readFileSync(join(fx.backupDir, 'previous-container'), 'utf8').trim()
    writeFields(fx, previous, { user: '0:0' })
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('指纹不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
  })

  test('rollback --dry-run 不产生变更', () => {
    const fx = prepared()
    const r = run(fx, ['rollback', '--ack-data-compatible', '--dry-run'])
    expect(r.code).toBe(0)
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(r.stdout).toContain('不触碰')
  })

  test('回滚目标仍在运行时拒绝（避免两个 writer）', () => {
    const fx = prepared()
    const previous = readFileSync(join(fx.backupDir, 'previous-container'), 'utf8').trim()
    writeFields(fx, previous, { running: true })
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('仍在运行')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回滚指针指向非受管前缀的容器时拒绝（防启动任意容器）', () => {
    const fx = prepared()
    writeFileSync(join(fx.backupDir, 'previous-container'), 'some-arbitrary-container\n')
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('不属于受管前缀')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回滚指针记录的运行时目录不同时拒绝', () => {
    const fx = prepared()
    writeFileSync(join(fx.backupDir, 'previous-runtime'), '/some/other/runtime\n')
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('运行时目录')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回滚成功后指针被消费，第二次 rollback 被拒绝', () => {
    const fx = prepared()
    expect(run(fx, ['rollback', '--ack-data-compatible']).code).toBe(0)
    expect(existsSync(join(fx.backupDir, 'previous-container'))).toBe(false)
    clearLog(fx)
    const again = run(fx, ['rollback', '--ack-data-compatible'])
    expect(again.code).toBe(7)
    expect(again.stderr).toContain('没有可回滚的记录')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('回滚目标挂载目录与当前配置不一致时拒绝', () => {
    const fx = prepared()
    const previous = readFileSync(join(fx.backupDir, 'previous-container'), 'utf8').trim()
    writeFields(fx, previous, {
      mounts: [
        { type: 'bind', source: '/other/config', destination: '/config' },
        { type: 'bind', source: '/other/workspace', destination: '/workspace' },
      ],
    })
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('挂载目录与当前配置不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('当前容器挂载了不同数据目录时拒绝回滚', () => {
    const fx = prepared()
    writeFields(fx, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/other/config', destination: '/config' },
        { type: 'bind', source: '/other/workspace', destination: '/workspace' },
      ],
    })
    const r = run(fx, ['rollback', '--ack-data-compatible'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('挂载目录与当前配置不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })
})

describe('stop / 并发锁 / 信号', () => {
  test('stop 传递 --time 并保留容器', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['stop'])
    expect(r.code).toBe(0)
    expect(dockerCalls(fx, 'stop')[0]).toContain('--time 60')
    expect(containerNames(fx)).toContain('ccmax-test')
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(false)
    expect(dockerCalls(fx, 'rm')).toHaveLength(0)
    expect(r.stdout).toContain('容器保留')
  })

  test('stop 对不存在的容器是幂等的', () => {
    const fx = makeFixture()
    const r = run(fx, ['stop'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('无需停止')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('stop 拒绝未受管容器', () => {
    const fx = makeFixture()
    seedContainer(fx, 'ccmax-test')
    const r = run(fx, ['stop'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('不是受管容器')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('stop --dry-run 不停止容器', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)
    const r = run(fx, ['stop', '--dry-run'])
    expect(r.code).toBe(0)
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(containerRecord(fx, 'ccmax-test')?.running).toBe(true)
    expect(r.stdout).toContain('[dry-run] docker stop')
  })

  test('并发操作被 mkdir 锁挡住，且不会删除他人持有的锁', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, { sleepMs: 1500 }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')
    // 容器锁 + config 锁 + workspace 锁，共三把
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    const second = run(fx, ['update'])
    expect(second.code).toBe(5)
    expect(second.stderr).toContain('并发部署操作持有锁')
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('同一实例用不同配置文件仍然互斥（锁不依赖 config 路径）', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    const otherConfig = join(fx.root, 'deploy-other.env')
    writeFileSync(otherConfig, readFileSync(fx.configPath, 'utf8'))

    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, { sleepMs: 1500 }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')

    const second = run(fx, ['stop', '-c', otherConfig])
    expect(second.code).toBe(5)
    expect(second.stderr).toContain('并发部署操作持有锁')

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('收到 SIGTERM 时释放锁并以 143 退出', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    const proc = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, { sleepMs: 3000 }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    proc.kill('SIGTERM')
    await proc.exited
    expect(proc.exitCode).toBe(143)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })
})

describe('关键边界回归', () => {
  test('bridge 正常创建的双栈端口映射（IPv4+IPv6）不产生漂移', () => {
    const fx = makeFixture()
    // 真实 bridge 网络下 docker port 对同一容器端口会输出 0.0.0.0 与 [::] 两条映射
    const started = run(fx, ['start'])
    expect(started.code).toBe(0)

    const status = run(fx, ['status'])
    expect(status.code).toBe(0)
    // 端口按结构去重后只剩一条，指纹与 desired 一致
    expect(status.stdout).toContain('ports=18081:18081')
    expect(status.stdout).not.toContain('[::]')
    expect(status.stdout).toContain('drift=false')
  })

  test('docker healthcheck 处于 starting 时继续轮询直到 healthy', () => {
    const fx = makeFixture()
    const r = run(fx, ['start'], { health: 'starting', startPolls: 3 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('健康检查通过')
    expect(containerRecord(fx, 'ccmax-test')?.health).toBe('healthy')
  })

  test('容器一直停留在 starting 时按超时失败，而不是立刻判失败', () => {
    const fx = makeFixture()
    rewriteConfig(fx, { CCMAX_HEALTH_TIMEOUT: '1', CCMAX_HEALTH_INTERVAL: '0' })
    const r = run(fx, ['start'], { health: 'starting', startPolls: 100000 })
    expect(r.code).toBe(8)
    // 说明它轮询过（最后状态为 starting）而不是第一眼就把 starting 当成错误
    expect(r.stderr).toContain('最后状态: starting')
    expect(r.stderr).not.toContain('无法解析容器健康状态')
  })

  test('镜像自带 Dockerfile ENV 键（PATH/NODE_VERSION）不被要求出现在密钥文件里', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)

    const status = run(fx, ['status'])
    expect(status.stdout).toContain('env_keys_match_desired=true')
    expect(status.stdout).toContain('drift=false')

    // 未改配置的 update 不需要 --allow-reconfigure（镜像默认键不是部署方缺失的键）
    clearLog(fx)
    const r = run(fx, ['update'])
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('缺少环境变量键')

    // 记录的受管键集合里不应出现镜像默认键
    const record = containerRecord(fx, 'ccmax-test') as ContainerState
    expect(record.labels['ccmax.deploy.env.keys']).not.toContain('PATH')
    expect(record.labels['ccmax.deploy.env.keys']).not.toContain('NODE_VERSION')
  })

  test('status 在镜像 ENV 与脚本固定键重叠时仍匹配，但未知非镜像 override 必须 false', () => {
    // 真实 Dockerfile 会声明 HOME/CLAUDE_CONFIG_DIR/SERVER_HOST/SERVER_PORT，
    // 这些键同时出现在脚本注入的 desired 集合与镜像 Config.Env 里。
    // 若 status 拿剥掉镜像键后的 actual 去和未剥离的 desired 比，会把健康实例误报为不匹配。
    const imageEnv = [
      'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      'NODE_ENV=production',
      'BUN_INSTALL=/usr/local',
      'CC_HAHA_SKIP_DOTENV=1',
      'CC_HAHA_ROOT=/app',
      'HOME=/workspace',
      'CLAUDE_CONFIG_DIR=/config',
      'CLAUDE_H5_DIST_DIR=/app/desktop/dist',
      'SERVER_HOST=0.0.0.0',
      'SERVER_PORT=18081',
      'LANG=C.UTF-8',
      'LC_ALL=C.UTF-8',
      'DEBIAN_FRONTEND=noninteractive',
    ]
    const fx = makeFixture({ imageEnv })
    expect(run(fx, ['start']).code).toBe(0)

    const status = run(fx, ['status'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('managed=true')
    expect(status.stdout).toContain('drift=false')
    expect(status.stdout).toContain('env_keys_match_desired=true')

    clearLog(fx)
    const updated = run(fx, ['update'])
    expect(updated.code).toBe(0)
    expect(updated.stderr).not.toContain('缺少环境变量键')

    const record = containerRecord(fx, 'ccmax-test') as ContainerState
    writeFields(fx, 'ccmax-test', { env: [...record.env, 'UNKNOWN_OVERRIDE=injected'] })
    const drifted = run(fx, ['status'])
    expect(drifted.stdout).toContain('env_keys_match_desired=false')
    clearLog(fx)
    const refused = run(fx, ['update'])
    expect(refused.code).toBe(7)
    expect(refused.stderr).toContain('缺少环境变量键: UNKNOWN_OVERRIDE')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('共享任一数据目录的两个实例互斥（config 相同、workspace 不同）', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    // 第二个实例：不同容器名、不同 workspace/backup 子目录，但共用同一个 config 目录
    mkdirSync(join(fx.runtime, 'workspace-b'), { recursive: true })
    chmodSync(join(fx.runtime, 'workspace-b'), 0o700)
    const otherConfig = join(fx.root, 'deploy-b.env')
    const bConfig = {
      ...defaultConfig(fx),
      CCMAX_CONTAINER_NAME: 'ccmax-test-b',
      CCMAX_WORKSPACE_SUBDIR: 'workspace-b',
      CCMAX_BACKUP_SUBDIR: 'backups-b',
    }
    writeFileSync(otherConfig, `${Object.entries(bConfig).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
    // 实例 A 的配置不变
    expect(readFileSync(fx.configPath, 'utf8')).toContain('CCMAX_CONTAINER_NAME=ccmax-test')

    clearLog(fx)
    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, { sleepMs: 1500 }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')

    const second = run(fx, ['stop', '-c', otherConfig])
    expect(second.code).toBe(5)
    expect(second.stderr).toContain('并发部署操作持有锁')

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('config 是顶层符号链接时拒绝（tar 备份只会归档链接本身）', () => {
    const start = makeFixture({ configSymlink: true })
    const rs = run(start, ['start'])
    expect(rs.code).toBe(7)
    expect(rs.stderr).toContain('不能是符号链接')
    expect(mutatingCalls(start)).toHaveLength(0)

    const update = makeFixture({ workspaceSymlink: true })
    expect(run(update, ['start']).code).toBe(7)
    expect(mutatingCalls(update)).toHaveLength(0)
  })

  test('远程 DOCKER_HOST 被明确拒绝（本地 bind mount 不成立）', () => {
    const fx = makeFixture()
    const deniedStart = run(fx, ['start'], { dockerHost: 'tcp://remote.invalid:2375' })
    expect(deniedStart.code).toBe(7)
    expect(deniedStart.stderr).toContain('只支持本地')
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)

    const deniedStatus = run(fx, ['status'], { dockerHost: 'tcp://remote.invalid:2375' })
    expect(deniedStatus.code).toBe(7)
    expect(deniedStatus.stdout).not.toContain('state=absent')
  })

  test('当前 docker context 指向远端时拒绝（context 也是 endpoint 来源）', () => {
    const fx = makeFixture()
    const deniedStart = run(fx, ['start'], { dockerContextHost: 'tcp://remote.invalid:2376' })
    expect(deniedStart.code).toBe(7)
    expect(deniedStart.stderr).toContain('非本机')
    expect(mutatingCalls(fx)).toHaveLength(0)
    expect(dockerCalls(fx, 'create')).toHaveLength(0)

    const deniedStatus = run(fx, ['status'], { dockerContextHost: 'tcp://remote.invalid:2376' })
    expect(deniedStatus.code).toBe(7)
    expect(deniedStatus.stdout).not.toContain('state=absent')
  })

  test('本机 DOCKER_HOST 不能掩盖远端的 DOCKER_CONTEXT（context 覆盖 host）', () => {
    const fx = makeFixture()
    const r = run(fx, ['start'], {
      dockerHost: 'unix:///fake/local.sock',
      dockerContext: 'remote-alias',
      dockerContextHost: 'tcp://remote.invalid:2376',
    })
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('DOCKER_CONTEXT')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('显式本机 unix DOCKER_HOST 被接受，非绝对路径的 unix endpoint 被拒绝', () => {
    const fx = makeFixture()
    expect(run(fx, ['start', '--dry-run'], { dockerHost: 'unix:///fake/local.sock' }).code).toBe(0)

    const relative = run(fx, ['start', '--dry-run'], { dockerHost: 'unix://relative.sock' })
    expect(relative.code).toBe(7)
    expect(relative.stderr).toContain('unix:///')
  })

  test('docker context inspect 失败时 fail closed（非 dry-run）', () => {
    const fx = makeFixture()
    const r = run(fx, ['start'], { dockerContextFail: true })
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('fail closed')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('context endpoint 为空或 <no value> 时 fail closed（不猜平台默认本机）', () => {
    for (const host of ['', '<no value>']) {
      const fx = makeFixture()
      const r = run(fx, ['start'], { dockerContextHost: host })
      expect(r.code).toBe(7)
      expect(r.stderr).toContain('fail closed')
      expect(mutatingCalls(fx)).toHaveLength(0)
      expect(dockerCalls(fx, 'create')).toHaveLength(0)
    }

    // 非默认 context 返回空值同样拒绝。
    const ctx = makeFixture()
    const r = run(ctx, ['start'], { dockerContext: 'alias', dockerContextHost: '' })
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('DOCKER_CONTEXT')
    expect(mutatingCalls(ctx)).toHaveLength(0)
  })

  test('--dry-run 下 context 解析失败也必须拒绝，且不执行任何 daemon 查询或变更', () => {
    const fx = makeFixture()
    const r = run(fx, ['start', '--dry-run'], { dockerContextFail: true })
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('fail closed')
    // 只允许只读的 docker context inspect/show，绝不落到 container/image inspect 或变更命令。
    expect(dockerCalls(fx, 'inspect')).toHaveLength(0)
    expect(dockerCalls(fx, 'image')).toHaveLength(0)
    expect(mutatingCalls(fx)).toHaveLength(0)

    // 空 endpoint 的 --dry-run 也一样拒绝。
    const empty = makeFixture()
    const r2 = run(empty, ['start', '--dry-run'], { dockerContextHost: '' })
    expect(r2.code).toBe(7)
    expect(r2.stderr).toContain('fail closed')
    expect(dockerCalls(empty, 'inspect')).toHaveLength(0)
    expect(dockerCalls(empty, 'image')).toHaveLength(0)
  })

  test('--dry-run 允许无 docker 客户端的默认本机场景，但不放过已知远端', () => {
    const fx = makeFixture({ config: { CCMAX_DOCKER_BIN: 'ccmax-no-such-docker' } })
    const planned = run(fx, ['start', '--dry-run'])
    expect(planned.code).toBe(0)
    expect(planned.stdout).toContain('[dry-run]')

    expect(run(fx, ['start', '--dry-run'], { dockerHost: 'tcp://remote.invalid:2375' }).code).toBe(7)
    expect(run(fx, ['start', '--dry-run'], { dockerContext: 'remote-alias' }).code).toBe(7)
  })

  test('显式 DOCKER_CONTEXT=default 时 DOCKER_HOST 仍决定锁键（不同 socket 不互相阻塞）', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    // 进程 A 持有 socket A 的锁（endpoint=a.sock）。
    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, {
      sleepMs: 1500,
      dockerContext: 'default',
      dockerHost: 'unix:///fake/a.sock',
    }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    // 进程 B 用 socket B：不同 daemon，锁键不同，不应被判为并发冲突。
    const second = run(fx, ['stop'], { dockerContext: 'default', dockerHost: 'unix:///fake/b.sock' })
    expect(second.code).toBe(0)
    expect(second.stderr).not.toContain('并发部署操作持有锁')

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('同一 socket 的等价拼写命中同一把锁（拼写差异不能绕过并发互斥）', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    // 进程 A 用 unix:///fake/a.sock 持有并发锁。
    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, {
      sleepMs: 3000,
      dockerContext: 'default',
      dockerHost: 'unix:///fake/a.sock',
    }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    // 同一个 socket 的不同写法（重复斜杠、./ 段、.. 段、尾斜杠）必须命中同一把锁：锁键按
    // 归一化后的 socket 路径计算，否则「拼写不同的同一 daemon」会漏掉并发互斥，两个实例同时
    // 对同一份 bind mount 操作。DOCKER_CONTEXT=default 下锁键由 DOCKER_HOST 决定。
    for (const spelling of [
      'unix:////fake/a.sock',
      'unix:///fake//a.sock',
      'unix:///fake/./a.sock',
      'unix:///fake/b/../a.sock',
      'unix:///fake/a.sock/',
    ]) {
      const blocked = run(fx, ['stop'], { dockerContext: 'default', dockerHost: spelling })
      expect(blocked.code).toBe(5)
      expect(blocked.stderr).toContain('并发部署操作持有锁')
    }
    // 被锁拦住的进程不得触碰 daemon：日志里仍然只有进程 A 的一次 stop。
    expect(mutatingCalls(fx)).toHaveLength(1)
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('不同 context 别名指向同一本机 endpoint 时共享并发锁', async () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    const endpointHost = 'unix:///fake/shared.sock'
    const first = Bun.spawn(['bash', SERVICE, 'stop', '-c', fx.configPath], spawnOptions(fx, {
      sleepMs: 1500,
      dockerContext: 'alias-a',
      dockerContextHost: endpointHost,
    }))
    for (let i = 0; i < 200; i += 1) {
      if (dockerLog(fx).includes('stop ')) break
      await Bun.sleep(10)
    }
    expect(dockerLog(fx)).toContain('stop ')
    // 容器锁 + config 锁 + workspace 锁，共三把
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    const second = run(fx, ['stop'], { dockerContext: 'alias-b', dockerContextHost: endpointHost })
    expect(second.code).toBe(5)
    expect(second.stderr).toContain('并发部署操作持有锁')
    expect(readdirSync(fx.lockBase)).toHaveLength(3)

    await first.exited
    expect(first.exitCode).toBe(0)
    expect(readdirSync(fx.lockBase)).toHaveLength(0)
  })

  test('回滚指针与元数据以 0600 写入', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    addImage(fx, 'ccmax:test-2')
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:test-2' })
    expect(run(fx, ['update']).code).toBe(0)

    for (const name of ['previous-container', 'previous-runtime', 'last-update.meta']) {
      const path = join(fx.backupDir, name)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  test('选项只在对应命令上有效，跨命令使用报用法错误', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    clearLog(fx)

    for (const args of [
      ['update', '--takeover'],
      ['rollback', '--allow-reconfigure', '--ack-data-compatible'],
      ['start', '--allow-reconfigure'],
      ['status', '--ack-data-compatible'],
    ]) {
      const r = run(fx, args)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('只能用于')
    }
    expect(mutatingCalls(fx)).toHaveLength(0)
  })

  test('--allow-reconfigure 仍然不能绕过挂载目录变化', () => {
    const fx = makeFixture()
    expect(run(fx, ['start']).code).toBe(0)
    writeFields(fx, 'ccmax-test', {
      mounts: [
        { type: 'bind', source: '/elsewhere/config', destination: '/config' },
        { type: 'bind', source: '/elsewhere/workspace', destination: '/workspace' },
      ],
    })
    clearLog(fx)
    const r = run(fx, ['update', '--allow-reconfigure'])
    expect(r.code).toBe(7)
    expect(r.stderr).toContain('挂载目录与当前配置不一致')
    expect(mutatingCalls(fx)).toHaveLength(0)
  })
})

describe('密钥不外泄', () => {
  test('输出、假 docker 状态与备份元数据都不包含密钥值', () => {
    const fx = makeFixture()
    const outputs: string[] = []
    outputs.push(run(fx, ['start', '--dry-run']).output)
    outputs.push(run(fx, ['start']).output)
    outputs.push(run(fx, ['status']).output)
    addImage(fx, 'ccmax:test-2')
    rewriteConfig(fx, { CCMAX_IMAGE: 'ccmax:test-2' })
    outputs.push(run(fx, ['update']).output)
    outputs.push(run(fx, ['rollback', '--ack-data-compatible', '--dry-run']).output)

    for (const output of outputs) {
      expect(output).not.toContain(SECRET_VALUE)
    }

    expect(dockerLog(fx)).not.toContain(SECRET_VALUE)
    for (const file of allFixtureFiles(fx.state)) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET_VALUE)
    }

    expect(readFileSync(join(fx.backupDir, 'last-update.meta'), 'utf8')).not.toContain(SECRET_VALUE)
    const archive = readdirSync(fx.backupDir).filter((f) => f.endsWith('.tar.gz'))[0]
    const listing = Bun.spawnSync(['tar', '-tzf', join(fx.backupDir, archive)]).stdout.toString()
    expect(listing).not.toContain('secrets.env')
  })
})
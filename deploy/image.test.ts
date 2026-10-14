/**
 * deploy/ 镜像构建与导出工具的确定性测试。
 *
 * 本文件不连接 Docker 守护进程、不访问公网、不读取真实 HOME/~/.claude：
 *   - Dockerfile 与 Dockerfile.dockerignore 以静态契约 + 一个本地实现的
 *     dockerignore 匹配器校验（证明嵌套私有状态确实被排除、bin/ 确实被放行）；
 *   - build.sh / export.sh 在临时 Git 仓库中运行，并使用临时 PATH 上的假 docker；
 *   - 所有临时目录在结束时清理。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const DEPLOY_DIR = import.meta.dir
const REPO_ROOT = path.resolve(DEPLOY_DIR, '..')

/** 有 CLI 接口的脚本（支持 --help）。 */
const CLI_SCRIPTS = ['build.sh', 'export.sh', 'image-smoke.sh'] as const
/** 全部受本测试约束的 shell 文件，包含被 source 的库脚本。 */
const OWNED_SHELL_SCRIPTS = [...CLI_SCRIPTS, 'scripts/common.sh'] as const

/**
 * 敏感特征用拼接构造，避免测试文件自身命中这些特征（否则自检会误报）。
 * 这里的路径一律使用 POSIX 分隔符，因为构建环境是 Linux。
 */
const SLASH = String.fromCharCode(47)
const PRIVATE_ABSOLUTE_PREFIXES = [`${SLASH}Users${SLASH}`, `${SLASH}home${SLASH}`] as const
const CREDENTIAL_PATTERNS: RegExp[] = [
  new RegExp(`ANTHROPIC_AUTH_TOKEN\\\\s*=`),
  /\bsk-[A-Za-z0-9]{20,}/,
  new RegExp(['ssh', 'pass'].join('')),
  new RegExp(['StrictHostKey', 'Checking'].join('')),
]

function readDeployFile(name: string): string {
  return readFileSync(path.join(DEPLOY_DIR, name), 'utf8')
}

/** 去掉 Dockerfile 的整行注释，避免文档性说明被当成实际指令。 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

// ── 临时目录与清理 ───────────────────────────────────────────────────────────

const tempRoots: string[] = []

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempRoots.reverse()) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 假 docker：把调用参数记录到文件，并按 --format 返回可控输出 ──────────────
//
// 支持：
//   info / version                    —— 让 docker 可用性检查通过
//   buildx build --metadata-file PATH —— 写出 buildx 元数据（模拟 containerimage.digest）
//   buildx imagetools inspect         —— 返回基础镜像 digest
//   image inspect --format ...        —— 按 format 返回 Id / RepoDigests / Labels / 基础 digest
//   create / cp / rm -v               —— 用一个宿主目录当「假镜像文件系统」来模拟 docker cp
//   save --output                     —— 写出假归档内容

const FAKE_DOCKER_MARKER = 'ccmax-deploy-fake-docker'

const FAKE_DOCKER_SOURCE = `#!/usr/bin/env bash
# ${FAKE_DOCKER_MARKER}
# 仅用于确定性测试：不接触真实 Docker。
set -u
log="\${FAKE_DOCKER_LOG:-/dev/null}"
printf '%s\\n' "$*" >> "$log"

fmt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--format" ]; then fmt="$arg"; fi
  case "$arg" in
    --format=*) fmt="\${arg#--format=}" ;;
  esac
  prev="$arg"
done

case "\${1:-}" in
  info) exit 0 ;;
  version) printf 'Docker version 27.0.0, build fake\\n'; exit 0 ;;
  buildx)
    if [ "\${2:-}" = "imagetools" ]; then
      printf 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n'
      exit 0
    fi
    if [ "\${2:-}" = "build" ]; then
      meta=""
      prev=""
      for arg in "$@"; do
        if [ "$prev" = "--metadata-file" ]; then meta="$arg"; fi
        case "$arg" in
          --metadata-file=*) meta="\${arg#--metadata-file=}" ;;
        esac
        prev="$arg"
      done
      if [ -n "$meta" ]; then
        mkdir -p "$(dirname "$meta")"
        printf '{\\n  "containerimage.digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",\\n  "image.name": "ccmax-server-h5:fake"\\n}\\n' > "$meta"
      fi
      printf '[fake-docker] buildx ok\\n'
      exit 0
    fi
    exit 0 ;;
  image)
    if [ "\${2:-}" = "inspect" ]; then
      case "$fmt" in
        *"index .RepoDigests 0"*) printf 'fake.invalid/base@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\\n' ;;
        *"index .Config.Labels"*) printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\\n' ;;
        *Id*) printf 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\n' ;;
        *RepoDigests*) printf '[%s]\\n' '"ccmax-server-h5@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' ;;
        *Labels*) printf '%s\\n' '{"org.opencontainers.image.revision":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","org.opencontainers.image.version":"9.9.9-test","com.ccmax.source.dirty":"false","com.ccmax.agent-browser.version":"0.39.0"}' ;;
        *Created*) printf '2026-01-01T00:00:00Z\\n' ;;
        *Architecture*) printf 'amd64\\n' ;;
        *Os*) printf 'linux\\n' ;;
        *) printf '{}\\n' ;;
      esac
      exit 0
    fi
    exit 1 ;;
  create)
    printf 'fakecontainer0123456789\\n'
    exit 0 ;;
  cp)
    src="\${2:-}"
    dest="\${3:-}"
    rel="\${src#*:}"
    rel="\${rel#/}"
    fake_src="\${FAKE_DOCKER_FS_ROOT:-}/\${rel}"
    if [ ! -e "$fake_src" ]; then
      printf 'fake docker cp: 镜像内不存在 %s\\n' "$src" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$fake_src" "$dest"
    exit 0 ;;
  context)
    ctx_host="\${FAKE_DOCKER_CONTEXT_HOST:-}"
    ctx_fail="\${FAKE_DOCKER_CONTEXT_FAIL:-}"
    if [ "$fmt" != '{{.Endpoints.docker.Host}}' ]; then
      echo 'fake docker: 不支持的 context inspect --format' >&2
      exit 1
    fi
    if [ -n "$ctx_fail" ]; then
      echo 'fake docker: 注入 context inspect 失败' >&2
      exit 1
    fi
    if [ -n "$ctx_host" ]; then
      echo "$ctx_host"
    fi
    exit 0 ;;
  rm) exit 0 ;;
  save)
    out=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--output" ] || [ "$prev" = "-o" ]; then out="$arg"; fi
      case "$arg" in
        --output=*) out="\${arg#--output=}" ;;
      esac
      prev="$arg"
    done
    if [ -z "$out" ]; then printf 'fake docker save: 缺少输出参数\\n' >&2; exit 2; fi
    printf 'fake-image-archive-content\\n' > "$out"
    exit 0 ;;
esac
exit 0
`

function makeFakeDocker(root: string): { binDir: string; logFile: string } {
  const binDir = path.join(root, 'fake-bin')
  mkdirSync(binDir, { recursive: true })
  const dockerPath = path.join(binDir, 'docker')
  const logFile = path.join(root, 'docker-calls.log')
  writeFileSync(dockerPath, FAKE_DOCKER_SOURCE)
  chmodSync(dockerPath, 0o755)
  writeFileSync(logFile, '')
  return { binDir, logFile }
}

function readDockerCalls(logFile: string): string[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.length > 0)
}

/** 用宿主目录模拟「镜像内文件系统」，供假 docker cp 使用。 */
function makeFakeImageFs(root: string, files: Record<string, string>): string {
  const fsRoot = path.join(root, 'image-fs')
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(fsRoot, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return fsRoot
}

function fakeEnv(options: {
  binDir: string
  logFile: string
  fsRoot?: string
  /** 假 docker 的 context endpoint Host；默认给本机 unix socket（否则解析器会按 fail closed 拒绝空值）。 */
  contextHost?: string
}): Record<string, string> {
  return {
    PATH: `${options.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_DOCKER_LOG: options.logFile,
    FAKE_DOCKER_FS_ROOT: options.fsRoot ?? '',
    FAKE_DOCKER_CONTEXT_HOST: options.contextHost ?? 'unix:///var/run/docker.sock',
  }
}

// ── 临时 Git 仓库（含 deploy/ 副本）──────────────────────────────────────────

/**
 * 临时仓库刻意让根 package.json 与 desktop/package.json 的 version 不同：
 * build.sh 必须取 desktop 的产品版本（1.1.0），而不是根占位版本或 git describe。
 */
function makeTempRepo(): string {
  const dir = makeTempRoot('ccmax-deploy-repo-')
  cpSync(DEPLOY_DIR, path.join(dir, 'deploy'), { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'ccmax', version: '999.0.0-local', private: true }, null, 2)}\n`,
  )
  mkdirSync(path.join(dir, 'desktop'), { recursive: true })
  writeFileSync(
    path.join(dir, 'desktop', 'package.json'),
    `${JSON.stringify({ name: 'ccmax-desktop', version: '1.1.0', private: true }, null, 2)}\n`,
  )
  runGit(dir, ['init', '-q'])
  runGit(dir, ['add', '-A'])
  runGit(dir, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=deploy-test', 'commit', '-q', '-m', 'init'])
  return dir
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

// ── 进程执行工具 ─────────────────────────────────────────────────────────────

type RunResult = {
  status: number
  stdout: string
  stderr: string
}

function runScript(
  scriptPath: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): RunResult {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: options.cwd ?? path.dirname(scriptPath),
    env: {
      ...process.env,
      // 显式清空 Docker endpoint 覆盖：脚本拒绝非本机 daemon，测试必须 hermetic，
      // 不受开发机 DOCKER_HOST/DOCKER_CONTEXT 影响（需要时由 options.env 显式设置）。
      DOCKER_HOST: '',
      DOCKER_CONTEXT: '',
      ...(options.env ?? {}),
    },
    encoding: 'utf8',
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ── dockerignore 匹配器 ──────────────────────────────────────────────────────
//
// 复刻 Docker 的两条关键语义，用来证明「目录级白名单不足」这个论点：
//   1. `*` 不跨 `/`，`**` 跨任意层级；
//   2. 逐条匹配、最后命中者生效，且某条规则命中某个父目录时同样作用于其子孙。
// 这正是为什么「先放行 !src/ 再写死级排除」必须补上 `**/` 全层级规则。

type IgnoreRule = { negated: boolean; regex: RegExp; source: string }

function globToRegExp(pattern: string): RegExp {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${out}$`)
}

function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    let pattern = line
    let negated = false
    if (pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    }
    pattern = pattern.replace(/\/+$/, '')
    if (pattern.length === 0) continue
    rules.push({ negated, regex: globToRegExp(pattern), source: line })
  }
  return rules
}

function isExcluded(relPath: string, rules: IgnoreRule[]): boolean {
  const candidates = [relPath]
  const parts = relPath.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    candidates.push(parts.slice(0, i).join('/'))
  }
  let ignored = false
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.regex.test(candidate))) {
      ignored = !rule.negated
    }
  }
  return ignored
}

// ── Dockerfile 契约 ──────────────────────────────────────────────────────────

describe('deploy/Dockerfile 运行契约', () => {
  const dockerfile = readDeployFile('Dockerfile')

  test('是多阶段构建，且最终运行镜像以 UID/GID 1000 运行', () => {
    const stages = dockerfile.match(/^FROM\s+\S+\s+AS\s+\S+/gim) ?? []
    expect(stages.length).toBeGreaterThanOrEqual(3)
    expect(dockerfile).toContain('USER 1000:1000')
    const lastUserIndex = dockerfile.lastIndexOf('\nUSER ')
    const lastFromIndex = dockerfile.lastIndexOf('\nFROM ')
    expect(lastUserIndex).toBeGreaterThan(lastFromIndex)
  })

  test('工作目录与持久化路径符合部署契约', () => {
    expect(dockerfile).toContain('WORKDIR /workspace')
    expect(dockerfile).toContain('VOLUME ["/config", "/workspace"]')
    expect(dockerfile).toContain('EXPOSE 18081')
  })

  test('禁用自动 dotenv 并声明运行期环境，包含 APP_VERSION', () => {
    for (const assignment of [
      'CC_HAHA_SKIP_DOTENV=1',
      'CC_HAHA_ROOT=/app',
      'HOME=/workspace',
      'CLAUDE_CONFIG_DIR=/config',
      'CLAUDE_H5_DIST_DIR=/app/desktop/dist',
      'SERVER_HOST=0.0.0.0',
      'SERVER_PORT=18081',
      'APP_VERSION=',
    ]) {
      expect(dockerfile).toContain(assignment)
    }
  })

  test('HEALTHCHECK 读取运行期 SERVER_PORT 并要求 /health 返回 status=ok', () => {
    const lines = dockerfile.split('\n')
    const startIndex = lines.findIndex((line) => line.trimStart().startsWith('HEALTHCHECK'))
    expect(startIndex).toBeGreaterThan(-1)
    // HEALTHCHECK 用行续接写成两行，这里把续行合并后再断言。
    const collected: string[] = []
    for (let i = startIndex; i < lines.length; i += 1) {
      collected.push(lines[i]!)
      if (!lines[i]!.trimEnd().endsWith('\\')) break
    }
    const health = collected.join('\n')
    expect(health).toContain('${SERVER_PORT}')
    expect(health).toContain('/health')
    expect(health).toContain('status')
    expect(health).toContain('ok')
    // 归属到实际指令：注释里不能出现 HEALTHCHECK 冒充。
    expect(stripComments(dockerfile)).toContain('HEALTHCHECK')
  })

  test('依赖安装使用冻结锁文件，不在镜像内升级依赖', () => {
    const frozenInstalls = dockerfile.match(/bun install --frozen-lockfile/g) ?? []
    expect(frozenInstalls.length).toBeGreaterThanOrEqual(2)
    expect(dockerfile).not.toContain('bun install --no-frozen-lockfile')
    expect(dockerfile).not.toMatch(/bun update\b/)
  })

  test('原生依赖编译工具只安装在构建阶段，运行镜像保持无编译链', () => {
    const instructions = stripComments(dockerfile)
    expect(instructions).toContain('FROM os-base AS build-base')
    expect(instructions).toContain('FROM build-base AS root-deps')
    expect(instructions).toContain('FROM build-base AS web-build')
    expect(instructions).toContain('FROM os-base AS runtime')
    const buildStart = instructions.indexOf('FROM os-base AS build-base')
    const rootStart = instructions.indexOf('FROM build-base AS root-deps')
    const builder = instructions.slice(buildStart, rootStart)
    expect(builder).toContain('build-essential')
    expect(builder).toContain('test -x /usr/bin/make')
    expect(builder).toContain('test -x /usr/bin/g++')
    expect(builder).toContain('test -x /usr/bin/python3')
    expect(instructions.slice(0, buildStart)).not.toContain('build-essential')
    expect(instructions.slice(instructions.indexOf('FROM os-base AS runtime'))).not.toContain('build-essential')
  })

  test('web-build 阶段携带根 node_modules，供 H5 构建解析只在根锁文件声明的依赖', () => {
    // desktop 的 H5 构建会经相对导入进入仓库根 src/：ActiveSession.tsx →
    // AgentTeamsPlanCard.tsx → src/shared/teamPlan.ts，而 teamPlan.ts 依赖 zod/v4。
    // zod 只在根 package.json/bun.lock 声明，desktop 锁文件里没有，
    // 因此 web-build 必须复用 root-deps 的 node_modules，否则 vite 解析失败、H5 构建中断。
    const teamPlan = readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'teamPlan.ts'), 'utf8')
    expect(teamPlan).toContain("from 'zod/v4'")

    const lines = dockerfile.split('\n')
    const stageStart = lines.findIndex((line) => line.startsWith('FROM build-base AS web-build'))
    expect(stageStart).toBeGreaterThan(-1)
    let stageEnd = lines.length
    for (let i = stageStart + 1; i < lines.length; i += 1) {
      if (/^FROM\s/.test(lines[i]!)) {
        stageEnd = i
        break
      }
    }
    const stage = lines.slice(stageStart, stageEnd).join('\n')
    const copyIndex = stage.indexOf('COPY --from=root-deps /app/node_modules /app/node_modules')
    const buildIndex = stage.indexOf('bun run build')
    expect(copyIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    // 根依赖必须在 desktop 构建之前就位。
    expect(copyIndex).toBeLessThan(buildIndex)
  })

  test('运行镜像在构建期校验 runtime/ 文本导入目标，缺失即失败', () => {
    // src/server/api/computer-use.ts 用 `with { type: 'text' }` 静态导入这三个文件，
    // 服务器入口加载时即求值；缺失只会让运行期直接解析失败，因此构建期就要挡住。
    for (const required of [
      'test -f /app/runtime/win_helper.py',
      'test -f /app/runtime/win_cursor_badge.py',
      'test -f /app/runtime/requirements-win.txt',
    ]) {
      expect(dockerfile).toContain(required)
    }
  })

  test('系统工具下载使用官方 HTTPS 源并启用有限重试', () => {
    const instructions = stripComments(dockerfile)
    expect(instructions).toContain('s|http://deb.debian.org|https://deb.debian.org|g')
    expect(instructions).toContain('apt-get -o Acquire::Retries=3 update')
    expect(instructions).toContain('apt-get -o Acquire::Retries=3 install -y --no-install-recommends')
  })

  test('agent-browser 只安装显式锁定的精确版本', () => {
    expect(dockerfile).toContain('ARG AGENT_BROWSER_VERSION=0.39.0')
    expect(dockerfile).toContain('"agent-browser@${AGENT_BROWSER_VERSION}"')
    expect(dockerfile).not.toMatch(/agent-browser@latest/)
    expect(dockerfile).not.toMatch(/agent-browser@(?!\$\{)/)
    expect(dockerfile).not.toMatch(/npm (update|upgrade)/)
  })

  test('agent-browser 默认使用镜像内的系统 Chromium，不依赖用户浏览器缓存', () => {
    const instructions = stripComments(dockerfile)
    expect(instructions).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium')
    const smoke = readDeployFile('image-smoke.sh')
    expect(smoke).toContain('check_eq "AGENT_BROWSER_EXECUTABLE_PATH" "/usr/bin/chromium" "${AGENT_BROWSER_EXECUTABLE_PATH:-}"')
  })

  test('默认包含浏览器与诊断工具，且不扩大权限', () => {
    for (const tool of [
      'chromium',
      'curl',
      'wget',
      'ca-certificates',
      'iputils-ping',
      'dnsutils',
      'net-tools',
      'traceroute',
      'iproute2',
      'jq',
      'git',
      'python3',
      'fonts-liberation',
      'fonts-noto-cjk',
    ]) {
      expect(dockerfile).toContain(tool)
    }
    const instructions = stripComments(dockerfile)
    expect(instructions).not.toContain('--privileged')
    expect(instructions).not.toContain('docker.sock')
    expect(instructions).not.toMatch(/--remote-debugging-port/)
    expect(instructions).not.toMatch(/NET_ADMIN/)
    expect(instructions).not.toMatch(/^\s*CAP_ADD/m)
  })

  test('启动命令使用 --no-env-file 并直接加载仓库 preload 与服务入口', () => {
    const cmdLine = dockerfile.split('\n').filter((line) => line.startsWith('CMD ')).join('\n')
    expect(cmdLine).toContain('--no-env-file')
    expect(cmdLine).toContain('--preload')
    expect(cmdLine).toContain('/app/preload.ts')
    expect(cmdLine).toContain('/app/src/server/index.ts')
    expect(cmdLine).not.toContain('/workspace/')
  })

  test('chmod 覆盖 bin/ 与全部随镜像交付的操作脚本', () => {
    const chmodIndex = dockerfile.indexOf('chmod +x')
    expect(chmodIndex).toBeGreaterThan(-1)
    const chmodBlock = dockerfile.slice(chmodIndex, dockerfile.indexOf('test -x', chmodIndex))
    for (const target of [
      '/app/bin/ccmax',
      '/app/bin/claude-haha',
      '/app/deploy/service.sh',
      '/app/deploy/image-smoke.sh',
      '/app/deploy/scripts/common.sh',
      '/app/deploy/build.sh',
      '/app/deploy/export.sh',
    ]) {
      expect(chmodBlock).toContain(target)
    }
  })

  test('构建期生成镜像内工具清单（dpkg + 运行时版本 + 基础镜像引用）', () => {
    expect(dockerfile).toContain('dpkg-query')
    expect(dockerfile).toContain('/app/deploy/image-inventory.json')
    expect(dockerfile).toContain('--arg bunImage "${BUN_IMAGE}"')
    expect(dockerfile).toContain('--arg debianImage "${DEBIAN_IMAGE}"')
    expect(dockerfile).toContain('--arg arch "$(dpkg --print-architecture)"')
  })

  test('不复制 .env 或任何真实运行数据路径', () => {
    const copyLines = dockerfile
      .split('\n')
      .filter((line) => /^\s*COPY\s/i.test(line))
    expect(copyLines.length).toBeGreaterThan(0)
    for (const line of copyLines) {
      expect(line).not.toMatch(/\.env/)
      expect(line).not.toMatch(/(providers|sessionconfig|browserstates|sessions|transcripts)/i)
    }
  })

  test('镜像标签记录版本、提交、时间与工具身份', () => {
    for (const label of [
      'org.opencontainers.image.version',
      'org.opencontainers.image.revision',
      'org.opencontainers.image.created',
      'com.ccmax.source.dirty',
      'com.ccmax.agent-browser.version',
    ]) {
      expect(dockerfile).toContain(label)
    }
    expect(dockerfile).toContain('ARG CCMAX_VERSION')
    expect(dockerfile).toContain('ARG CCMAX_REVISION')
    expect(dockerfile).toContain('ARG CCMAX_BUILD_TIME')
  })

  test('feature 参数与仓库 CLI 保持一致，不引入分叉', () => {
    const cliSource = readFileSync(path.join(REPO_ROOT, 'bin', 'ccmax'), 'utf8')
    const features = (source: string) =>
      Array.from(source.matchAll(/--feature=([A-Z0-9_]+)/g)).map((match) => match[1]!)

    const cliFeatures = new Set(features(cliSource))
    expect(cliFeatures.has('TRANSCRIPT_CLASSIFIER')).toBe(true)
    expect(cliFeatures.has('LODESTONE')).toBe(true)

    for (const feature of features(dockerfile)) {
      expect(cliFeatures.has(feature)).toBe(true)
    }
  })
})

// ── dockerignore 白名单契约 ──────────────────────────────────────────────────

describe('deploy/Dockerfile.dockerignore 白名单', () => {
  const rawLines = readDeployFile('Dockerfile.dockerignore').split('\n')
  const patterns = rawLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const rules = parseIgnoreRules(rawLines.join('\n'))

  test('默认排除一切，再显式放行构建必需路径', () => {
    expect(patterns[0]).toBe('*')
    const allowances = patterns.filter((pattern) => pattern.startsWith('!'))
    expect(allowances.length).toBeGreaterThanOrEqual(10)
  })

  test('放行构建所需的最小集合（含 bin/ 与 runtime/）', () => {
    for (const required of [
      '!package.json',
      '!bun.lock',
      '!bunfig.toml',
      '!tsconfig.json',
      '!preload.ts',
      '!bin/',
      '!src/',
      '!stubs/',
      '!runtime/',
      '!adapters/',
      '!deploy/',
      '!desktop/',
    ]) {
      expect(patterns).toContain(required)
    }
  })

  test('H5 引用的公开图片被精确放行，其他文档与私有状态仍被排除', () => {
    const asset = 'docs/images/sponsors/aruhub-logo.png'
    const source = readFileSync(path.join(REPO_ROOT, 'desktop/src/pages/settings/ProviderSettings.tsx'), 'utf8')
    expect(source).toContain(`../../../../${asset}`)
    expect(existsSync(path.join(REPO_ROOT, asset))).toBe(true)
    expect(isExcluded(asset, rules)).toBe(false)
    for (const denied of [
      'docs/agents/upstream-removals.md',
      'docs/images/private.png',
      'docs/images/sponsors/other.png',
      'docs/images/sponsors/.env',
      'docs/images/sponsors/providers/account.json',
    ]) {
      expect({ path: denied, excluded: isExcluded(denied, rules) }).toEqual({ path: denied, excluded: true })
    }
    expect(patterns.filter((pattern) => pattern.startsWith('!docs'))).toEqual([`!${asset}`])
  })

  test('拒绝重新放行任何密钥或运行数据', () => {
    const allowances = patterns.filter((pattern) => pattern.startsWith('!'))
    for (const pattern of allowances) {
      expect(pattern).not.toMatch(/(^|\/)\.env/)
      expect(pattern).not.toMatch(/node_modules/)
      expect(pattern).not.toMatch(/(providers|sessionconfig|browserstates|credentials|\.pem|\.key|\.p12)/i)
      expect(pattern).not.toMatch(/^!desktop\/dist/)
    }
  })

  test('排除本地工具链与既有构建产物', () => {
    for (const required of ['**/node_modules', 'desktop/dist', 'desktop/electron-dist', 'desktop/build-artifacts']) {
      expect(patterns).toContain(required)
    }
  })

  test('不包含任何私有绝对路径', () => {
    for (const line of rawLines) {
      for (const prefix of PRIVATE_ABSOLUTE_PREFIXES) {
        expect(line).not.toContain(prefix)
      }
    }
  })

  test('放行集合确实覆盖 Dockerfile 依赖的入口，尤其是 bin/ccmax', () => {
    // 这是回归重点：漏掉 !bin/ 时 chmod +x /app/bin/ccmax 必然失败。
    expect(isExcluded('bin/ccmax', rules)).toBe(false)
    expect(isExcluded('bin/claude-haha', rules)).toBe(false)

    const dockerfile = readDeployFile('Dockerfile')
    expect(dockerfile).toContain('chmod +x')
    expect(dockerfile).toContain('/app/bin/ccmax')

    for (const required of [
      'package.json',
      'bun.lock',
      'bunfig.toml',
      'tsconfig.json',
      'preload.ts',
      'src/server/index.ts',
      'src/entrypoints/cli.tsx',
      'deploy/Dockerfile',
      'deploy/scripts/common.sh',
      'desktop/package.json',
      'desktop/bun.lock',
      'desktop/src/main.tsx',
      'adapters/wechat/a.ts',
      // stubs/ 通过 tsconfig `paths` 提供给 `color-diff-napi` / `@ant/claude-for-chrome-mcp`，
      // 因此必须随构建上下文进入镜像，否则 src/components/StructuredDiff/colorDiff.ts 解析失败。
      'stubs/color-diff-napi.ts',
      'stubs/ant-claude-for-chrome-mcp.ts',
      // runtime/ 是 src/server/api/computer-use.ts 的文本导入目标（服务器启动即求值），
      // 缺任何一个都不会在运行期「降级」，而是直接解析失败。
      'runtime/win_helper.py',
      'runtime/win_cursor_badge.py',
      'runtime/requirements-win.txt',
    ]) {
      expect({ path: required, excluded: isExcluded(required, rules) }).toEqual({
        path: required,
        excluded: false,
      })
    }
  })

  test('全层级私有状态被排除（目录级白名单不足，必须靠 **/ 规则）', () => {
    // 这些路径单独靠 `!src/`、`!desktop/`、`!adapters/` 会被顺带放行，
    // 因此必须由后面整段 `**/` 排除规则重新排掉。
    for (const privatePath of [
      '.env',
      'src/.env',
      'desktop/.env',
      'adapters/wechat/.env.local',
      'src/keys/client.pem',
      'desktop/certs/server.key',
      'src/credentials-prod.json',
      'adapters/wechat/secrets.json',
      'src/providers/openai.json',
      'src/sessionconfig/session.json',
      'adapters/wechat/sessions/a.json',
      'desktop/browserstates/state.json',
      'stubs/transcripts/t.json',
      'src/.claude/settings.json',
      '.claude/agent-memory/notes.md',
      'desktop/.agent-browser/state.json',
      'src/node_modules/pkg/index.js',
      'desktop/node_modules/pkg/index.js',
      'desktop/dist/index.html',
      'desktop/src-tauri/target/release/app',
    ]) {
      expect({ path: privatePath, excluded: isExcluded(privatePath, rules) }).toEqual({
        path: privatePath,
        excluded: true,
      })
    }
  })

  test('放行与排除的先后顺序正确（排除规则必须写在放行之后）', () => {
    const firstAllowanceIndex = patterns.findIndex((pattern) => pattern.startsWith('!'))
    const nestedEnvIndex = patterns.indexOf('**/.env')
    expect(firstAllowanceIndex).toBeGreaterThan(-1)
    expect(nestedEnvIndex).toBeGreaterThan(firstAllowanceIndex)
  })
})

// ── 脚本语法与用法 ───────────────────────────────────────────────────────────

describe('deploy 脚本语法与用法', () => {
  for (const script of OWNED_SHELL_SCRIPTS) {
    const scriptPath = path.join(DEPLOY_DIR, script)

    test(`${script} 通过 bash -n 语法检查且可执行`, () => {
      const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
      expect(syntax.status).toBe(0)
      const mode = statSync(scriptPath).mode
      expect(mode & 0o111).toBeGreaterThan(0)
    })
  }

  for (const script of CLI_SCRIPTS) {
    const scriptPath = path.join(DEPLOY_DIR, script)

    test(`${script} 的 --help 以 0 退出并打印用法`, () => {
      const result = runScript(scriptPath, ['--help'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('用法')
    })
  }

  test('build.sh 拒绝未知选项与非法版本号', () => {
    const buildScript = path.join(DEPLOY_DIR, 'build.sh')
    const unknown = runScript(buildScript, ['--definitely-not-an-option'])
    expect(unknown.status).not.toBe(0)

    const badVersion = runScript(buildScript, ['--agent-browser-ver', 'latest'])
    expect(badVersion.status).not.toBe(0)
    expect(badVersion.stderr).toContain('精确')

    const rangeVersion = runScript(buildScript, ['--agent-browser-ver', '^0.39.0'])
    expect(rangeVersion.status).not.toBe(0)

    const latestTag = runScript(buildScript, ['--tag', 'ccmax-server-h5:latest'])
    expect(latestTag.status).not.toBe(0)
    expect(latestTag.stderr).toContain('latest')
  })

  test('build.sh 拒绝低于 24 的 Node 主版本', () => {
    const buildScript = path.join(DEPLOY_DIR, 'build.sh')

    const tooOld = runScript(buildScript, ['--node-major', '18', '--dry-run'])
    expect(tooOld.status).not.toBe(0)
    expect(tooOld.stderr).toContain('Node 主版本必须 >= 24')

    const nonNumeric = runScript(buildScript, ['--node-major', 'v24', '--dry-run'])
    expect(nonNumeric.status).not.toBe(0)
    expect(nonNumeric.stderr).toContain('Node 主版本必须是数字')

    // 24 及以上通过该校验（后续是否继续取决于工作区是否干净，与本用例无关）。
    const accepted = runScript(buildScript, ['--node-major', '24', '--dry-run'])
    expect(accepted.stderr).not.toContain('Node 主版本')
  })

  test('export.sh 要求显式镜像并拒绝 latest', () => {
    const exportScript = path.join(DEPLOY_DIR, 'export.sh')
    const missing = runScript(exportScript, [])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('--image')

    const latest = runScript(exportScript, ['--image', 'ccmax-server-h5:latest'])
    expect(latest.status).not.toBe(0)
    expect(latest.stderr).toContain('latest')

    const bareLatest = runScript(exportScript, ['--image', 'latest'])
    expect(bareLatest.status).not.toBe(0)
  })

  test('image-smoke.sh 在没有 --allow-docker 时跳过且不失败', () => {
    const smokeScript = path.join(DEPLOY_DIR, 'image-smoke.sh')
    const skipped = runScript(smokeScript, ['--image', 'ccmax-server-h5:1.0.0-abcdef0'])
    expect(skipped.status).toBe(0)
    expect(skipped.stderr).toContain('跳过')

    const missingImage = runScript(smokeScript, ['--allow-docker'])
    expect(missingImage.status).not.toBe(0)
  })

  test('deploy/ 内不出现凭据、私有地址或私有绝对路径', () => {
    for (const script of [...OWNED_SHELL_SCRIPTS, 'Dockerfile', 'Dockerfile.dockerignore', 'image.test.ts']) {
      const text = readDeployFile(script)
      for (const prefix of PRIVATE_ABSOLUTE_PREFIXES) {
        expect(text).not.toContain(prefix)
      }
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(text).not.toMatch(pattern)
      }
    }
  })
})

// ── build.sh 在临时仓库中的行为 ──────────────────────────────────────────────

describe('build.sh 构建身份与源码状态', () => {
  test('干净工作区：dry-run 输出产品版本、amd64、--load 与元数据文件', () => {
    const repo = makeTempRepo()
    const result = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run'], { cwd: repo })

    expect(result.stderr).not.toContain('错误')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('--platform linux/amd64')
    expect(result.stderr).toContain('--load')
    expect(result.stderr).toContain('--metadata-file')
    expect(result.stdout).toContain('"dryRun": true')
    expect(result.stdout).toContain('"platform": "linux/amd64"')
    expect(result.stdout).toContain('"dirty": false')
    expect(result.stdout).toContain('"agentBrowserVersion": "0.39.0"')
    // 版本来自 desktop/package.json（产品版本），不是根占位版本，也不是 git describe。
    expect(result.stdout).toContain('"productVersion": "1.1.0"')
    expect(result.stdout).toContain('"versionSource": "desktop/package.json"')
    expect(result.stdout).toContain('"imageRef": "ccmax-server-h5:1.1.0-')
    expect(result.stdout).not.toContain('latest')
    expect(result.stdout).not.toContain('999.0.0-local')
    expect(existsSync(path.join(repo, 'artifacts'))).toBe(false)
  })

  test('从仓库外目录调用也能通过 git 身份检查', () => {
    const repo = makeTempRepo()
    const outside = makeTempRoot('ccmax-deploy-outside-')
    const result = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run'], { cwd: outside })

    expect(result.stderr).not.toContain('不是 Git')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"productVersion": "1.1.0"')
  })

  test('脏工作区默认拒绝构建，--allow-dirty 才继续并记录 dirty', () => {
    const repo = makeTempRepo()
    writeFileSync(path.join(repo, 'package.json'), '{"name":"ccmax","version":"999.0.0-local","private":true,"x":1}\n')

    const refused = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run'], { cwd: repo })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('未提交改动')

    const allowed = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run', '--allow-dirty'], { cwd: repo })
    expect(allowed.status).toBe(0)
    expect(allowed.stdout).toContain('"dirty": true')
  })

  test('实际构建路径使用假 docker：写元数据、加载后提取镜像内工具清单', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const fsRoot = makeFakeImageFs(makeTempRoot('ccmax-deploy-fs-'), {
      // 刻意用多行缩进 JSON，与真实镜像内 `jq -n` 的输出一致：
      // 验证把它原样嵌进 build-info.json 后仍是合法 JSON。
      'app/deploy/image-inventory.json': [
        '{',
        '  "schemaVersion": 1,',
        '  "runtimes": {',
        '    "bun": "1.3.14"',
        '  },',
        '  "dpkgPackages": []',
        '}',
        '',
      ].join('\n'),
    })

    const result = runScript(path.join(repo, 'deploy', 'build.sh'), ['--out', outDir], {
      cwd: repo,
      env: fakeEnv({ binDir, logFile, fsRoot }),
    })

    expect(result.status).toBe(0)

    const calls = readDockerCalls(logFile)
    const buildCall = calls.find((call) => call.startsWith('buildx build'))
    expect(buildCall).toBeDefined()
    expect(buildCall).toContain('--platform linux/amd64')
    expect(buildCall).toContain('--load')
    expect(buildCall).toContain('--file deploy/Dockerfile')
    expect(buildCall).toContain('--metadata-file')
    expect(buildCall).toContain('--build-arg CCMAX_VERSION=1.1.0')
    expect(buildCall).toContain('--build-arg CCMAX_DIRTY=false')
    expect(buildCall).not.toContain('--push')

    // 只读提取：create（不 start）+ cp + rm -v。
    const createCall = calls.find((call) => call.startsWith('create '))
    expect(createCall).toBeDefined()
    const cpCall = calls.find((call) => call.includes(':/app/deploy/image-inventory.json'))
    expect(cpCall).toBeDefined()
    expect(cpCall!.startsWith('cp ')).toBe(true)
    expect(calls.some((call) => call.startsWith('rm -v '))).toBe(true)
    expect(calls.some((call) => call.startsWith('run '))).toBe(false)

    const infoPath = path.join(outDir, 'build-info.json')
    expect(existsSync(infoPath)).toBe(true)
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, unknown>
    expect(info.imageId).toBe(
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    expect(info.loaded).toBe(true)
    expect(info.productVersion).toBe('1.1.0')
    expect(info.versionSource).toBe('desktop/package.json')
    expect(String(info.sourceRevision)).toMatch(/^[0-9a-f]{40}$/)
    expect(info.imageRevision).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(info.imageRevisionSource).toBe('image-label')
    expect(info.platform).toBe('linux/amd64')
    expect(info.dirty).toBe(false)
    expect(info.agentBrowserVersion).toBe('0.39.0')
    expect(String(info.imageRef)).toMatch(/^ccmax-server-h5:1\.1\.0-[0-9a-f]{7}$/)
    expect(existsSync(String(info.metadataFile))).toBe(true)
    expect(info.toolInventory).toEqual({
      schemaVersion: 1,
      runtimes: { bun: '1.3.14' },
      dpkgPackages: [],
    })
    // 不得用构建机的 bun 版本冒充镜像内容。
    expect(info.bunVersion).toBeUndefined()

    const baseImages = info.baseImages as Array<{ role: string; ref: string; digest: unknown }>
    expect(baseImages.map((entry) => entry.role)).toEqual(['bun', 'debian'])
    for (const entry of baseImages) {
      expect(String(entry.digest)).toMatch(/@sha256:[0-9a-f]{64}$/)
    }

    expect(readDeployFile('build.sh')).not.toContain('bun --version')
  })

  test('--no-load 不 inspect 本地标签，身份只取 buildx 元数据', () => {
    const repo = makeTempRepo()
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')

    const result = runScript(
      path.join(repo, 'deploy', 'build.sh'),
      [
        '--tag',
        'ccmax-server-h5:1.1.0-abcdef0',
        '--no-load',
        '--no-resolve-base-digests',
        '--out',
        outDir,
      ],
      { cwd: repo, env: fakeEnv({ binDir, logFile }) },
    )

    expect(result.status).toBe(0)
    const calls = readDockerCalls(logFile)
    const buildCall = calls.find((call) => call.startsWith('buildx build'))
    expect(buildCall).toContain('--tag ccmax-server-h5:1.1.0-abcdef0')
    expect(buildCall).toContain('--metadata-file')
    expect(buildCall).not.toContain('--load')

    // 核心回归：--no-load 下绝不 inspect 本地标签（否则会读到本地旧镜像），
    // 也绝不 create/cp —— 身份只来自 buildx --metadata-file。
    expect(calls.some((call) => call.startsWith('image inspect'))).toBe(false)
    expect(calls.some((call) => call.startsWith('create '))).toBe(false)
    expect(calls.some((call) => call.includes('ccmax-server-h5:1.1.0-abcdef0'))).toBe(true)

    const info = JSON.parse(readFileSync(path.join(outDir, 'build-info.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(info.imageRef).toBe('ccmax-server-h5:1.1.0-abcdef0')
    expect(info.loaded).toBe(false)
    expect(info.imageId).toBeNull()
    expect(info.imageDigest).toBe(
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(String(info.toolInventoryNote)).toContain('--no-load')
  })
})

// ── export.sh 导出与身份记录 ─────────────────────────────────────────────────

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const IMAGE_REF = 'ccmax-server-h5:1.1.0-abcdef0'
const BUNDLE_NAME = 'bundle-under-test'
/** 假 docker 对任何 inspect 返回的镜像 ID，用于断言归档/提取锁定到解析后的 ID。 */
const FAKE_IMAGE_ID = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function makeExportImageFs(root: string, options: { withReadme: boolean; commonSh?: string }): string {
  const files: Record<string, string> = {
    'app/deploy/service.sh': '#!/usr/bin/env bash\n# image copy of service.sh\n',
    'app/deploy/deploy.env.example': '# image copy of deploy.env.example\n',
    'app/deploy/image-smoke.sh': '#!/usr/bin/env bash\n# image copy of image-smoke.sh\n',
    'app/deploy/image-inventory.json':
      '{"schemaVersion":1,"note":"image copy of inventory","runtimes":{"bun":"1.3.14"}}\n',
    'app/deploy/scripts/common.sh':
      options.commonSh ?? '#!/usr/bin/env bash\n# image copy of common.sh\n',
  }
  if (options.withReadme) {
    files['app/deploy/README.md'] = '# image copy of deploy README\n'
  }
  return makeFakeImageFs(root, files)
}

describe('export.sh 导出、产品文件提取与身份记录', () => {
  test('从镜像只读提取产品文件，并生成覆盖归档与产品文件的校验和', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    // 让镜内 scripts/common.sh 与仓库工作区完全一致，用于验证 matchesWorkspace=true。
    const commonSh = readFileSync(path.join(repo, 'deploy', 'scripts', 'common.sh'), 'utf8')
    const fsRoot = makeExportImageFs(makeTempRoot('ccmax-deploy-fs-'), { withReadme: true, commonSh })

    const result = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env: fakeEnv({ binDir, logFile, fsRoot }) },
    )

    expect(result.stderr).not.toContain('错误')
    expect(result.status).toBe(0)

    const calls = readDockerCalls(logFile)
    expect(calls.some((call) => call.startsWith('save '))).toBe(true)
    const createCall = calls.find((call) => call.startsWith('create '))
    expect(createCall).toBeDefined()
    expect(calls.some((call) => call.startsWith('rm -v '))).toBe(true)
    // TOCTOU 回归：标签在 inspect 阶段先解析成镜像 ID，归档与临时容器都必须锁定该 ID。
    // 否则 tag 被重新指向时，归档内容与清单里记录的元数据会描述不同镜像。
    const saveCall = calls.find((call) => call.startsWith('save '))!
    expect(saveCall).toContain(FAKE_IMAGE_ID)
    expect(saveCall).not.toContain(IMAGE_REF)
    expect(createCall!.startsWith(`create ${FAKE_IMAGE_ID}`)).toBe(true)
    expect(createCall).not.toContain(IMAGE_REF)
    // 首次把标签解析成 ID 的 inspect 允许用标签；后续读取都应改用 ID。
    const inspectCalls = calls.filter((call) => call.startsWith('image inspect'))
    expect(inspectCalls[0]).toContain(IMAGE_REF)
    expect(inspectCalls.slice(1).every((call) => call.includes(FAKE_IMAGE_ID))).toBe(true)
    expect(calls.some((call) => call.startsWith('start '))).toBe(false)
    expect(calls.some((call) => call.startsWith('run '))).toBe(false)
    for (const imagePath of [
      '/app/deploy/service.sh',
      '/app/deploy/deploy.env.example',
      '/app/deploy/README.md',
      '/app/deploy/image-smoke.sh',
      '/app/deploy/scripts/common.sh',
      '/app/deploy/image-inventory.json',
    ]) {
      expect(calls.some((call) => call.includes(`:${imagePath}`))).toBe(true)
    }

    const bundleDir = path.join(outDir, BUNDLE_NAME)
    for (const rel of [
      'image.tar.gz',
      'SHA256SUMS',
      'manifest.json',
      'deploy/service.sh',
      'deploy/deploy.env.example',
      'deploy/README.md',
      'deploy/image-smoke.sh',
      'deploy/scripts/common.sh',
      'deploy/image-inventory.json',
    ]) {
      expect({ rel, exists: existsSync(path.join(bundleDir, rel)) }).toEqual({ rel, exists: true })
    }

    // 原子 temp 不得残留。
    expect(readdirSync(outDir).filter((entry) => entry.startsWith('.'))).toEqual([])

    const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as {
      image: { id: string; revision: string; revisionSource: string; version: string }
      exporter: { revision: string; dirty: boolean | string }
      artifacts: Array<{ path: string; sha256: string; bytes: number }>
      bundledFiles: Array<{
        path: string
        sha256: string
        imageSource: string
        workspaceSha256: string | null
        matchesWorkspace: boolean | null
      }>
      optionalFilesMissing: string[]
      extraction: { containerCleanup: string }
    }

    expect(manifest.image.id).toBe(
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    expect(manifest.image.version).toBe('9.9.9-test')
    expect(manifest.image.revision).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(manifest.image.revisionSource).toBe('image-label')
    expect(manifest.exporter.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.exporter.dirty).toBe(false)
    // 必须把「镜像 revision」与「导出机 revision」区分开，不能混为一个字段。
    expect(manifest.image.revision).not.toBe(manifest.exporter.revision)
    expect(manifest.extraction.containerCleanup).toBe('docker rm -v')
    expect(manifest.optionalFilesMissing).toEqual([])

    const archive = manifest.artifacts.find((entry) => entry.path === 'image.tar.gz')!
    expect(archive.sha256).toBe(sha256Of(path.join(bundleDir, 'image.tar.gz')))
    expect(archive.bytes).toBe(statSync(path.join(bundleDir, 'image.tar.gz')).size)

    const bundledPaths = manifest.bundledFiles.map((entry) => entry.path)
    expect(bundledPaths).toEqual([
      'deploy/service.sh',
      'deploy/deploy.env.example',
      'deploy/image-smoke.sh',
      'deploy/scripts/common.sh',
      'deploy/image-inventory.json',
      'deploy/README.md',
    ])
    for (const entry of manifest.bundledFiles) {
      const bundledPath = path.join(bundleDir, entry.path)
      expect(entry.sha256).toBe(sha256Of(bundledPath))
      expect(entry.imageSource.startsWith('/app/deploy/')).toBe(true)
      // 镜像里的副本必须真的被打包，而不是导出机的工作区文件；
      // scripts/common.sh 的镜内内容被刻意设成与工作区一致，用 matchesWorkspace 单独验证。
      if (entry.matchesWorkspace !== true) {
        expect(readFileSync(bundledPath, 'utf8')).toContain('image copy')
      }
    }
    const commonEntry = manifest.bundledFiles.find((entry) => entry.path === 'deploy/scripts/common.sh')!
    expect(commonEntry.matchesWorkspace).toBe(true)
    const serviceEntry = manifest.bundledFiles.find((entry) => entry.path === 'deploy/service.sh')!
    expect(serviceEntry.matchesWorkspace).toBe(false)

    // SHA256SUMS 覆盖归档与全部产品文件。
    const sums = readFileSync(path.join(bundleDir, 'SHA256SUMS'), 'utf8')
    expect(sums).toContain(archive.sha256)
    expect(sums).toContain('image.tar.gz')
    for (const entry of manifest.bundledFiles) {
      expect(sums).toContain(entry.sha256)
      expect(sums).toContain(entry.path)
    }
  })

  test('拒绝已存在的分包目录，并拒绝路径穿越的 --name', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const fsRoot = makeExportImageFs(makeTempRoot('ccmax-deploy-fs-'), { withReadme: true })
    const env = fakeEnv({ binDir, logFile, fsRoot })

    const traversal = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', '../escape'],
      { cwd: repo, env },
    )
    expect(traversal.status).not.toBe(0)
    expect(traversal.stderr).toContain('分包名')

    const nested = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', 'a/b'],
      { cwd: repo, env },
    )
    expect(nested.status).not.toBe(0)

    const first = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env },
    )
    expect(first.status).toBe(0)

    const second = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env },
    )
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('已存在')

    // 越界写入不得发生。
    expect(existsSync(path.join(outDir, '..', 'escape'))).toBe(false)
  })

  test('镜内缺少可选 README 时显式记录缺失，且失败时不留下临时目录', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    // 缺 README 只由「镜像文件系统」模拟：临时仓库必须保持干净，
    // 删除已跟踪文件会让工作区变脏，导出会被身份校验拒绝。
    const fsRoot = makeExportImageFs(makeTempRoot('ccmax-deploy-fs-'), { withReadme: false })

    const result = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env: fakeEnv({ binDir, logFile, fsRoot }) },
    )

    expect(result.status).toBe(0)
    const bundleDir = path.join(outDir, BUNDLE_NAME)
    const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as {
      optionalFilesMissing: string[]
      bundledFiles: Array<{ path: string }>
    }
    expect(manifest.optionalFilesMissing).toEqual(['deploy/README.md'])
    expect(manifest.bundledFiles.map((entry) => entry.path)).not.toContain('deploy/README.md')
    expect(existsSync(path.join(bundleDir, 'deploy', 'README.md'))).toBe(false)
    expect(callsContain(logFile, ':/app/deploy/README.md')).toBe(true)
  })

  test('缺少必需的镜像内产品文件时失败，并清掉临时目录与临时容器', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const fsRoot = makeFakeImageFs(makeTempRoot('ccmax-deploy-fs-'), {
      'app/deploy/service.sh': '#!/usr/bin/env bash\n',
      // 故意缺少 image-smoke.sh / common.sh / inventory
    })

    const result = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env: fakeEnv({ binDir, logFile, fsRoot }) },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('镜像内缺少必需的产品文件')
    expect(existsSync(path.join(outDir, BUNDLE_NAME))).toBe(false)
    const leftovers = existsSync(outDir)
      ? readdirSync(outDir).filter((entry) => entry.startsWith('.'))
      : []
    expect(leftovers).toEqual([])
    // 失败路径也必须清理临时容器。
    expect(callsContain(logFile, 'rm -v ')).toBe(true)
  })

  test('脏工作区默认拒绝导出，--allow-dirty 记录 exporter.dirty', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const fsRoot = makeExportImageFs(makeTempRoot('ccmax-deploy-fs-'), { withReadme: true })
    const env = fakeEnv({ binDir, logFile, fsRoot })

    writeFileSync(
      path.join(repo, 'deploy', 'build.sh'),
      `${readFileSync(path.join(repo, 'deploy', 'build.sh'), 'utf8')}\n# 本地未提交改动\n`,
    )

    const refused = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME],
      { cwd: repo, env },
    )
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('未提交改动')

    const allowed = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir, '--name', BUNDLE_NAME, '--allow-dirty'],
      { cwd: repo, env },
    )
    expect(allowed.status).toBe(0)

    const manifest = JSON.parse(
      readFileSync(path.join(outDir, BUNDLE_NAME, 'manifest.json'), 'utf8'),
    ) as { exporter: { dirty: boolean | string } }
    expect(manifest.exporter.dirty).toBe(true)
  })

  test('默认分包名由镜像引用规范化得到，且不含非法字符', () => {
    const repo = makeTempRepo()
    const outDir = path.join(makeTempRoot('ccmax-deploy-out-'), 'out')
    const { binDir, logFile } = makeFakeDocker(makeTempRoot('ccmax-deploy-fake-'))
    const fsRoot = makeExportImageFs(makeTempRoot('ccmax-deploy-fs-'), { withReadme: true })

    const result = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', IMAGE_REF, '--out', outDir],
      { cwd: repo, env: fakeEnv({ binDir, logFile, fsRoot }) },
    )

    expect(result.status).toBe(0)
    const entries = readdirSync(outDir).filter((entry) => !entry.startsWith('.'))
    expect(entries).toEqual(['ccmax-server-h5-1.1.0-abcdef0'])
    expect(existsSync(path.join(outDir, 'ccmax-server-h5-1.1.0-abcdef0', 'manifest.json'))).toBe(true)
  })
})

function callsContain(logFile: string, needle: string): boolean {
  return readDockerCalls(logFile).some((call) => call.includes(needle))
}

// ── Docker endpoint 本机边界 ─────────────────────────────────────────────────
//
// 这些用例证明：所有会接触 Docker 的入口（build / export / image-smoke）以及共享解析器
// 在任何 daemon 查询之前就拒绝非本机 endpoint，而不是先把命令发到远端 daemon。

describe('deploy 脚本拒绝非本机 Docker endpoint', () => {
  /** 用共享解析器跑一次 endpoint 校验；返回脚本结果。 */
  function runResolver(
    root: string,
    env: Record<string, string>,
    mode: 'inspect' | 'static' = 'inspect',
  ): RunResult {
    const scriptPath = path.join(root, `resolve-endpoint-${mode}.sh`)
    writeFileSync(
      scriptPath,
      `set -euo pipefail\n. "${path.join(DEPLOY_DIR, 'scripts', 'common.sh')}"\nrequire_local_docker_endpoint docker ${mode}\n`,
    )
    return runScript(scriptPath, [], { env })
  }

  test('共享解析器：接受本机 unix 绝对 socket，拒绝其它 endpoint 形式', () => {
    const root = makeTempRoot('ccmax-deploy-resolver-')
    const { binDir, logFile } = makeFakeDocker(root)
    const base = fakeEnv({ binDir, logFile })

    const explicit = runResolver(root, { ...base, DOCKER_HOST: 'unix:///var/run/docker.sock' })
    expect(explicit.status).toBe(0)
    expect(explicit.stdout).toContain('unix:///var/run/docker.sock')

    const current = runResolver(root, { ...base, FAKE_DOCKER_CONTEXT_HOST: 'unix:///tmp/fake.sock' })
    expect(current.status).toBe(0)
    expect(current.stdout).toContain('unix:///tmp/fake.sock')

    const remoteHost = runResolver(root, { ...base, DOCKER_HOST: 'tcp://remote.invalid:2375' })
    expect(remoteHost.status).not.toBe(0)
    expect(remoteHost.stderr).toContain('只支持本机')

    const relativeUnix = runResolver(root, { ...base, DOCKER_HOST: 'unix://relative.sock' })
    expect(relativeUnix.status).not.toBe(0)

    const npipe = runResolver(root, { ...base, FAKE_DOCKER_CONTEXT_HOST: 'npipe:////./pipe/docker_engine' })
    expect(npipe.status).not.toBe(0)
    expect(npipe.stderr).toContain('非本机')

    // 本机 DOCKER_HOST 不能掩盖远端的 context 别名。
    const aliasBypass = runResolver(root, {
      ...base,
      DOCKER_HOST: 'unix:///tmp/local.sock',
      DOCKER_CONTEXT: 'remote-alias',
      FAKE_DOCKER_CONTEXT_HOST: 'tcp://remote.invalid:2376',
    })
    expect(aliasBypass.status).not.toBe(0)
    expect(aliasBypass.stderr).toContain('DOCKER_CONTEXT')
  })

  test('共享解析器：context inspect 成功但 endpoint 为空或 <no value> 必须 fail closed', () => {
    const root = makeTempRoot('ccmax-deploy-resolver-empty-')
    const { binDir, logFile } = makeFakeDocker(root)
    const base = fakeEnv({ binDir, logFile })

    // 成功退出但没有任何输出：不能猜成「平台默认本机」。
    const empty = runResolver(root, { ...base, FAKE_DOCKER_CONTEXT_HOST: '' })
    expect(empty.status).not.toBe(0)
    expect(empty.stderr).toContain('fail closed')

    // docker 模板渲染出的无值占位同样不能当作本机。
    const noValue = runResolver(root, { ...base, FAKE_DOCKER_CONTEXT_HOST: '<no value>' })
    expect(noValue.status).not.toBe(0)
    expect(noValue.stderr).toContain('fail closed')

    // 非默认 context 空值也拒绝。
    const ctxEmpty = runResolver(root, {
      ...base,
      DOCKER_CONTEXT: 'alias',
      FAKE_DOCKER_CONTEXT_HOST: '<no value>',
    })
    expect(ctxEmpty.status).not.toBe(0)
    expect(ctxEmpty.stderr).toContain('DOCKER_CONTEXT')
  })

  test('共享解析器：static 模式不调用 Docker 可默认打印；inspect 模式无 docker 必须 fail closed', () => {
    const root = makeTempRoot('ccmax-deploy-resolver-static-')
    const { binDir, logFile } = makeFakeDocker(root)

    // build --dry-run：static 模式绝不调用 Docker，允许按默认本机场景打印。
    const staticNoDocker = runResolver(root, { PATH: '/bin' }, 'static')
    expect(staticNoDocker.status).toBe(0)
    expect(staticNoDocker.stdout).toContain('unix-default')

    // static 模式仍然拒绝无法验证的非默认 DOCKER_CONTEXT。
    const staticRemoteContext = runResolver(root, { PATH: '/bin', DOCKER_CONTEXT: 'remote-ctx' }, 'static')
    expect(staticRemoteContext.status).not.toBe(0)
    expect(staticRemoteContext.stderr).toContain('fail closed')

    // inspect 模式（真实构建/导出/冒烟路径）没有 docker 客户端时不能继续。
    const inspectNoDocker = runResolver(root, { PATH: '/bin' })
    expect(inspectNoDocker.status).not.toBe(0)
    expect(inspectNoDocker.stderr).toContain('fail closed')

    // inspect 模式：本机 socket 正常通过。
    const inspectLocal = runResolver(root, fakeEnv({ binDir, logFile }))
    expect(inspectLocal.status).toBe(0)
    expect(inspectLocal.stdout).toContain('unix:///var/run/docker.sock')
  })

  test('共享解析器：显式 DOCKER_CONTEXT=default 时解析当前 context，DOCKER_HOST 优先', () => {
    const root = makeTempRoot('ccmax-deploy-resolver-default-')
    const { binDir, logFile } = makeFakeDocker(root)
    const base = fakeEnv({ binDir, logFile })

    // default 视为「没有显式非默认 context」：解析当前 context 的实际 endpoint。
    const defaultContext = runResolver(root, { ...base, DOCKER_CONTEXT: 'default' })
    expect(defaultContext.status).toBe(0)
    expect(defaultContext.stdout).toContain('unix:///var/run/docker.sock')

    // 显式 default + DOCKER_HOST：DOCKER_HOST 决定 endpoint，锁键取决于该 socket，
    // 于是不同 socket 得到不同锁，不会被 default 折叠成同一把。
    const hostWins = runResolver(root, {
      ...base,
      DOCKER_CONTEXT: 'default',
      DOCKER_HOST: 'unix:///tmp/other.sock',
    })
    expect(hostWins.status).toBe(0)
    expect(hostWins.stdout).toContain('unix:///tmp/other.sock')

    // 无 docker + default context：仍按默认本机场景处理（default 不是「非默认」）。
    const noDockerDefault = runResolver(root, { PATH: '/bin', DOCKER_CONTEXT: 'default' }, 'static')
    expect(noDockerDefault.status).toBe(0)
    expect(noDockerDefault.stdout).toContain('unix-default')

    // 无 docker + 非默认 context：无法验证，fail closed。
    const noDockerRemoteContext = runResolver(root, { PATH: '/bin', DOCKER_CONTEXT: 'remote-ctx' })
    expect(noDockerRemoteContext.status).not.toBe(0)
    expect(noDockerRemoteContext.stderr).toContain('fail closed')
  })

  test('build.sh：当前 docker context 指向远端时拒绝，且不查询 daemon', () => {
    const repo = makeTempRepo()
    const root = makeTempRoot('ccmax-deploy-endpoint-build-')
    const { binDir, logFile } = makeFakeDocker(root)

    const result = runScript(path.join(repo, 'deploy', 'build.sh'), [], {
      cwd: repo,
      env: { ...fakeEnv({ binDir, logFile }), FAKE_DOCKER_CONTEXT_HOST: 'tcp://remote.invalid:2376' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('非本机')
    // 只允许只读的 docker context inspect；任何 daemon 查询（info / buildx / image）都不发生。
    const calls = readDockerCalls(logFile)
    expect(calls.every((line) => line.startsWith('context inspect'))).toBe(true)
    expect(calls.some((line) => /^(info|buildx|image)\b/.test(line))).toBe(false)
  })

  test('build.sh：dry-run 下远端 DOCKER_HOST 被拒绝，且不调用 Docker、不写文件', () => {
    const repo = makeTempRepo()
    const root = makeTempRoot('ccmax-deploy-endpoint-dry-')
    const { binDir, logFile } = makeFakeDocker(root)

    const result = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run'], {
      cwd: repo,
      env: { ...fakeEnv({ binDir, logFile }), DOCKER_HOST: 'tcp://remote.invalid:2375' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('只支持本机')
    expect(result.stdout).not.toContain('"dryRun"')
    expect(readDockerCalls(logFile)).toEqual([])
    expect(existsSync(path.join(repo, 'artifacts'))).toBe(false)
  })

  test('build.sh：dry-run 无法在不调用 Docker 时验证非默认 DOCKER_CONTEXT，直接拒绝', () => {
    const repo = makeTempRepo()

    const result = runScript(path.join(repo, 'deploy', 'build.sh'), ['--dry-run'], {
      cwd: repo,
      env: { DOCKER_CONTEXT: 'remote-ctx' },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('fail closed')
    expect(result.stdout).not.toContain('"dryRun"')
    expect(existsSync(path.join(repo, 'artifacts'))).toBe(false)
  })

  test('export.sh：DOCKER_CONTEXT 指向远端时拒绝，且不执行 docker save', () => {
    const repo = makeTempRepo()
    const root = makeTempRoot('ccmax-deploy-endpoint-export-')
    const { binDir, logFile } = makeFakeDocker(root)

    const result = runScript(
      path.join(repo, 'deploy', 'export.sh'),
      ['--image', 'ccmax-server-h5:1.1.0-abcdef0'],
      {
        cwd: repo,
        env: {
          ...fakeEnv({ binDir, logFile }),
          DOCKER_CONTEXT: 'remote-ctx',
          FAKE_DOCKER_CONTEXT_HOST: 'ssh://remote.invalid',
        },
      },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('非本机')
    expect(readDockerCalls(logFile).some((line) => line.startsWith('save'))).toBe(false)
    expect(existsSync(path.join(repo, 'artifacts'))).toBe(false)
  })

  test('image-smoke.sh：未传 --allow-docker 时跳过，即使 endpoint 指向远端', () => {
    const result = runScript(
      path.join(DEPLOY_DIR, 'image-smoke.sh'),
      ['--image', 'ccmax-server-h5:1.1.0-abcdef0'],
      { env: { DOCKER_HOST: 'tcp://remote.invalid:2375' } },
    )
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('跳过')
  })

  test('image-smoke.sh：--allow-docker 下远端 DOCKER_HOST 被拒绝，不执行 docker run', () => {
    const root = makeTempRoot('ccmax-deploy-endpoint-smoke-')
    const { binDir, logFile } = makeFakeDocker(root)

    const result = runScript(
      path.join(DEPLOY_DIR, 'image-smoke.sh'),
      ['--image', 'ccmax-server-h5:1.1.0-abcdef0', '--allow-docker'],
      { env: { ...fakeEnv({ binDir, logFile }), DOCKER_HOST: 'tcp://remote.invalid:2375' } },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('只支持本机')
    expect(readDockerCalls(logFile).some((line) => line.startsWith('run'))).toBe(false)
  })
})

// ── image-smoke.sh 隔离契约 ──────────────────────────────────────────────────

describe('image-smoke.sh 隔离与检查契约', () => {
  const smoke = readDeployFile('image-smoke.sh')
  const instructions = stripComments(smoke)

  test('用 docker tmpfs 提供 UID 1000 可写的 config/workspace，而不是宿主 bind mount', () => {
    expect(smoke).toContain('uid=1000,gid=1000')
    expect(smoke).toContain('--tmpfs "/config:uid=1000,gid=1000,mode=0755"')
    expect(smoke).toContain('--tmpfs "/workspace:uid=1000,gid=1000,mode=0755"')
    // 不再把宿主临时目录挂成 config/workspace。
    expect(smoke).not.toMatch(/type=bind,source=\$\{CONFIG_DIR\}/)
    expect(smoke).not.toMatch(/type=bind,source=\$\{WORKSPACE_DIR\}/)
    // 唯一的 bind mount 只能是冒烟脚本本身，且只读。
    const bindMounts = instructions.match(/type=bind,[^\s"]+/g) ?? []
    expect(bindMounts.length).toBe(1)
    expect(bindMounts[0]).toContain('source=${SMOKE_SCRIPT}')
    expect(instructions).toContain('target=/tmp/smoke.sh,readonly')
  })

  test('保持 --network none，不使用 privileged、不挂载 docker socket', () => {
    expect(instructions).toContain('--network none')
    expect(instructions).not.toContain('--privileged')
    expect(instructions).not.toContain('docker.sock')
    expect(instructions).not.toContain('--cap-add')
  })

  test('docker run 锁定解析后的镜像 ID，而不是浮动标签', () => {
    // 与 export.sh 相同的 TOCTOU 防护：启动容器前标签已被解析成镜像 ID。
    expect(smoke).toContain('"$IMAGE_ID" /tmp/smoke.sh')
    expect(smoke).not.toContain('"$IMAGE_REF" /tmp/smoke.sh')
  })

  test('检查真实 CLI 入口 --help，而不只是 --version', () => {
    expect(smoke).toContain('/app/bin/ccmax --help')
    expect(smoke).toContain("grep -q 'Usage'")
  })

  test('服务探针使用 bun --no-env-file，并校验 /health 的 JSON status=ok', () => {
    expect(smoke).toContain('bun --no-env-file --preload /app/preload.ts /app/src/server/index.ts')
    expect(smoke).toContain('"status"')
    expect(smoke).toContain('/health')
    expect(smoke).toContain('.env')
  })

  test('真实浏览器检查覆盖 open / snapshot / screenshot / close', () => {
    for (const subcommand of [' open ', ' snapshot', ' screenshot ', ' close']) {
      expect(smoke).toContain(`ab ${subcommand.trim()} `)
    }
    expect(smoke).toContain('agent-browser --session')
  })

  test('失败码原样透出，cleanup 不把失败吞成 0', () => {
    expect(smoke).toContain('smoke_status=$?')
    expect(smoke).toContain('exit "$smoke_status"')
    const cleanupBody = smoke.slice(smoke.indexOf('cleanup() {'), smoke.indexOf('trap cleanup EXIT'))
    expect(cleanupBody).toContain('exit "$status"')
  })

  test('不读取真实 HOME / ~/.claude，也不启动桌面应用', () => {
    expect(instructions).not.toContain('.claude')
    expect(instructions).not.toMatch(/\bHOME\b\s*=\s*["']?\//)
    expect(instructions).not.toMatch(/electron|npm run dev|vite\b/)
  })
})
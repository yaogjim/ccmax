# ccmax Docker 部署脚本

本目录是一套**只做本地操作**的容器工具链：把仓库源码构建成产品镜像，导出为可拷贝的分发包，再在目标宿主机上创建、更新、回退受管容器。所有脚本不推送、不上传、不连接任何远端服务器；`service.sh` 只操作本机 Docker daemon。

> **当前状态（候选，已完成真实镜像验收）**
> - 这套脚本已通过确定性合同测试与 Shell 语法检查，并在原生 `linux/amd64` 宿主机完成源码构建、隔离镜像冒烟及镜像导出校验。冒烟覆盖非 root 身份、Server 健康检查、H5 首页、CLI 入口、诊断工具和 agent-browser/Chromium 回环浏览器操作；没有调用真实模型。
> - 构建阶段为原生依赖提供编译工具，最终运行镜像不包含 `make`、`gcc` 或 `g++`。H5 使用的跨目录公开图片按文件精确放行，真实配置与运行数据仍不进入构建上下文。
> - ARM 上的 amd64 仿真曾在 Chromium 启动检测时报 SSE3 不受支持；原生 amd64 的成功验收不代表该仿真环境兼容。构建不会跳过浏览器启动检测。
> - 默认锁定版本为候选值：Node 主版本 `24`、`agent-browser` 精确锁定 `0.39.0`、目标平台 `linux/amd64`、基础镜像 `oven/bun:1.3.14` 与 `debian:bookworm-slim`。这些常量以脚本内的 `ARG` / 默认值为准。
> - 受管实例已实际验证 `start` 与 `update`：停写备份、保留旧容器、创建新容器和更新后健康检查均通过。`rollback` 的现有证据为确定性合同测试，尚未执行真实实例回滚或备份恢复演练；保留旧容器与归档不等于回退已实测。
> - 真实镜像验收不等于全部质量门禁或所有部署环境已通过。上线前仍需逐实例核查备份、网络、权限与回退条件；工作区未提交版本应保留源码快照和校验记录，不能冒充已发布版本。

---

## 1. 交付流水线：source → image → export → load → recreate

五个阶段各有唯一职责，产物沿链路单向传递：

| 阶段 | 工具 | 输入 | 输出 |
| --- | --- | --- | --- |
| source | Git 工作区 | 已提交的源码 | 可追溯的提交（revision）与版本号 |
| image | `deploy/build.sh` | 仓库根构建上下文 | 本地镜像（含标签、工具清单） |
| export | `deploy/export.sh` | 一个已存在的本地镜像 | `image.tar.gz` + 产品文件 + `SHA256SUMS` + `manifest.json` |
| load | 目标机 `docker load` | 分发包里的 `image.tar.gz` | 目标机本地镜像 |
| recreate | `deploy/service.sh` | 镜像 + `deploy.env` | 受管容器 |

**关键区别：`docker restart` 只会重启容器进程，不会替换镜像。**

- 容器在 `docker create` 时就把镜像「冻结」为自己的 rootfs；之后即使同名 tag 指向了新镜像，正在运行的容器仍然使用旧镜像。
- 要让新镜像生效，必须**重建容器**。`deploy/service.sh update` 的流程是停写 → 备份 → 重命名并保留旧容器 → 用新镜像创建新容器；无需先删除旧容器。
- 因此「我 `docker pull` 了新 tag」或「`docker restart` 了一下」都不等于升级。升级必须走 `service.sh update`（或 `start --takeover` / 人工重建）。

---

## 2. 前置要求

- Docker（含 `buildx`）；`service.sh` 与 `image-smoke.sh` 需要可连接的 Docker daemon。
- 执行镜像构建的平台需能构建并运行 `linux/amd64` 工具；目标宿主机建议同为 `linux/amd64`。Chromium 在构建期会执行真实启动检测；ARM 上的 amd64 仿真若报告 SSE3 不受支持，应更换符合要求的本地构建环境，而不是跳过检查或把失败当作镜像兼容性已通过。
- Bash 3.2 及以上。构建与导出脚本可在 macOS 使用；容器生命周期建议在本地 Linux Docker 宿主机执行，备份使用支持 `--numeric-owner` 的 tar。
- 默认安装系统 Chromium，并设置 `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`，让 `agent-browser` 直接使用镜像内浏览器，不依赖构建用户或运行用户的浏览器下载缓存。浏览器真实启动仍需镜像冒烟验证。
- 所有脚本按本地 Docker 宿主机设计：在任何 daemon 查询或变更之前，脚本只读 docker 客户端 context 元数据（`docker context inspect`），只接受**本机 unix socket**（`unix:///` 加绝对路径）。`DOCKER_HOST`、`DOCKER_CONTEXT` 或当前 current context（`docker context use` 切换的那个）任一指向前述之外的形式（`tcp://`、`ssh://`、`npipe://`、相对路径的 `unix:` 等）都会被明确拒绝；无法读取当前 context 时也拒绝（fail closed）。因为路径、权限、备份与镜像身份检查都针对执行脚本的机器。
- `deploy/build.sh --dry-run` 不调用 Docker：它只做静态检查，因此遇到已知的远端 `DOCKER_HOST` 会拒绝，而**非默认 `DOCKER_CONTEXT` 也无法在不调用 Docker 的前提下验证，同样直接拒绝**（取消该变量或改用本机默认 context 即可继续）。
- 导出与 `service.sh` 的校验和逻辑优先使用 `sha256sum`，否则回退 `openssl` / `shasum`。
- 健康探测需要宿主上有 `curl` 或 `wget` 之一（镜像内已包含两者；`service.sh` 在宿主机上执行）。

---

## 3. 目录布局示例（部署方自行创建）

脚本**不会自动创建**运行数据目录，缺失即失败。推荐布局（把 `/srv/ccmax-runtime` 换成你自己的绝对路径）：

```text
/srv/ccmax-runtime/            # 运行时根目录（绝对路径，必须已存在）
├── deploy.env                 # 部署配置（KEY=value，见第 6 节）
├── config/                    # -> 容器内 /config（mode 0700，属主 UID:GID 1000:1000）
├── workspace/                 # -> 容器内 /workspace（mode 0700，属主 UID:GID 1000:1000）
├── secrets.env                # 可选密钥文件（mode 0600，必须位于 config/workspace 之外）
└── backups/                   # 备份归档（脚本以 0700 创建目录、0600 写归档）
```

权限约定（`service.sh` 的校验以**容器运行用户**为准，而不是「你是 root 所以能写」）：

- `config/`、`workspace/` 必须对 `CCMAX_UID:CCMAX_GID` 可读写（上例中相对容器内是 `1000:1000`）。当宿主机上该 UID 与部署方当前用户不同时，要用 `chown` 把目录属主调整为对应 UID:GID。
- 备份目录必须与 `config/`、`workspace/` 分离（按真实路径比较，符号链接也算重叠）；备份目录若已存在，其 group/other 位必须为 0（即实际 mode 形如 `700`），否则拒绝写入；归档文件写为 `600`。
- **实际 UID/GID 可配置**：容器内默认 `1000:1000`，由部署配置 `CCMAX_UID` / `CCMAX_GID` 决定；改了它就必须同步调整 `config/`、`workspace/` 的属主。
- 若以 root 身份运行 `service.sh`，脚本仍然按目标 UID/GID 判断目录可用性；root 能写不代表容器内用户能写。root 相关行为以脚本实际校验为准（见上文与 `deploy/scripts/common.sh`）。

---

## 4. 快速开始（可复制示例）

以下示例是通用模板，请把路径、镜像名与端口替换为部署方环境的值。

### 4.1 构建镜像（先 dry-run 再实构）

```bash
# 只打印将执行的命令与构建信息，不调用 Docker、不写文件：
deploy/build.sh --dry-run

# 实际构建：默认 linux/amd64，构建后 --load 到本地镜像库，
# 版本取自 desktop/package.json，默认标签 <镜像名>:<产品版本>-<短提交>
deploy/build.sh
```

常用参数（与 `deploy/build.sh --help` 一致）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--tag TAG` | `<镜像名>:<版本>-<短提交>` | 显式镜像标签；拒绝 `latest` 与浮动引用 |
| `--image-name NAME` | `ccmax-server-h5` | 镜像名（必须小写） |
| `--platform PLATFORM` | `linux/amd64` | 目标平台 |
| `--out DIR` | `artifacts/deploy` | 构建信息输出目录（`build-info.json`、`buildx-metadata.json`） |
| `--agent-browser-ver V` | `0.39.0` | 精确三段版本号，禁止 `latest` / 范围 / 预发布 |
| `--node-major N` | `24` | Node 主版本 |
| `--bun-image IMAGE` | `oven/bun:1.3.14` | Bun 基础镜像 |
| `--debian-image IMAGE` | `debian:bookworm-slim` | Debian 基础镜像 |
| `--no-load` | 关 | 不执行 `--load`；此时身份只取 buildx 元数据，绝不 inspect 本地标签 |
| `--no-resolve-base-digests` | 关 | 离线时不解析基础镜像 digest |
| `--allow-dirty` | 关 | 允许工作区有未提交改动（构建信息记录 `dirty=true`） |
| `--dry-run` | 关 | 只打印，不调用 Docker、不写文件；此时无法验证非默认 `DOCKER_CONTEXT`，会直接拒绝 |

**脏工作区默认拒绝。** `build.sh` / `export.sh` 在工作区有未提交改动时会直接失败，以保证镜像身份可追溯；`--allow-dirty` 只为**开发预览**放开，并在构建信息 / 清单里记录 `dirty=true`。发布用途请先提交或清理改动。

构建信息写入 `--out` 目录的 `build-info.json`，包含 `imageRef`、`imageId`、`imageDigest`、`sourceRevision`、`imageRevision`（来自镜像标签）、`baseImages` 的 digest、以及从镜像内提取的工具清单 `toolInventory`。**不使用构建机的 bun 版本冒充镜像内容**：工具版本只来自镜像本身。

### 4.2 导出分发包

```bash
deploy/export.sh --image ccmax-server-h5:1.1.0-abcdef0 --out ./artifacts/deploy
```

- `--image REF` 必填，必须是镜像 ID（`sha256:...`）或精确标签；拒绝 `latest`。
- `--name NAME` 指定分包目录名（单层 `[A-Za-z0-9._-]`，拒绝路径穿越）；默认由镜像引用规范化得到。
- 已存在的分包目录会被拒绝覆盖。
- 从镜像内提取文件只用 `docker create` + `docker cp`（**容器从不 start**），并且只提取固定白名单；不会挂载宿主 `config`/`workspace`。

分发包内容：

```text
<out>/<name>/
├── image.tar.gz              # docker save 后 gzip 的镜像归档
├── SHA256SUMS                # 覆盖 image.tar.gz 与全部已打包产品文件
├── manifest.json             # 身份清单（见下）
└── deploy/
    ├── service.sh            # 镜像内那一版脚本（不是导出机工作区副本）
    ├── deploy.env.example
    ├── image-smoke.sh
    ├── scripts/common.sh
    ├── image-inventory.json  # 镜像构建期生成的工具清单
    └── README.md             # 可选：镜像里有才打包，否则在清单里显式记录缺失
```

`manifest.json` 的关键身份字段：

- `image.revision` = **构建该镜像那次提交**，取自镜像标签 `org.opencontainers.image.revision`（`revisionSource` 为 `image-label` 或 `missing-label`）。
- `exporter.revision` = **执行本次导出的仓库提交**。
- 两者可能不同，清单**分别记录**，用于发现「旧镜像配新脚本」这类偏差。`exporter.dirty` 记录导出时工作区是否脏。
- `bundledFiles[].imageSource` 记录每个产品文件在镜像内的绝对路径，`matchesWorkspace` 表示它与导出机工作区同名文件是否一致（`true` / `false` / `null`）。
- `optionalFilesMissing` 显式列出镜像内缺失的可选文件（例如 `deploy/README.md`），不静默忽略。

### 4.3 在目标机装载镜像

```bash
gzip -dc image.tar.gz | docker load
# 或：
docker load --input image.tar.gz
```

在装载前先运行 `sha256sum -c SHA256SUMS`（macOS 可用 `shasum -a 256 -c SHA256SUMS`），校验归档与产品文件完整性。装载后核对 `manifest.json` 中的 `image.id`：

```bash
image_id=$(jq -r '.image.id' manifest.json)
image_ref=$(jq -r '.image.ref' manifest.json)
docker image inspect --format '{{.Id}}' "$image_id"
# 按镜像 ID 导出的归档可能没有保留标签；核对 ID 后可明确恢复原标签：
docker tag "$image_id" "$image_ref"
```

配置中的 `CCMAX_IMAGE` 使用核对后的精确标签；不要仅凭同名标签判断装载了哪一版。

### 4.4 部署配置与首次启动

```bash
mkdir -p /srv/ccmax-runtime/{config,workspace,backups}
chmod 700 /srv/ccmax-runtime/config /srv/ccmax-runtime/workspace /srv/ccmax-runtime/backups
chown -R 1000:1000 /srv/ccmax-runtime/config /srv/ccmax-runtime/workspace

cp deploy/deploy.env.example /srv/ccmax-runtime/deploy.env
vi /srv/ccmax-runtime/deploy.env        # 至少设置 CCMAX_IMAGE 与 CCMAX_RUNTIME_DIR

# 先 dry-run 看计划，再实际执行：
deploy/service.sh start -c /srv/ccmax-runtime/deploy.env --dry-run
deploy/service.sh start -c /srv/ccmax-runtime/deploy.env
```

---

## 5. `deploy/service.sh`：容器生命周期

```text
deploy/service.sh <start|update|rollback|status|stop> [选项]

  -c, --config <路径>        部署配置文件（默认 $CCMAX_DEPLOY_CONFIG 或 $PWD/deploy.env）
  -n, --dry-run              只打印计划，不写数据、不创建/停止/重命名容器
      --takeover             允许 start 接管一个未受管的同名容器
      --allow-reconfigure    update 允许改变用户/网络/端口/环境变量键集合
      --ack-data-compatible  rollback 必填：人工确认回退后数据兼容
  -h, --help
```

命令语义：

- `start`：首次创建并启动受管容器。已存在**受管**容器时拒绝（请用 `update`）；已存在**未受管**同名容器时默认拒绝，只有显式 `--takeover` 才会接管。
- `update`：停写 → 完整备份 → 保留旧容器（重命名为 `...__previous__<时间>-<pid>`）→ 用新镜像创建新容器。**失败不会自动回滚数据**；`create` 失败会在新容器启动前恢复旧容器名称。
- `rollback`：回退到上一次 `update` 保留的旧容器，**必须显式传 `--ack-data-compatible`**。
- `status`：只读报告容器/配置/备份/指纹状态；需要可连接的 daemon。
- `stop`：停止容器（保留容器本身，不删除）。

退出码：`0` 成功 / `2` 用法 / `3` 配置 / `4` 校验 / `5` 并发锁 / `6` docker / `7` 拒绝 / `8` 健康检查。

### 5.1 安全语义（务必理解）

- **挂载结构不可变**：`/config` 与 `/workspace` 的源目录、挂载类型、挂载目标一旦部署就不能通过配置变更。检测到不一致时一律**拒绝**，必须人工迁移；**`--allow-reconfigure` 也不放开挂载**。脚本只管理 bind 到 `/config` 与 `/workspace` 的挂载，遇到其它挂载类型或目标会拒绝而不是静默丢弃。
- **`--takeover` 是受控接管**：先只读 preflight 校验兼容性，再停旧容器（确认 `running=false`）、完整备份，最后才 `rename` 保留旧容器。接管目标若与当前配置不兼容（会丢失参数/环境变量键）会被拒绝。
- **`rollback` 不恢复数据**：它只把旧容器换回运行 + 名称，**不会**把备份归档自动还原到 `config/`/`workspace/`。回退是否与当前数据兼容由人确认（`--ack-data-compatible`）；恢复数据需要人工操作备份归档。
- **新容器已经跑过就不会自动恢复**：无论 `update` 还是 `rollback`，只要新/回退容器已经启动并可能写入数据，健康检查失败时脚本**默认不自动回滚**，而是打印现场信息（当前容器、保留的旧容器、备份归档路径）并让你决定下一步。
- **漂移检测不可绕过**：容器被脚本之外的人改动（spec 指纹、录制 image id、环境变量键不一致）时，`update` / `rollback` 一律拒绝，不提供绕过开关。
- **并发锁**：按「解析后的**真实本机 endpoint** + 容器名」、「真实本机 endpoint + config 真实路径」与「真实本机 endpoint + workspace 真实路径」分别加锁，不依赖配置文件路径；共享任一数据目录的不同实例也会互斥。锁键用的是 endpoint 本身而不是 context 名字，因此同一个 daemon 的不同 context 别名会命中同一把锁，不能用来绕过同实例或共享目录的互斥。
- **备份**：以 `umask 077` 创建、`tar --numeric-owner` 打包，目录 `0700`、归档 `0600`；备份前会把已有回滚指针归档，避免覆盖后无法审计。

---

## 6. 部署配置 schema

`deploy.env` 由 `service.sh` **严格按 `KEY=value` 逐行解析，绝不 `source` / `eval`**。因此：

- 空行与 `#` 注释被忽略；其余每行必须是 `KEY=value`。
- 反引号、命令替换 `$(` 都是非法字符，直接报错。
- 键必须匹配 `[A-Z0-9_]`，且必须在白名单内；**未知键直接失败**，避免拼写错误被静默忽略。
- 路径参数不能包含 `:`、`,` 或换行，避免改变 Docker 挂载语义；镜像引用中的合法冒号不受此限制。
- `config/` 与 `workspace/` 必须是实际目录，顶层符号链接会被拒绝，以免备份只包含链接而不包含真实数据。

白名单键：`CCMAX_IMAGE`、`CCMAX_CONTAINER_NAME`、`CCMAX_RUNTIME_DIR`、`CCMAX_CONFIG_SUBDIR`、`CCMAX_WORKSPACE_SUBDIR`、`CCMAX_BACKUP_SUBDIR`、`CCMAX_PORT`、`CCMAX_CONTAINER_PORT`、`CCMAX_NETWORK_MODE`、`CCMAX_UID`、`CCMAX_GID`、`CCMAX_RESTART_POLICY`、`CCMAX_STOP_TIMEOUT`、`CCMAX_INIT`、`CCMAX_HEALTH_TIMEOUT`、`CCMAX_HEALTH_INTERVAL`、`CCMAX_SECRETS_FILE`、`CCMAX_NO_NEW_PRIVILEGES`、`CCMAX_DOCKER_BIN`、`CCMAX_LOCK_BASE`。

`CCMAX_IMAGE` 必填，必须是精确 tag 或 `@sha256:` digest；不接受 `latest` 或隐式 tag（`registry:port/repo` 这种只有端口冒号的写法会被拒绝，必须再带 `:tag`）。

### 6.1 密钥文件（`CCMAX_SECRETS_FILE`）

- 必须是绝对路径、普通文件、mode 严格 `0600`，且位于 `config`/`workspace` **之外**（否则会被备份并暴露给容器）。
- 内容为 Docker `--env-file` 兼容的 `KEY=value` 行。脚本会在内存中读取文件做格式、键集合和哈希校验，只把**文件路径**交给 Docker；不会输出变量值。
- 键名必须是 `[A-Za-z_][A-Za-z0-9_]*`，不允许重复键。
- **禁止受控变量**：密钥文件不得出现容器固定运行时变量与进程 bootstrap 变量——`HOME`、`CLAUDE_CONFIG_DIR`、`SERVER_HOST`、`SERVER_PORT`、`PATH`、`NODE_OPTIONS`、`BUN_OPTIONS`、`BUN_INSTALL`、`NODE_ENV`、`CC_HAHA_SKIP_DOTENV`、`CC_HAHA_ROOT`、`CLAUDE_H5_DIST_DIR`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`GLOBIGNORE`、`CDPATH`、`IFS`、`PWD`。允许它们会绕过挂载/端口校验或在容器内注入任意代码路径，脚本会明确报错。

容器固定注入（脚本掌控，密钥文件不能覆盖）：`HOME=/workspace`、`CLAUDE_CONFIG_DIR=/config`、`SERVER_HOST=0.0.0.0`、`SERVER_PORT=<CCMAX_CONTAINER_PORT>`。

---

## 7. 网络与端口

- `CCMAX_NETWORK_MODE` 默认 `bridge`：容器通过 `--publish <CCMAX_PORT>:<CCMAX_CONTAINER_PORT>` 暴露端口。**docker 默认把发布端口绑定到宿主所有网卡（`0.0.0.0`）**，局域网内可直达；请确认防火墙，或自行规划绑定地址与访问控制。端口冲突 / 暴露面由部署方负责。
- `host` 模式：不创建端口映射，容器直接使用宿主机网络栈，`SERVER_PORT` 即宿主端口。
- 健康探测：优先等待镜像 `HEALTHCHECK` 变为 `healthy`；镜像没有 HEALTHCHECK 时，脚本用 HTTP `GET http://127.0.0.1:<实际映射端口>/health` 明确验证就绪（**纯 TCP 连通不算就绪**）。容器 `running=false` 直接判定未就绪。
- 镜像内 `SERVER_HOST=0.0.0.0` 表示接受外部连接；这**不会**自动完成 H5 授权、TLS 或反向代理配置。

---

## 8. `deploy/image-smoke.sh`：隔离冒烟检查

```bash
deploy/image-smoke.sh --image <REF> --allow-docker
```

- **可选、手动**，不属于任何必需 CI 车道；未传 `--allow-docker` 时只打印跳过原因并以 `0` 退出。
- 在一个 `--network none` 的临时容器里运行：`/config` 与 `/workspace` 是 `docker --tmpfs`（`uid=1000,gid=1000`）**临时状态**，不 bind mount 宿主目录；只额外只读挂载冒烟脚本本身；不挂载 Docker socket、不使用 `--privileged`、不授予额外 capability。
- 检查内容：运行身份（uid/gid/cwd/HOME/端口）、目录可写性、路径与产物、镜像内工具清单、真实 CLI 入口 `/app/bin/ccmax --help`、禁用隐式 dotenv、服务启动探针（`bun --no-env-file` + `/health` 的 JSON `status=ok`）、H5 首页、以及真实浏览器动作（`agent-browser` open/snapshot/screenshot/close，仅本地回环）。

**它能证明什么，不能证明什么：**

`image-smoke.sh` 只验证「镜像内的进程能起来、`/health` 返回 `status=ok`、H5 首页是 HTML」。它**不等于**以下任何一项已通过验证：

- 聊天 / WebSocket 主流程；
- 鉴权（`401`/`403` 行为）；
- H5 已启用；
- token 与允许来源（Origin）配置正确。

按 `docs/internals/server.md` 的说明，`/health` 始终公开，**不代表其它接口已通过认证**。这些边界需要额外的、显式授权的端到端验证。

---

## 9. 文档链接（以及分发包内没有 docs）

设计语义与运行边界以仓库文档为准：

- [手机 H5 与 IM 接力](../docs/desktop/remote.md) —— H5 开启、令牌/允许来源、访问主机与端口、公网隧道的风险边界。
- [本地 Server 与 API](../docs/internals/server.md) —— 启动参数、`/health` 语义、访问控制矩阵、REST 与 WebSocket 范围、反向代理清单。

> **注意：分发包内没有 `docs/`。** `deploy/export.sh` 只从镜像提取固定白名单里的产品文件，`docs/` 不在其中，上面的相对链接在分发包里会失效。请以**仓库内**的这份指南和上述文档为真值源；分发包只用于装载镜像与运行脚本。

---

## 10. 本目录脚本速查

| 脚本 | 作用 | 是否调用 Docker |
| --- | --- | --- |
| `deploy/build.sh` | 构建产品镜像（默认 `linux/amd64`，`--load`） | 是（需 daemon；dry-run 除外） |
| `deploy/export.sh` | 导出镜像归档 + 产品文件 + 校验和 + 身份清单 | 是（需 daemon） |
| `deploy/service.sh` | 容器生命周期（start/update/rollback/status/stop） | 是（需 daemon；dry-run 不写数据） |
| `deploy/image-smoke.sh` | 隔离冒烟检查（需 `--allow-docker`） | 是（需 daemon） |
| `deploy/scripts/common.sh` | 被 source 的共享函数库 | 否 |
| `deploy/Dockerfile` | 多阶段镜像定义 | — |
| `deploy/Dockerfile.dockerignore` | 构建上下文白名单（默认排除一切） | — |

通用原则：**所有输入校验都发生在任何 docker 变更操作之前**；进入任何 daemon 查询或变更前，先只读确认 docker endpoint 是本机（`unix:///` 绝对 socket）；`--dry-run` 不写任何数据、不创建/停止/重命名任何容器（`build.sh --dry-run` 也不调用 Docker）。

---

## 11. 尚未验证 / 已知限制

- **完整实机闭环尚未验收**：本候选仍需在真实 Docker 宿主机完成构建→导出→装载→重建；确定性假 Docker 测试、构建成功与单容器隔离冒烟各自只证明对应阶段，不能互相替代。
- **未用真实镜像验证**：`0.39.0` 等版本常量为候选锁定值，尚未用真实产出的镜像复核。
- **`image-smoke.sh` 覆盖面有限**：只覆盖进程启动、`/health` 与 H5 首页，不含聊天、鉴权、token/Origin（见第 8 节）。
- **`service.sh` / 镜像内脚本的镜像内一致性**：`export.sh` 会校验提取文件与工作区是否一致并记录在清单，但分发包里的脚本始终是「镜像里那一版」，与导出机工作区可能不同。
- **未宣称生产就绪**：在完成真实镜像验证与实机闭环之前，请勿把本流程用于生产发布。
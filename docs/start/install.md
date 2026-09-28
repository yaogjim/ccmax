---
title: 下载与安装
nav_title: 下载与安装
description: macOS、Windows、Linux 三个平台的安装包，以及系统拦截时的处理办法。
order: 1
---

# 下载与安装

装完就能用，不需要另外安装 Node.js、Python 或 Claude Code——CLI 内核和文件搜索用的 ripgrep 都已经打进安装包里了。

## 挑对安装包

所有安装包都在 [GitHub Releases](https://github.com/yaogjim/ccmax/releases/latest)，按系统和 CPU 架构选一个：

| 你的系统 | 下载 |
|---|---|
| macOS，M 系列芯片 | `ccmax-<版本>-mac-arm64.dmg` |
| macOS，Intel 芯片 | `ccmax-<版本>-mac-x64.dmg` |
| Windows x64 | `ccmax-<版本>-win-x64.exe` |
| Windows ARM64 | `ccmax-<版本>-win-arm64.exe` |
| Linux x64 | `ccmax-<版本>-linux-x86_64.AppImage` 或 `-linux-amd64.deb` |
| Linux ARM64 | `ccmax-<版本>-linux-arm64.AppImage` 或 `-linux-arm64.deb` |

不确定自己是哪种架构：macOS 看「关于本机」里的芯片型号，Windows 看「设置 → 系统 → 系统信息」里的系统类型。别只凭机器牌子猜。

`.blockmap` 和 `latest*.yml` 是应用自动更新用的，不用手动下载。

## macOS

1. 双击 DMG。
2. 把 ccmax 拖进「应用程序」。
3. 从「应用程序」打开。

### 如果 macOS 拦截首次打开

自签名构建没有 Apple 公证。确认安装包来源后，从「应用程序」中对 ccmax 点右键选择「打开」；如果系统提供「系统设置 → 隐私与安全性 → 仍要打开」，由接收机器的用户亲自确认。此操作不会关闭 Gatekeeper 或改动整机安全设置。**自签名不能替代 Apple 公证**：若系统只提示「已损坏」且不提供逐个应用的确认入口，需要用 Developer ID 签名并公证，不能通过删除隔离属性来伪装成已获系统认可的包。

## Windows

1. 先把正在运行的旧版本完全退出，包括系统托盘里的图标。
2. 双击 `.exe` 安装。
3. **不要**右键选「以管理员身份运行」——安装器是给当前用户装的，用管理员身份反而会让数据目录对不上。

未签名的安装包会触发 SmartScreen 蓝屏提示。确认文件确实来自本仓库 Release 后，点「更多信息」→「仍要运行」。

覆盖升级时安装器会检查旧安装目录里的用户数据。如果它提示「程序仍在运行」，退出主窗口和托盘图标，等几秒让后台的 sidecar、终端和 IM adapter 退干净，再重新运行安装器。别先手动删掉旧安装目录。

## Linux

**AppImage**（免安装，下载即用）：

```bash
chmod +x ccmax-<版本>-linux-x86_64.AppImage
./ccmax-<版本>-linux-x86_64.AppImage
```

启动失败并提示 FUSE 相关错误时，装一下运行库：Ubuntu 22.04 及更早用 `sudo apt install libfuse2`，24.04 及以后用 `libfuse2t64`。

**deb**（装进系统菜单）：

```bash
sudo apt install ./ccmax-<版本>-linux-amd64.deb
```

ARM64 机器换成对应的 `linux-arm64` 文件。

## 从源码跑

想改代码、调试内核，或者只想在终端里用 CLI，可以从源码起：

```bash
git clone https://github.com/yaogjim/ccmax.git
cd ccmax
bun install
cp .env.example .env
./bin/ccmax
```

需要 [Bun](https://bun.sh) 和 Git。这条路只跑 CLI，桌面端的构建方式和本地服务参数见 [命令行](../cli/index.md)。

### 本地构建 macOS 桌面端（Apple Silicon）

想自己打包桌面端，在仓库根目录跑：

```bash
./desktop/scripts/build-macos-arm64.sh
```

**没有正式 Apple 开发者证书也可以构建完整的 Computer Use 签名链，但跨机器首次打开仍受 Gatekeeper 策略限制。** 构建脚本会在钥匙串里自动挑一个**稳定的签名身份**——优先 Developer ID，其次是 Apple Development，最后是自签的 `cu-helper-dev`——并让宿主应用、sidecar 和 Computer Use 助手三者用**同一张证书**。三者签名必须一致：只要有一个是 ad-hoc 或换成了别的证书，助手就会拒绝 Computer Use，报 `unauthorized_client`。

自签证书只需在本机建一次：打开「钥匙串访问」→ 菜单「证书助理」→「创建证书…」，名称填 `cu-helper-dev`，身份类型选「自签名根」，证书类型选「代码签名」，建好后留在 `login` 钥匙串即可，脚本之后会自动认出来。证书和私钥都只留在这台机器的钥匙串里，**不需要导出 p12**，也不要提交进仓库。每次都复用同一张证书，签名身份才稳定，系统授权不会因为重新构建而失效。

换一台机器就要自己重新做一遍：先按上面的 macOS 系统弹窗逐个应用确认首次打开；若系统不允许为自签名包逐个确认，需要 Apple Developer ID 签名及公证，不能通过清除隔离属性替代。然后授予**屏幕录制**和**辅助功能**两项权限。授权记在本机，不跟着应用走。步骤见 [Computer Use](../desktop/computer-use.md)。

## 升级

**应用内更新（推荐）。** 打开「设置 → 关于 → 应用更新」，点「检查更新」。它会比对当前版本和 GitHub Releases 上的最新版本，有新版就下载，下载完提示「安装并重启」。

更新前先把正在跑的会话停掉，未提交的代码存好。

下载卡住不动，多半是网络到不了 GitHub。同一个面板里有「高级更新代理」，可以切成系统代理或填一个本地 HTTP 代理地址（例如 `http://127.0.0.1:7890`）。这个代理只管应用自己的更新下载，不影响模型请求。

**手动换包。** 从 Releases 下新版安装包，按上面各平台的步骤重装一遍即可。会话、服务商配置、技能、Agent、记忆都存在 `~/.claude` 下，不在应用目录里，覆盖安装不会动它们。

:::warning
安装器的数据保护不等于备份。真正重要的东西请自己另存一份。
:::

## Code signing policy

Windows 安装包的签名范围、人工审批、责任角色和验证方法见 [Code signing policy](./code-signing.md)。在 SignPath Foundation 接入完成前，Windows Release 仍会明确标注为未签名；软件联网和本地数据处理方式见[隐私与联网说明](./privacy.md)。

## 装完之后

去 [连接模型服务](./models.md)。没接模型之前，应用能打开，但发不出任何一条消息。

装不上或者打不开，看 [装不上 / 打不开 / 连不上](./troubleshooting.md)。

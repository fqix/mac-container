<div align="center">

<img src="resources/icon.png" width="96" alt="Apple Container Tools 图标">

# Apple Container Tools

**在 VS Code 和 Cursor 中管理 [Apple `container`](https://github.com/apple/container)（macOS 原生 Linux 容器）。**

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=fqix.apple-container-tools)
[![Open VSX](https://img.shields.io/open-vsx/v/fqix/apple-container-tools?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/fqix/apple-container-tools)
[![CI](https://img.shields.io/github/actions/workflow/status/fqix/mac-container/ci.yml?branch=main&label=CI)](https://github.com/fqix/mac-container/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20silicon-lightgrey?logo=apple)](#环境要求)
[![License: MIT](https://img.shields.io/github/license/fqix/mac-container)](LICENSE)

[安装](#安装) · [功能](#功能) · [Remote-SSH](#通过-remote-ssh-打开容器) · [开发容器](#开发容器devcontainerjson) · [已知限制](#已知限制) · [设置](#设置) · [参与贡献](CONTRIBUTING.md) · [English](README.md) | 简体中文

![按 compose 项目分组的容器及其卷和端口](docs/media/overview.gif)

</div>

## 亮点

- 🧭 **一个侧边栏管理全部资源**：容器、镜像、网络、卷、镜像仓库、container-compose 项目和 `container` 系统服务。
- 🖥️ **把容器作为远程工作区打开**：通过 Remote-SSH 在 VS Code 或 Cursor 中打开，不需要端口映射，也不需要常驻 SSH 服务，`openssh-server` 自动安装。
- 📦 **不依赖 Docker 的 `devcontainer.json`**：用 Apple `container` 构建并运行开发容器，支持 features 和生命周期命令，基于内置的 Dev Containers CLI。
- 📝 **用表单运行和编辑容器**：端口、挂载、环境变量、网络、CPU、内存、用户和工作目录。
- 📊 **实时资源用量、日志、Shell、文件上传下载**，右键即可使用。
- 🌐 **中英双语**。

## 环境要求

| | |
|---|---|
| 硬件 | 搭载 Apple 芯片的 Mac |
| `container` CLI | [apple/container](https://github.com/apple/container/releases)，已在 1.6.1 上测试 |
| 编辑器 | VS Code 1.90 及以上，或 Cursor |
| 可选 | [container-compose](https://github.com/mcrich23/container-compose)（compose 项目）；Remote - SSH 扩展（远程工作区和开发容器） |

## 安装

- **VS Code**：从 Marketplace 安装 [Apple Container Tools](https://marketplace.visualstudio.com/items?itemName=fqix.apple-container-tools)，或在快速打开（`⌘P`）中执行 `ext install fqix.apple-container-tools`。
- **Cursor 及其他使用 Open VSX 的编辑器**：从 [Open VSX](https://open-vsx.org/extension/fqix/apple-container-tools) 安装。
- **VSIX**：从 [GitHub Releases](https://github.com/fqix/mac-container/releases) 下载 `apple-container-tools-darwin-arm64-<version>.vsix` 后安装：

  ```bash
  code --install-extension apple-container-tools-darwin-arm64-0.3.0.vsix
  ```

## 快速上手

1. 执行 `container system start` 启动服务，或点击状态栏中的 **container**。
2. 打开活动栏中的 **Apple Container** 视图。
3. 右键镜像 → **运行...**；或右键运行中的容器 → **打开 Shell**、**查看资源用量**、**在 Remote-SSH 中打开**。
4. 项目里有 `.devcontainer/devcontainer.json`？打开文件夹后在提示中选择 **在开发容器中打开**。

## 功能

### 容器

- 运行中的容器排在前面，显示镜像、IP 和启动时间；悬停可查看命令、网络、端口、资源和平台。
- 启动、停止、重启、强制终止、删除（支持多选）、清理已停止的容器。
- 在集成终端中 **打开 Shell**（`container exec -it`）、**查看日志**（`logs -f`）和 **查看启动日志**。
- 展开容器可以看到 **卷** 和 **端口**。TCP 端口可以直接在浏览器中打开或复制 URL，绑定挂载的目录可以在访达中显示。
- **上传文件...** 和 **下载...** 在本机与运行中的容器之间复制文件和文件夹，容器内路径可以逐级浏览选择。本机已有同名文件时不会覆盖（自动加 ` (1)` 后缀）。资源管理器中的文件右键有 **上传到容器...**。
- **查看资源用量** 打开 CPU、内存、网络 I/O、磁盘 I/O 的实时图表。

  ![实时资源用量图表](docs/media/stats.gif)

- **编辑...** 修改端口转发、挂载、环境变量（每行一个 `KEY=VALUE`，也可从 `.env` 文件导入）、网络、CPU、内存、用户和工作目录。
  Apple `container` 不支持修改已有容器的这些配置，所以保存时会用相同的镜像和命令重建容器，表单里没有的配置（标签、DNS、capabilities、ulimit、平台等）保持不变。
  **保留改动并重建** 会先把容器提交为快照镜像，容器内改过的文件不会丢失。新容器启动失败时会自动恢复原容器。

  ![编辑端口与挂载](docs/media/edit.gif)

### 镜像

- 拉取、从 `Dockerfile` / `Containerfile` 构建（也可在资源管理器中右键）、打标签、查看详情、删除、清理。
- **运行...** 打开与 **编辑...** 相同的表单，另有名称（留空时随机生成 Docker 风格的名字如 `brave_hopper`）和可选的命令或 shell 脚本（用 `/bin/sh -c` 执行）。
- **推送...** 把镜像推送到仓库（改成别的名字会先打标签；构建完成的通知里也可以直接推送）。
- **导出为 tar...** 把一个或多个镜像保存为 OCI 归档；**从 tar 导入...** 加载归档，也可在资源管理器中右键 `.tar` 文件。
- 和 Docker 一样，本机回环地址的仓库（如 `localhost:5000`）自动走 http；其他 http 仓库加到 `appleContainer.insecureRegistries`。

### 网络、卷和镜像仓库

- 网络：创建（可指定子网）、查看详情、删除、清理；内置的 `default` 网络不可删除。
- 卷：创建（可指定容量）、查看详情、删除、清理。
- 镜像仓库：登录（密码通过 `container registry login --password-stdin` 传入，不会出现在命令行参数里）、登出。

### container-compose

由 [container-compose](https://github.com/mcrich23/container-compose) 启动的容器会按项目分组显示。

- 一键启动 / 停止 / 重启 / 删除项目的全部容器。
- 在项目节点上，或在资源管理器 / 编辑器中右键 `compose.yml` / `docker-compose.yml`，执行 **Compose 启动** / **Compose 停止**。插件按项目名（`name:` 字段，没有则用所在目录名）在工作区中查找对应的 compose 文件。

### 系统服务

状态栏显示 `container` 服务是否运行以及运行中的容器数量，点击可以启动 / 停止服务，或查看状态、磁盘占用和日志。CLI 未安装或服务未启动时，视图中会给出处理提示。

## 通过 Remote-SSH 打开容器

右键运行中的容器 → **在 Remote-SSH 中打开**，确认目录后，VS Code 或 Cursor 会打开新窗口连接到容器。

ssh 通过 `ProxyCommand container exec -i <id> sshd -i` 连接容器，不依赖容器 IP、端口映射，也不需要容器里常驻 sshd。每次打开时，插件会：

1. 容器内没有 `sshd` 时，用镜像自带的包管理器（`apk`、`apt-get`、`dnf`、`microdnf`、`yum`、`zypper`）安装 `openssh-server`。这需要容器能访问外网；安装失败或镜像没有包管理器时，会给出手动安装命令。
2. 缺失时生成 SSH 主机密钥，把插件自己的公钥加入登录用户的 `authorized_keys`。如果该账号未设密码（`/etc/shadow` 中为 `!`，sshd 视为锁定），会改成 `*` 以允许密钥登录。
3. 把容器的环境变量（镜像 `ENV`、`--env`，开发容器还包括 `remoteEnv`）写入登录用户的 `~/.ssh/environment`，sshd 以 `PermitUserEnvironment=yes` 读取，VS Code Server 和终端里看到的变量与 `container exec` 一致。
4. 按需在 `~/.ssh/config`（或 `remote.SSH.configFile` 指定的文件）顶部补齐 `Include ~/.ssh/apple-container/config`，保留原有配置；主机条目（`apple-container.<id>`）和密钥对放在 `~/.ssh/apple-container/`。

登录用户默认是容器自身的用户（镜像 `USER` 或 `--user`，默认 root），可用 `appleContainer.sshUser` 覆盖。
VS Code / Cursor Server 会在容器内下载，需要容器能访问外网；否则开启 `remote.SSH.localServerDownload`。

## 开发容器（devcontainer.json）

**在开发容器中打开文件夹** 会读取文件夹中的 `devcontainer.json`（`.devcontainer/devcontainer.json`、`.devcontainer.json` 或 `.devcontainer/<名称>/devcontainer.json`），用 Apple `container` 创建容器，再[通过 Remote-SSH](#通过-remote-ssh-打开容器) 打开容器内的工作区文件夹。打开带有该配置的本地文件夹时会提示；在该文件上右键还有 **重建并打开开发容器**。

容器由规范的参考实现 [Dev Containers CLI](https://github.com/devcontainers/cli)（`@devcontainers/cli` 0.90.0）创建，所以 `devcontainer.json` 的行为与在 Docker 下一致，包括 features。CLI 随插件打包，用编辑器自带的 Node 运行时执行，无需另外安装。CLI 通过插件自带的 docker 兼容层（`dist/docker-shim.js`）调用 Apple `container`，日志（镜像构建、features、生命周期命令）显示在任务终端中。

容器名为 `devc-<文件夹>-<哈希>`，带 `devcontainer.local_folder` / `devcontainer.config_file` 标签，下次打开会复用；配置或其 Dockerfile 自上次打开后有改动时会询问是否重建。

| 配置项 | 支持情况 |
|---|---|
| `image`、`build` | ✅ |
| `features` | ✅ 安装到基于基础镜像构建的新镜像中 |
| `workspaceFolder`、`workspaceMount`、`mounts` | ✅ |
| `containerEnv`、`remoteEnv`、`containerUser`、`remoteUser` | ✅ |
| 生命周期命令，从 `initializeCommand`（在本机执行）到 `postAttachCommand` | ✅ |
| `appPort` | ✅ 通过 `container run --publish` 发布 |
| `forwardPorts` | ⚠️ 不发布；Remote-SSH 会转发它检测到在容器内监听的端口，本机也可以直接访问容器 IP |
| `capAdd`、`init`、`overrideCommand` | ✅ |
| `runArgs` | ⚠️ 传给 `container run`；Docker 专有选项会被丢弃并给出警告，见[已知限制](#已知限制) |
| `privileged` | ⚠️ 转为 `--cap-add ALL` |
| `securityOpt` | ❌ 忽略并给出警告 |
| `dockerComposeFile` | ❌ 不支持 |
| `customizations.vscode.extensions` | ❌ 不会安装；请在远程窗口中安装扩展 |

## 已知限制

Apple `container` 的每个容器都运行在独立的轻量虚拟机里，有自己的 Linux 内核，而不是共享一个 Docker daemon，所以部分 Docker 选项没有对应能力（基于 `container` 1.6.1 核实）：

| Docker 选项 | Apple `container` 中 |
|---|---|
| `--privileged` | 不支持。改用 `--cap-add` / `capAdd` 添加 capability（`ALL` 表示全部）。 |
| `--ipc`、`--pid`、`--userns`、`--cgroupns` | 不支持：没有可共享的宿主内核命名空间。 |
| `--device`、`--gpus`、绑定挂载 `/dev` 或 `/run/udev` | 不支持：宿主是 macOS，没有可透传的 Linux 设备。 |
| `--security-opt`、`--add-host`、`--hostname` | 不支持。 |
| Docker Compose | 不支持。支持 [container-compose](#container-compose) 项目，但不支持 `devcontainer.json` 中的 `dockerComposeFile`。 |
| Docker-in-Docker | 不支持，它依赖特权模式。 |

对 `devcontainer.json` 的影响：

- docker 兼容层会丢弃 Apple `container` 无法应用的 `runArgs`（`--ipc`、`--pid`、`--security-opt`、`--device`、`--gpus`、`--add-host`、`--network host`，以及挂载 `/dev`、`/proc`、`/sys` 或本机不存在的路径），并在任务终端中给出警告。`--privileged`（包括来自 `privileged: true` 或 feature 的）会转为 `--cap-add ALL`。容器可以启动，但依赖这些选项的功能无法工作。
- 依赖特权模式或 Docker daemon 的 features（如 `docker-in-docker`）能安装但无法工作；`docker-outside-of-docker` 没有可连接的 Docker socket。
- 为 Codespaces 或 Docker 编写、在开发容器里运行 containerd、Kubernetes 等嵌套容器运行时的配置只能部分工作：需要宿主设备或嵌套容器的部分会失败。

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `appleContainer.path` | `container` | `container` CLI 路径，默认从 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin` 查找 |
| `appleContainer.composePath` | `container-compose` | `container-compose` CLI 路径 |
| `appleContainer.insecureRegistries` | `[]` | 使用 http 访问的镜像仓库（`host` 或 `host:port`），本机回环地址始终使用 http |
| `appleContainer.refreshInterval` | `5` | 视图可见时的自动刷新间隔（秒），`0` 关闭 |
| `appleContainer.statsInterval` | `2` | 资源用量图表的采样间隔（秒） |
| `appleContainer.execShell` | `/bin/sh` | **打开 Shell** 使用的 shell |
| `appleContainer.logTail` | `200` | 查看日志时显示的末尾行数，`0` 表示全部 |
| `appleContainer.sshUser` | _（空）_ | **在 Remote-SSH 中打开** 时登录的用户；留空自动使用容器自身的用户（镜像 `USER` 或 `--user`，默认 root） |

## 常见问题

<details>
<summary><b>工作区在远程（SSH、Dev Containers、WSL）时能用吗？</b></summary>

可以。插件运行在本地 UI 端（`extensionKind: ["ui"]`），管理的始终是你面前这台 Mac 上的容器。构建镜像和 Compose 需要本机文件，远程工作区中的文件会提示不支持。
</details>

<details>
<summary><b>Remote-SSH 卡在下载 VS Code Server。</b></summary>

Server 是在容器内下载的。容器无法访问外网时，开启 `remote.SSH.localServerDownload`，改为在 Mac 上下载后复制进容器。
</details>

<details>
<summary><b><code>Compose 停止</code> 后容器还在。</b></summary>

`container-compose down`（1.2.0）只停止容器、不删除。需要删除时在项目上用 **删除全部容器**。
</details>

<details>
<summary><b>需要安装 Docker 吗？</b></summary>

不需要，所有操作都通过 `container` CLI 完成；开发容器由内置的 Dev Containers CLI 经 docker 兼容层调用它。Compose、特权模式等 Docker 专有选项不可用，见[已知限制](#已知限制)。
</details>

## 参与贡献

欢迎提交 Issue 和 Pull Request。构建、测试和翻译说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，各版本变更见 [CHANGELOG](CHANGELOG.md)。

## 致谢

- [apple/container](https://github.com/apple/container)：本插件驱动的容器运行时。
- [container-compose](https://github.com/mcrich23/container-compose)：为 Apple `container` 提供 Compose 支持。
- [Development Containers 规范](https://containers.dev/) 和 [Dev Containers CLI](https://github.com/devcontainers/cli)：内置用于创建开发容器。

## 许可证

[MIT](LICENSE)

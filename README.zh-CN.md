# Apple Container Tools for VS Code

[English](README.md)

在 VS Code 中管理 [Apple `container`](https://github.com/apple/container)（macOS 原生 Linux 容器）：容器、镜像、网络、卷、镜像仓库、container-compose 项目和系统服务。

> 需要搭载 Apple 芯片的 Mac、`container` CLI（已在 1.6.1 上测试）以及 VS Code 1.90 及以上版本。

![按 compose 项目分组的容器及其卷和端口](docs/media/overview.gif)

## 功能

### 容器

- 运行中的容器排在前面，显示镜像、IP 和启动时间；悬停可查看命令、网络、端口、资源和平台。
- 启动、停止、重启、强制终止、删除（支持多选）、清理已停止的容器。
- 在集成终端中 **打开 Shell**（`container exec -it`）、**查看日志**（`logs -f`）和 **查看启动日志**。
- 展开容器可以看到 **卷** 和 **端口** 两个子节点，没有内容的不显示。TCP 端口可以直接在浏览器中打开或复制 URL，绑定挂载的目录可以在访达中显示。
- **查看资源用量** 打开 CPU、内存、网络 I/O、磁盘 I/O 的实时图表。

  ![实时资源用量图表](docs/media/stats.gif)

- **编辑...** 打开表单修改端口转发和挂载。
  Apple `container` 不支持修改已有容器的端口和挂载，所以保存时会用相同的镜像、命令、环境变量、资源、网络和标签重建容器。
  选择 **保留改动并重建** 会先把容器提交为快照镜像，容器内改过的文件不会丢失。新容器启动失败时会自动恢复原容器。

  ![编辑端口与挂载](docs/media/edit.gif)

### container-compose

由 [container-compose](https://github.com/mcrich23/container-compose) 启动的容器会按项目分组显示。

- 一键启动 / 停止 / 重启 / 删除项目的全部容器。
- 在项目节点上，或在资源管理器 / 编辑器中右键 `compose.yml` / `docker-compose.yml`，执行 **Compose 启动** / **Compose 停止**。
  插件按项目名（`name:` 字段，没有则用所在目录名）在工作区中查找对应的 compose 文件。
- 注意：`container-compose down`（1.2.0）只停止容器、不删除，需要删除时用 **删除全部容器**。

### 镜像、网络、卷、镜像仓库

- 镜像：拉取、从 `Dockerfile` / `Containerfile` 构建（也可在资源管理器中右键）、运行（名称默认随机生成 Docker 风格的名字如 `brave_hopper`，可指定端口映射，以及可选的命令或 shell 脚本，用 `/bin/sh -c` 执行）、打标签、查看详情、删除、清理。
- 网络：创建（可指定子网）、查看详情、删除、清理；内置的 `default` 网络不可删除。
- 卷：创建（可指定容量）、查看详情、删除、清理。
- 镜像仓库：登录（密码通过 `container registry login --password-stdin` 传入，不会出现在命令行参数里）、登出。

### 系统服务

状态栏显示 `container` 服务是否运行以及运行中的容器数量，点击可以启动 / 停止服务，或查看状态、磁盘占用和日志。
CLI 未安装或服务未启动时，视图中会给出处理提示。

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `appleContainer.path` | `container` | `container` CLI 路径，默认从 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin` 查找 |
| `appleContainer.composePath` | `container-compose` | `container-compose` CLI 路径 |
| `appleContainer.refreshInterval` | `5` | 视图可见时的自动刷新间隔（秒），`0` 关闭 |
| `appleContainer.statsInterval` | `2` | 资源用量图表的采样间隔（秒） |
| `appleContainer.execShell` | `/bin/sh` | **打开 Shell** 使用的 shell |
| `appleContainer.logTail` | `200` | 查看日志时显示的末尾行数，`0` 表示全部 |

## 远程开发

插件运行在本地 UI 端（`extensionKind: ["ui"]`），即使工作区通过 Remote-SSH、Dev Containers 或 WSL 打开，管理的也始终是你面前这台 Mac 上的容器。
构建镜像和 Compose 需要本机文件，远程工作区中的文件会提示不支持。

## 开发

```bash
npm install
npm run build        # 打包插件和 webview 到 dist/
npm test             # 类型检查、l10n 检查和单元测试
npm run test:e2e     # 在 VS Code 中针对真实 container 服务的端到端测试
npm run package      # 生成 apple-container-tools-darwin-arm64-<version>.vsix
```

e2e 测试会启动本机安装的 VS Code（`/Applications/Visual Studio Code.app`，可用 `VSCODE_EXECUTABLE` 覆盖），需要 `container` 服务处于运行状态。
测试只操作自己创建的资源（`e2e-` 前缀），不会执行任何 prune。设置 `E2E_SKIP_BUILD=1` 跳过镜像构建用例，`E2E_GREP=<pattern>` 只运行部分用例。

README 中的动画由 `npm run demo` 录制：它用调试端口启动 VS Code，针对演示容器（结束后自动删除）播放脚本化的场景，再通过 Chrome DevTools Protocol 抓取窗口画面生成 `docs/media/*.gif`。`DEMO_SCENES=stats npm run demo` 只录制单个场景。

翻译文件：清单文案在 `package.nls*.json`，运行时文案在 `l10n/bundle.l10n.*.json`；`npm run check:l10n` 会报告缺失或多余的翻译。

## 许可证

[MIT](LICENSE)

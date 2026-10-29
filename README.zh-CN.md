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
- **上传文件...** 把本机文件和文件夹复制到运行中的容器，**下载...** 把容器里的文件或目录复制到本机（本机已有同名文件时自动加 ` (1)` 后缀，不覆盖）。容器内路径可以逐级浏览选择，也可以直接输入绝对路径。资源管理器中的文件右键有 **上传到容器...**。
- **在 Remote-SSH 中打开** 通过 Remote - SSH 扩展，把运行中的容器作为远程工作区在 VS Code 或 Cursor 中打开（见[下文](#通过-remote-ssh-打开容器)）。
- **查看资源用量** 打开 CPU、内存、网络 I/O、磁盘 I/O 的实时图表。

  ![实时资源用量图表](docs/media/stats.gif)

- **编辑...** 打开表单修改端口转发、挂载、环境变量（每行一个 `KEY=VALUE`，也可从 `.env` 文件导入）、网络、CPU、内存、用户和工作目录。
  Apple `container` 不支持修改已有容器的端口和挂载，所以保存时会用相同的镜像和命令、按表单中的设置重建容器，表单里没有的配置（标签、DNS、capabilities、ulimit、平台等）保持不变。
  选择 **保留改动并重建** 会先把容器提交为快照镜像，容器内改过的文件不会丢失。新容器启动失败时会自动恢复原容器。

  ![编辑端口与挂载](docs/media/edit.gif)

### container-compose

由 [container-compose](https://github.com/mcrich23/container-compose) 启动的容器会按项目分组显示。

- 一键启动 / 停止 / 重启 / 删除项目的全部容器。
- 在项目节点上，或在资源管理器 / 编辑器中右键 `compose.yml` / `docker-compose.yml`，执行 **Compose 启动** / **Compose 停止**。
  插件按项目名（`name:` 字段，没有则用所在目录名）在工作区中查找对应的 compose 文件。
- 注意：`container-compose down`（1.2.0）只停止容器、不删除，需要删除时用 **删除全部容器**。

### 镜像、网络、卷、镜像仓库

- 镜像：拉取、从 `Dockerfile` / `Containerfile` 构建（也可在资源管理器中右键）、运行（表单与 **编辑...** 的设置项相同，另有名称（留空时随机生成 Docker 风格的名字如 `brave_hopper`）和可选的命令或 shell 脚本，用 `/bin/sh -c` 执行）、打标签、查看详情、删除、清理。
  **推送...** 把镜像推送到仓库（改成别的名字会先打标签；构建完成的通知里也可以直接推送），**导出为 tar...** 把一个或多个镜像保存为 OCI 归档，**从 tar 导入...** 加载归档（也可在资源管理器中右键 `.tar` 文件）。
  和 Docker 一样，本机回环地址的仓库（如 `localhost:5000`）自动走 http；其他 http 仓库加到 `appleContainer.insecureRegistries`。
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
| `appleContainer.insecureRegistries` | `[]` | 使用 http 访问的镜像仓库（`host` 或 `host:port`），本机回环地址始终使用 http |
| `appleContainer.refreshInterval` | `5` | 视图可见时的自动刷新间隔（秒），`0` 关闭 |
| `appleContainer.statsInterval` | `2` | 资源用量图表的采样间隔（秒） |
| `appleContainer.execShell` | `/bin/sh` | **打开 Shell** 使用的 shell |
| `appleContainer.logTail` | `200` | 查看日志时显示的末尾行数，`0` 表示全部 |
| `appleContainer.sshUser` | _（空）_ | **在 Remote-SSH 中打开** 时登录的用户；留空自动使用容器自身的用户（镜像 `USER` 或 `--user`，默认 root） |

## 远程开发

插件运行在本地 UI 端（`extensionKind: ["ui"]`），即使工作区通过 Remote-SSH、Dev Containers 或 WSL 打开，管理的也始终是你面前这台 Mac 上的容器。
构建镜像和 Compose 需要本机文件，远程工作区中的文件会提示不支持。

## 通过 Remote-SSH 打开容器

ssh 通过 `ProxyCommand container exec -i <id> sshd -i` 连接容器，不依赖容器 IP、端口映射，也不需要容器里常驻 sshd。

1. 容器内没有 `sshd` 时，插件会用镜像自带的包管理器（`apk`、`apt-get`、`dnf`、`microdnf`、`yum`、`zypper`）自动安装 `openssh-server`。这需要容器能访问外网；安装失败或镜像没有包管理器时，会给出手动安装命令。
2. 首次打开时，插件会按需在 `~/.ssh/config`（或 `remote.SSH.configFile` 指定的文件）顶部自动补齐 `Include ~/.ssh/apple-container/config`，保留原有配置，不会重复插入。主机条目（`apple-container.<id>`）和插件自己的密钥对仍放在 `~/.ssh/apple-container/`，无需手动配置 SSH。
3. 右键运行中的容器 → **在 Remote-SSH 中打开**，确认目录后会打开新窗口。

每次打开时，插件会在缺失时生成 SSH 主机密钥，把公钥加入登录用户的 `authorized_keys`；如果该账号未设密码（`/etc/shadow` 中为 `!`，sshd 视为锁定），会改成 `*` 以允许密钥登录。
SSH 会话不会继承容器的环境变量，所以插件还会把它们（镜像 `ENV`、`--env`，开发容器还包括 `remoteEnv`）写入登录用户的 `~/.ssh/environment`，sshd 以 `PermitUserEnvironment=yes` 读取。这样 VS Code Server 和终端里看到的变量与 `container exec` 一致。
VS Code / Cursor Server 会在容器内下载，需要容器能访问外网；否则开启 `remote.SSH.localServerDownload`。

## 开发容器（devcontainer.json）

**在开发容器中打开文件夹** 会读取文件夹中的 `devcontainer.json`（`.devcontainer/devcontainer.json`、`.devcontainer.json` 或 `.devcontainer/<名称>/devcontainer.json`），用 Apple `container` 运行容器，再按上一节的方式通过 Remote-SSH 打开容器内的工作区文件夹。打开带有该配置的本地文件夹时会提示；在该文件上右键也有这个命令，以及 **重建并打开开发容器**。

- 文件夹默认挂载到 `/workspaces/<文件夹名>`，可用 `workspaceMount` / `workspaceFolder` 修改。容器名为 `devc-<文件夹>-<哈希>`，带 `devcontainer.local_folder` / `devcontainer.config_file` 标签，下次打开会复用；配置或其 Dockerfile 有改动时会询问是否重建。
- 支持：`image`、`build`（`dockerfile`、`context`、`args`、`target`、`options`）、`workspaceFolder`、`workspaceMount`、`mounts`、`containerEnv`、`remoteEnv`（其中的 `${containerEnv:NAME}` 按容器环境解析）、`containerUser`、`remoteUser`、`forwardPorts`（发布到 `127.0.0.1`）、`appPort`、`hostRequirements.cpus` / `memory`、`capAdd`、`init`、`overrideCommand`、`runArgs`（原样传给 `container run`），以及字符串、数组、对象三种形式的全部生命周期命令：`initializeCommand` 每次打开时在本机执行，`onCreateCommand` / `updateContentCommand` / `postCreateCommand` 在容器创建时执行，`postStartCommand` 在容器启动时执行，`postAttachCommand` 每次打开时执行。支持 `${localWorkspaceFolder}`、`${localEnv:NAME:默认值}`、`${containerWorkspaceFolder}` 等变量。
- 不支持：`features`、`dockerComposeFile`、`privileged`、`securityOpt`、`customizations.vscode.extensions`；启动容器前会列出被忽略的设置。

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
测试会启动两次 VS Code：一次带工作区文件夹，一次是空窗口，用来覆盖不依赖文件夹的命令。Remote-SSH 用例会让插件从 Alpine 源自动安装 `openssh-server`，并拉取 `busybox` 覆盖没有包管理器的情况，密钥和 SSH 配置都放在临时目录，不会写入 `~/.ssh`。

README 中的动画由 `npm run demo` 录制：它用调试端口启动 VS Code，针对演示容器（结束后自动删除）播放脚本化的场景，再通过 Chrome DevTools Protocol 抓取窗口画面生成 `docs/media/*.gif`。`DEMO_SCENES=stats npm run demo` 只录制单个场景。

翻译文件：清单文案在 `package.nls*.json`，运行时文案在 `l10n/bundle.l10n.*.json`；`npm run check:l10n` 会报告缺失或多余的翻译。

## 许可证

[MIT](LICENSE)

# Apple Container Tools for VS Code

[简体中文](README.zh-CN.md)

Manage [Apple `container`](https://github.com/apple/container) — native Linux containers on macOS — from VS Code: containers, images, networks, volumes, registries, container-compose projects and the system service.

> Requires a Mac with Apple silicon, the `container` CLI (tested with 1.6.1) and VS Code 1.90 or later.

![Containers grouped by compose project, with their volumes and ports](docs/media/overview.gif)

## Features

### Containers

- Running containers first, with image, IP address and uptime; hover for command, networks, ports, resources and platform.
- Start, stop, restart, kill, delete (multi-select supported), prune stopped containers.
- **Attach Shell** (`container exec -it`), **View Logs** (`logs -f`) and **View Boot Logs** in the integrated terminal.
- Expand a container to see its **Volumes** and **Ports** — each section is shown only when it has entries.
  Open a TCP port in the browser, copy its URL, or reveal a bind-mounted folder in Finder.
- **Open in Remote-SSH** opens a running container as a remote workspace in VS Code or Cursor through the Remote - SSH extension (see [below](#open-a-container-over-remote-ssh)).
- **Show Stats** opens live charts for CPU, memory, network I/O and block I/O.

  ![Live stats charts](docs/media/stats.gif)

- **Edit...** opens a form to change port forwarding and mounts.
  Apple `container` cannot change these on an existing container, so saving recreates it with the same image, command, environment, resources, networks and labels.
  Choose **Keep Changes and Recreate** to commit the container to a snapshot image first, so files changed inside it are preserved.
  If the new container fails to start, the original one is restored.

  ![Editing ports and mounts](docs/media/edit.gif)

### container-compose

Containers started by [container-compose](https://github.com/mcrich23/container-compose) are grouped by project.

- Start / stop / restart / delete all containers of a project.
- **Compose Up** / **Compose Down** from the project, or from the context menu of a `compose.yml` / `docker-compose.yml` in the explorer or editor.
  The compose file is located in the workspace by project name (`name:` field, otherwise the folder name).
- Note: `container-compose down` (1.2.0) stops the containers but does not remove them; use **Delete All Containers** to remove them.

### Images, networks, volumes, registries

- Images: pull, build from a `Dockerfile` / `Containerfile` (also from the explorer context menu), run with a name (a Docker-style random name such as `brave_hopper` is suggested), published ports and an optional command or shell script (run with `/bin/sh -c`), tag, inspect, delete, prune.
- Networks: create with an optional subnet, inspect, delete, prune. The built-in `default` network is protected.
- Volumes: create with an optional size, inspect, delete, prune.
- Registries: log in (the password is passed to `container registry login --password-stdin`, never on the command line), log out.

### System service

The status bar shows whether the `container` service is running and how many containers are up. Click it to start / stop the service or view status, disk usage and logs.
When the CLI is missing or the service is stopped, the views explain what to do.

## Settings

| Setting | Default | Description |
|---|---|---|
| `appleContainer.path` | `container` | Path to the `container` CLI. Looked up in `PATH`, `/opt/homebrew/bin` and `/usr/local/bin`. |
| `appleContainer.composePath` | `container-compose` | Path to the `container-compose` CLI. |
| `appleContainer.refreshInterval` | `5` | Auto refresh interval in seconds while a view is visible; `0` disables it. |
| `appleContainer.statsInterval` | `2` | Sampling interval of the stats charts in seconds. |
| `appleContainer.execShell` | `/bin/sh` | Shell started by **Attach Shell**. |
| `appleContainer.logTail` | `200` | Lines shown when opening logs; `0` shows everything. |
| `appleContainer.sshUser` | _(empty)_ | User for **Open in Remote-SSH**. Empty uses the container's own user (image `USER` or `--user`, root by default). |

## Remote development

The extension runs on the local UI side (`extensionKind: ["ui"]`), so it always manages the containers of the Mac you are sitting at, also when the workspace is opened over Remote-SSH, in a Dev Container or in WSL.
Building images and running Compose need the files on this Mac; files from a remote workspace are rejected with a message.

## Open a container over Remote-SSH

ssh reaches the container through `ProxyCommand container exec -i <id> sshd -i`, so the container needs no IP route, published port or running SSH daemon.

1. If the container has no `sshd`, the extension installs `openssh-server` with the image's package manager (`apk`, `apt-get`, `dnf`, `microdnf`, `yum` or `zypper`). This needs network access from the container; when it fails, or the image has no package manager, it shows the command to run yourself.
2. Add this line at the top of `~/.ssh/config` (or the file set in `remote.SSH.configFile`), before any `Host` entry:

   ```
   Include ~/.ssh/apple-container/config
   ```

   The extension writes its host entries (`apple-container.<id>`) and its own key pair to `~/.ssh/apple-container/` and never edits your SSH config.
3. Right-click a running container → **Open in Remote-SSH**, confirm the folder, and a new window connects.

On each open the extension generates SSH host keys if missing, adds its public key to the user's `authorized_keys` and, if the account has no password (`!` in `/etc/shadow`, which sshd treats as locked), changes it to `*` so key login works.
The VS Code / Cursor server is downloaded inside the container, so it needs internet access; otherwise enable `remote.SSH.localServerDownload`.

## Development

```bash
npm install
npm run build        # bundle the extension and webviews into dist/
npm test             # type check, l10n check and unit tests
npm run test:e2e     # end-to-end tests in VS Code against the real container service
npm run package      # build apple-container-tools-darwin-arm64-<version>.vsix
```

The e2e suite launches the installed VS Code (`/Applications/Visual Studio Code.app`, override with `VSCODE_EXECUTABLE`) and needs the `container` service running.
It only touches resources it creates (prefixed with `e2e-`) and never runs prune. Set `E2E_SKIP_BUILD=1` to skip the image build test and `E2E_GREP=<pattern>` to run a subset.
It runs twice: once with a workspace folder and once as an empty window, for commands that must work without a folder. The Remote-SSH test lets the extension install `openssh-server` from the Alpine repositories, pulls `busybox` for the no-package-manager case, and keeps its key and SSH config in a temporary directory, never in `~/.ssh`.

The README animations are recorded with `npm run demo`: it starts VS Code with a remote debugging port, plays scripted scenes against demo containers (removed afterwards) and captures the window over the Chrome DevTools Protocol into `docs/media/*.gif`. `DEMO_SCENES=stats npm run demo` records a single scene.

Translations live in `package.nls*.json` (manifest) and `l10n/bundle.l10n.*.json` (runtime); `npm run check:l10n` reports missing or unused strings.

## License

[MIT](LICENSE)

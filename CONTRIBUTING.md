# Contributing

Thanks for helping improve Apple Container Tools. Bug reports, feature requests and pull requests are welcome on [GitHub](https://github.com/fqix/mac-container/issues).

## Reporting a bug

Please include:

- macOS version, `container --version`, and the VS Code or Cursor version
- the steps that trigger the problem and what you expected
- the error message and the output of the task terminal, if any

## Development setup

You need a Mac with Apple silicon, Node.js (the version in `.nvmrc`), the `container` CLI and VS Code.

```bash
npm install
npm run build        # bundle the extension and webviews into dist/
npm test             # type check, l10n check and unit tests
npm run test:e2e     # end-to-end tests in VS Code against the real container service
npm run package      # build apple-container-tools-darwin-arm64-<version>.vsix
```

Press `F5` in VS Code to start an Extension Development Host with the extension loaded.

## Project layout

| Path | Contents |
|---|---|
| `src/extension.ts` | Activation and wiring |
| `src/commands/` | Command handlers |
| `src/services/` | `container` CLI wrapper and core logic (Remote-SSH, Dev Containers CLI integration, container settings, stats) |
| `src/dockerShim/` | docker-compatible shim that the bundled Dev Containers CLI runs as its `--docker-path` (bundled to `dist/docker-shim.js`) |
| `src/views/`, `src/models/` | Tree views and their data types |
| `src/panels/`, `webview-ui/` | Webview panels (React + Vite) for the run/edit form and stats |
| `src/ui/`, `src/utils/` | Status bar, terminals, pickers and pure helpers |
| `test/unit/`, `test/e2e/` | Mocha unit tests and `@vscode/test-electron` end-to-end tests |

## End-to-end tests

The e2e suite launches the installed VS Code (`/Applications/Visual Studio Code.app`, override with `VSCODE_EXECUTABLE`) and needs the `container` service running.

- It only touches resources it creates (prefixed with `e2e-`) and never runs prune.
- `E2E_SKIP_BUILD=1` skips the image build test; `E2E_GREP=<pattern>` runs a subset.
- It runs twice: once with a workspace folder and once as an empty window, for commands that must work without a folder.
- The Remote-SSH test lets the extension install `openssh-server` from the Alpine repositories, pulls `busybox` for the no-package-manager case, and keeps its key and SSH config in a temporary directory, never in `~/.ssh`.

## Docker shim

The bundled Dev Containers CLI (copied from `node_modules/@devcontainers/cli` to `dist/devcontainer-cli/` by `esbuild.mjs`) creates dev containers through `dist/docker-shim.js`, which implements the docker commands the CLI uses on top of Apple `container`. To try it outside VS Code:

```bash
npm run build
printf '#!/bin/sh\nexec node "%s/dist/docker-shim.js" "$@"\n' "$PWD" > /tmp/docker && chmod +x /tmp/docker
DOCKER_SHIM_LOG=/tmp/docker-shim.log node dist/devcontainer-cli/run.js up --workspace-folder <folder> --docker-path /tmp/docker
```

`DOCKER_SHIM_LOG` records every docker call and the `container` commands it became. The shim relies on the fields the CLI reads from `docker inspect`, so upgrading `@devcontainers/cli` needs the dev container e2e tests to pass again.

`esbuild.mjs` also patches the copied CLI bundle so its registry lookups target `linux/arm64` instead of the host platform (`darwin`). The patch matches minified code; the build fails if it no longer matches exactly once, which is expected after an upgrade of `@devcontainers/cli`.

## README animations

`npm run demo` starts VS Code with a remote debugging port, plays scripted scenes against demo containers (removed afterwards) and captures the window over the Chrome DevTools Protocol into `docs/media/*.gif`. `DEMO_SCENES=stats npm run demo` records a single scene.

## Translations

Manifest strings live in `package.nls*.json` and runtime strings in `l10n/bundle.l10n.*.json`. `npm run check:l10n` reports missing or unused strings; please update both English and Simplified Chinese when you add user-facing text, and keep `README.md` and `README.zh-CN.md` in sync.

## Pull requests

- Run `npm test` (and `npm run test:e2e` for changes that touch the CLI or Remote-SSH) before opening a pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Add a line to `CHANGELOG.md` for user-visible changes.

## Releasing

Releases are published by `.github/workflows/release.yml` when a GitHub release is published: the tag must match the `version` in `package.json`, and the VSIX built by CI is uploaded to the VS Code Marketplace and Open VSX.

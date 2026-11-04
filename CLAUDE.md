# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code / Cursor extension (`fqix.apple-container-tools`) that manages containers of Apple's `container` CLI (apple/container, tested with 1.6.1). It ships only for `darwin-arm64` (Apple silicon, macOS 26) and is `extensionKind: ["ui"]`: it always runs on the Mac, also in remote windows. Behaviour of the `container` CLI should be checked against its 1.6.1 source/help, not assumed from Docker.

## Commands

```bash
npm install                # also installs webview-ui/ (postinstall)
npm run build              # esbuild extension + docker shim, copy/patch Dev Containers CLI, Vite build of webview-ui
npm run watch              # esbuild watch (extension only); npm run watch:webview for the webviews
npm test                   # typecheck (root + webview-ui), Prettier check, l10n check, unit tests
npm run format             # Prettier --write (React's config, 80 columns)
npm run check:l10n         # missing / unused strings in l10n/ and package.nls*.json
npm run package            # build the darwin-arm64 VSIX
npm run demo               # record the README GIFs (DEMO_SCENES=<scene> for one)
```

Single unit test (tests compile with `tsconfig.test.json` into `out/`, then run with mocha):

```bash
npm run compile-tests && npx mocha out/test/unit/devcontainerCli.test.js
npm run compile-tests && npx mocha "out/test/unit/**/*.test.js" --grep "pinned"
```

End-to-end tests drive the installed VS Code (`VSCODE_EXECUTABLE` overrides it) against the real `container` service; they only touch `e2e-` resources and never prune. They do not run in CI (hosted macOS runners have no nested virtualization), so run them locally for changes to the CLI wrapper, Remote-SSH or dev containers:

```bash
npm run test:e2e
E2E_GREP='Remote-SSH|sshd' npm run test:e2e   # regex over test titles
E2E_SKIP_BUILD=1 npm run test:e2e             # skip the image build test
```

The suite runs twice: with a workspace folder and as an empty window. It keeps its SSH key and config out of `~/.ssh` via `APPLE_CONTAINER_SSH_DIR`.

## Architecture

**Bundles** (`esbuild.mjs`): `dist/extension.js` (from `src/extension.ts`), `dist/docker-shim.js` (from `src/dockerShim/main.ts`), `dist/devcontainer-cli/` (the `@devcontainers/cli` bundle copied from node_modules and patched so registry lookups use `linux/arm64`; the patch must match exactly once, so upgrading the CLI fails the build until it is rechecked), and `dist/webview/` (one Vite bundle for all panels; `<body data-view>` selects the React view in `webview-ui/src/main.tsx`). `.vscodeignore` is an allowlist, so new runtime files must be added there.

**Layering**: `src/services/` and `src/utils/` have no `vscode` dependency and are what the mocha unit tests import directly. `src/commands/`, `src/views/`, `src/panels/`, `src/ui/` wire them to the VS Code API. `CommandContext` (`src/commands/common.ts`) carries the CLI, monitor, views and `start()`; commands are registered through `register()`, which reports errors and starts the extension's polling.

**CLI access**: `ContainerCli` (`src/services/cli.ts`) is the only way to call `container`: always `execFile`, never a shell; it also searches `/opt/homebrew/bin` and `/usr/local/bin` because a Dock-launched editor lacks the shell PATH. JSON output is mapped in `src/utils/parse.ts` into `src/models/types.ts`. Interactive or streaming commands (exec, logs -f, build, pull) run in terminals/tasks via `src/ui/terminal.ts`.

**Activation** (`src/extension.ts`): in a remote window (`vscode.env.remoteName` set) the extension only runs `installDevContainerExtensions` and returns; `package.json` hides every view, command palette entry and explorer/editor menu with `!remoteName`, and `test/unit/manifest.test.ts` enforces it, so every new command needs a `commandPalette` entry (`"when": "false"` or starting with `!remoteName`). Local windows activate on startup but only show the status bar and poll (`ServiceMonitor`, `src/services/state.ts`) once a view is visible, a command runs, or the workspace has a devcontainer.json. The monitor sets context keys that drive `viewsWelcome`.

**Editing a container** means recreating it: Apple `container` cannot change settings in place. `src/services/containerSettings.ts` converts form settings to/from `container run` arguments and `src/services/recreate.ts` rebuilds the arguments from inspect output; both follow the apple/container 1.6.1 configuration layout. The BuildKit builder container (label `com.apple.container.resource.role=builder`) is filtered out of the container lists and shown only in the Builder view.

**Remote-SSH** (`src/services/remoteSsh.ts`, `src/commands/remoteSsh.ts`): ssh reaches a container through `ProxyCommand container exec -i <id> sshd -i`, so no daemon, IP route or port is needed. On each open a root script in the container finds sshd, creates host keys and authorizes the extension's key; missing `openssh-server`, or a missing working `wget`/`curl` (Remote-SSH needs one when its server is already running), is installed with the image's package manager. Host entries `apple-container.<id>` and the key live in `~/.ssh/apple-container/`, included from the user's SSH config.

**Dev containers**: the bundled Dev Containers CLI creates the container, talking to Apple `container` through the docker shim (`src/dockerShim/`, which implements only the docker commands the CLI uses and the `docker inspect` fields it reads; `DOCKER_SHIM_LOG=<file>` logs every call). The window is then opened over Remote-SSH. `customizations.vscode.extensions` are read from `read-configuration --include-merged-configuration`, written per container to `devcontainer-extensions.json` in global storage, and installed by the remote window with `workbench.extensions.installExtension` (which picks the local or remote side by extension kind; this works the same in Cursor). `planDevContainer` and related builders in `src/services/devcontainer.ts` predate the bundled CLI and are only exercised by unit tests.

**Webview panels** (`src/panels/`): message types shared with `webview-ui` live next to the service (e.g. `BuildToWebview` / `BuildFromWebview` in `src/services/build.ts`); form options are remembered in `workspaceState`.

## Conventions

- Formatting is Prettier with facebook/react's options (`.prettierrc.js`); `npm test` and CI fail on unformatted code. Code comments are in English.
- User-facing strings: `vscode.l10n.t(...)` with the Simplified Chinese translation in `l10n/bundle.l10n.zh-cn.json`; manifest strings in `package.nls.json` / `package.nls.zh-cn.json`. Keep `README.md` and `README.zh-CN.md` in sync.
- Files from a remote workspace cannot be passed to the CLI (it runs on the Mac); commands check with `isLocal()`.
- Conventional Commits; user-visible changes get a line under `## Unreleased` in `CHANGELOG.md`.
- Releases: bump `version`, rename `## Unreleased` to the version, update the VSIX name in both READMEs, then publish a GitHub release whose tag (`vX.Y.Z`) matches `package.json`; `.github/workflows/release.yml` publishes the CI-built VSIX to the Marketplace and Open VSX and attaches it to the release.

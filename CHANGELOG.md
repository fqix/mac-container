# Changelog

## Unreleased

- Create dev containers with the bundled Dev Containers CLI (`@devcontainers/cli` 0.90.0) through a docker-compatible shim for Apple `container`: `devcontainer.json` features are now installed, and lifecycle commands, variables and image metadata follow the reference implementation. Nothing extra needs to be installed
- `runArgs` and features that use Docker-only options no longer fail the container start: unsupported options are dropped with a warning, and `--privileged` becomes `--cap-add ALL`
- `forwardPorts` are no longer published; Remote-SSH forwards ports it detects, and `appPort` is still published

## 0.3.0

- Open folders in dev containers from `devcontainer.json`: image or Dockerfile builds, workspace mount, mounts, `containerEnv` / `remoteEnv`, users, ports, CPUs and memory, `runArgs` and all lifecycle commands; containers are reused and rebuilt when the configuration changes
- Run and edit containers in a form with ports, mounts, environment variables (including `.env` import), networks, CPUs, memory, user and working directory
- Upload files and folders to running containers and download them, browsing the container filesystem
- Push images, and export or import them as OCI tar archives; loopback registries and `appleContainer.insecureRegistries` are reached over http
- Add the managed Remote-SSH hosts to the user's SSH config automatically
- Fix SSH sessions missing the container's environment variables (image `ENV`, `--env`)

## 0.2.0

- Open running containers as Remote-SSH workspaces through `container exec`, with automatic OpenSSH server installation and the container's user or an `appleContainer.sshUser` override
- Keep Remote-SSH host entries and keys in a dedicated directory, included from the user's SSH config
- Suggest Docker-style random container names and run optional shell scripts with `/bin/sh -c`, replacing the image's entrypoint when a script is provided
- Fix terminal tasks in windows with no workspace folder open, with end-to-end coverage for empty windows
- Organize extension source modules by responsibility

## 0.1.0

Initial release.

- Containers, Images, Networks, Volumes and Registries views for Apple `container`
- Container lifecycle: start, stop, restart, kill, delete, logs, boot logs, shell, inspect, prune
- Containers expand into Volumes and Ports when they have any; ports open in the browser
- container-compose projects grouped in the Containers view, with Compose Up / Down and group actions
- Edit published ports and mounts of a container (recreates it, optionally keeping its filesystem changes)
- Live stats charts (CPU, memory, network I/O, block I/O)
- Image pull, build (from Dockerfile / Containerfile), run, tag, delete, prune
- Registry login / logout with the password passed on stdin
- Status bar item for the container system service: start, stop, status, disk usage, logs
- English and Simplified Chinese

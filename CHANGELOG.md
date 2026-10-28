# Changelog

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

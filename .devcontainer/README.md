# Development container

The development container provides the pinned Node.js 24 and npm toolchain used by CI. It stores
dependencies, bundles, coverage, and the npm cache on named volumes and does not mount the host
Docker socket.

Open the repository with **Dev Containers: Reopen in Container**, or use the Dev Container CLI:

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash .devcontainer/verify.sh
```

The post-create step runs npm ci. The verification script runs the complete repository checks and
builds release artifacts. Upstream regeneration remains explicit: mount or clone systemd, Podman,
and mkosi separately and set the source environment variables when changing language data.

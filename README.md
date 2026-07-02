# rsync-action

[![check](https://trev.zip/llc/rsync-action/actions/workflows/check.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=check&labelColor=%23313244)](https://trev.zip/llc/rsync-action/actions?workflow=check.yaml)
[![vulnerable](https://trev.zip/llc/rsync-action/actions/workflows/vulnerable.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=vulnerable&labelColor=%23313244)](https://trev.zip/llc/rsync-action/actions?workflow=vulnerable.yaml)
[![node](https://img.shields.io/badge/dynamic/json?url=https://trev.zip/llc/rsync-action/raw/branch/main/package.json&query=%24.engines.node&logo=nodedotjs&logoColor=%23bac2de&label=version&labelColor=%23313244&color=%23339933)](https://nodejs.org/en/about/previous-releases)

Pulls a file or directory from an rsync daemon, then pushes it back when the workflow finishes

```yaml
- uses: spotdemo4/rsync-action@main
  with:
    server: rsync.example.com:873
    module: backups
    remote-path: project/
    local-path: project/
    secret: ${{ secrets.RSYNC_SECRET }}
```

`secret` must be `username:password`. The action passes the password via `RSYNC_PASSWORD`, so it targets an rsync daemon (`rsyncd`) and does not use SSH.

TLS is enabled by default, set `tls: false` for a plain rsync daemon.

`remote-path` and `local-path` preserve normal rsync trailing slash semantics. For directory contents, include trailing slashes on both paths. A `local-path` of `~` or leading `~/` is expanded to `HOME` before rsync runs.

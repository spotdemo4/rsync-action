# rsync-action

Pull a file or directory from an rsync daemon before a job step runs, then push it back from the action's post step after later steps have changed it.

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

TLS is enabled by default for an `rsync-ssl` daemon. Set `tls: false` for a plain rsync daemon. The action runs `rsync` directly and uses a generated Node TLS remote-shell helper for TLS, so it does not require the `rsync-ssl` script or an `openssl` command. Missing Linux x64 and Linux arm64 `rsync` tools are restored from the Actions tool cache or downloaded from the static `rsync-v*` GitHub release assets and then added to the tool cache with `@actions/tool-cache`.

`remote-path` and `local-path` preserve normal rsync trailing slash semantics. For directory contents, include trailing slashes on both paths. A `local-path` of `~` or leading `~/` is expanded to `HOME` before rsync runs.

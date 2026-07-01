# rsync-action

Pull a file or directory from an rsync daemon before a job step runs, then push it back from the action's post step after later steps have changed it.

```yaml
- uses: your-org/rsync-action@v1
  with:
    server: rsync.example.com:873
    module: backups
    remote-path: project/
    local-path: project/
    secret: ${{ secrets.RSYNC_SECRET }}
```

`secret` must be `username:password`. The action passes the password via `RSYNC_PASSWORD`, so it targets an rsync daemon (`rsyncd`) and does not use SSH.

TLS is enabled by default for an `rsync-ssl` daemon. Set `tls: false` for a plain rsync daemon. With TLS enabled the action checks for `rsync`, `rsync-ssl`, and `openssl`; otherwise it checks for `rsync`. Missing Linux x64 and Linux arm64 tools are restored from the Actions tool cache or downloaded from Alpine edge package URLs and then added to the tool cache with `@actions/tool-cache`.

`remote-path` and `local-path` preserve normal rsync trailing slash semantics. For directory contents, include trailing slashes on both paths.

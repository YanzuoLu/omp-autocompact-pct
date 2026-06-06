# omp-autocompact-pct

OMP extension that shows how close the last provider response was to the auto-compaction threshold.

Use this when `context_pct` is misleading for auto-compaction timing. This plugin reads the last assistant `usage.totalTokens` and compares it with OMP's effective compaction threshold.

## Install

```sh
omp plugin install github:YanzuoLu/omp-autocompact-pct
```

This package is currently distributed through GitHub releases. The npm package name is reserved in `package.json`, but npm publish requires `npm adduser` on the publishing machine.

Check that OMP sees it:

```sh
omp plugin list
```

Restart OMP after install.

## What it displays

The plugin writes a hook status line below the main statusline, for example:

```text
AC 86.2% +12.3K left (199K/231K)
AC 101.2% 2.8K over (234K/231K)
AC compacting threshold/context-full
AC compacted from 234K; waiting next usage
```

Meaning:

```text
AC <last-provider-totalTokens / auto-compaction-threshold> <headroom> (<used>/<threshold>)
```

This is intentionally different from OMP's built-in `context_pct` segment:

- `context_pct` = local estimate of active conversation footprint / model context window.
- `omp-autocompact-pct` = last provider usage / OMP auto-compaction threshold.

## Slash command

Refresh the status manually:

```text
/autocompact-pct
```

## Requirements

- OMP / `@oh-my-pi/pi-coding-agent` `>=15.9.67 <16`
- Hook status display enabled:

```yaml
statusLine:
  showHookStatus: true
```

## Update

Re-run install:

```sh
omp plugin install github:YanzuoLu/omp-autocompact-pct
```

## Uninstall

```sh
omp plugin uninstall omp-autocompact-pct
```

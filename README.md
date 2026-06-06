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

## Statusline segment

The plugin registers a statusline segment named `autocompact_pct`.

Add it to a custom statusline layout:

```yaml
statusLine:
  preset: custom
  separator: powerline
  leftSegments:
    - pi
    - hostname
    - model
    - mode
    - path
    - git
    - pr
    - subagents
  rightSegments:
    - session_name
    - autocompact_pct
    - cache_hit
    - token_in
    - token_out
    - token_rate
    - cache_read
    - cost
    - context_pct
```

It renders compactly inside the main statusline:

```text
AC 86.2% +12.3K
AC 101.2% -2.8K
AC compacting threshold
AC compacted
```

Meaning:

```text
AC <last-provider-totalTokens / auto-compaction-threshold> <remaining tokens before threshold>
```

This is intentionally different from OMP's built-in `context_pct` segment:

- `context_pct` = local estimate of active conversation footprint / model context window.
- `autocompact_pct` = last provider usage / OMP auto-compaction threshold.

Implementation note: OMP does not currently expose a public `registerStatusLineSegment` API, so this extension registers the segment through OMP's exported statusline registry. If OMP changes that internal registry before `16.x`, this plugin may need an update.

## Slash command

Refresh the status manually:

```text
/autocompact-pct
```

## Requirements

- OMP / `@oh-my-pi/pi-coding-agent` `>=15.9.67 <16`

## Update

Re-run install:

```sh
omp plugin install github:YanzuoLu/omp-autocompact-pct
```

## Uninstall

```sh
omp plugin uninstall omp-autocompact-pct
```

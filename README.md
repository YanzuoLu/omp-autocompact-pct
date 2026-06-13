# omp-autocompact-pct

OMP statusline segment that replaces the built-in local `context_pct` estimate with provider-reported context usage.

Use this when you want the statusline percentage to be based on the last assistant response's `usage.totalTokens` divided by the model context window, such as `234028 / 272000`.

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

Add it to a custom statusline layout in place of `context_pct`:
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
```

It renders like the built-in context segment, uses the same context colors, but uses provider usage:

```text
◫ 86.0%/272K ⟲
◫ compacting
◫ compacted
```

Color thresholds match `context_pct`: normal, warning, purple, and error are selected with OMP's built-in context threshold helper.

Meaning:

```text
◫ <last-provider-totalTokens / model-contextWindow>/<model-contextWindow>
```

This is intentionally different from OMP's built-in `context_pct` segment:

- `context_pct` = local estimate of active conversation footprint / model context window.
- `autocompact_pct` = last provider `usage.totalTokens` / model context window.

Implementation note: OMP does not currently expose a public `registerStatusLineSegment` API, so this extension registers the segment by mutating OMP's statusline registry. Because OMP ships as a single bundled binary, the registry must be reached through the injected runtime namespace (`pi.pi`, the host's own module instances) — a plain `import` of the registry resolves to a *separate* on-disk copy that OMP never renders from, so the segment would silently never appear (fixed in 0.5.0; falls back to the imported registry only in source-mode/tests). If OMP changes that internal registry before `16.x`, this plugin may need an update.

## Slash command

Refresh the status manually:

```text
/autocompact-pct
```

## Requirements

- OMP / `@oh-my-pi/pi-coding-agent` `>=15.9.67 <16`

## Update

Install the current tagged release:

```sh
omp plugin install github:YanzuoLu/omp-autocompact-pct#v0.4.0
```

If OMP keeps an older git dependency in its plugin lock, remove it first:

```sh
omp plugin uninstall omp-autocompact-pct
omp plugin install github:YanzuoLu/omp-autocompact-pct#v0.4.0
```

## Uninstall

```sh
omp plugin uninstall omp-autocompact-pct
```

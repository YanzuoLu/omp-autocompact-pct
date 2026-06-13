import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ALL_SEGMENT_IDS, SEGMENTS } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/context-thresholds";
import { theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const SEGMENT_ID = "autocompact_pct";
const RENDER_INVALIDATE_KEY = "omp-autocompact-pct-render";

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};


type ContextUsageLike = {
  contextWindow: number;
};

type UiLike = {
  setStatus(key: string, text: string | undefined): void;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
};

type SessionManagerLike = {
  getBranch?(): unknown[];
  getEntries?(): unknown[];
};

type RuntimeContextLike = {
  ui?: UiLike;
  model?: { contextWindow?: number };
  getContextUsage?(): ContextUsageLike | undefined;
  sessionManager?: SessionManagerLike;
};

type SegmentContextLike = {
  session?: {
    model?: { contextWindow?: number };
    sessionManager?: SessionManagerLike;
  };
  contextWindow?: number;
  autoCompactEnabled?: boolean;
};

type RenderSource = RuntimeContextLike | SegmentContextLike;


type RelevantEntry =
  | { kind: "usage"; usage: UsageLike; stopReason?: string }
  | { kind: "compaction"; tokensBefore?: number };

let transientText: string | undefined;

// omp ships as a single `// @bun` bundle: its `SEGMENTS`/`theme`/context-threshold
// modules live INSIDE the bundle, so the copies we `import` above resolve to a
// separate on-disk package and are DIFFERENT module instances. Mutating the
// imported `SEGMENTS` registers the segment into a registry omp never renders
// from — which is why the segment shows nothing. The factory's `pi.pi` is omp's
// OWN runtime namespace (the exact instance it renders with), so we prefer it for
// every host binding and only fall back to the static imports for source-mode /
// tests where the two coincide.
type OmpRuntime = {
	SEGMENTS: typeof SEGMENTS;
	ALL_SEGMENT_IDS: typeof ALL_SEGMENT_IDS;
	theme: typeof theme;
	formatContextUsage: typeof formatContextUsage;
	getContextUsageLevel: typeof getContextUsageLevel;
	getContextUsageThemeColor: typeof getContextUsageThemeColor;
};
let runtime: Partial<OmpRuntime> = {};

const hostSegments = (): typeof SEGMENTS => runtime.SEGMENTS ?? SEGMENTS;
const hostSegmentIds = (): string[] => (runtime.ALL_SEGMENT_IDS ?? ALL_SEGMENT_IDS) as string[];
const hostTheme = (): typeof theme | undefined => runtime.theme ?? theme;
const hostFormatContextUsage: typeof formatContextUsage = (...args) =>
	(runtime.formatContextUsage ?? formatContextUsage)(...args);
const hostGetContextUsageLevel: typeof getContextUsageLevel = (...args) =>
	(runtime.getContextUsageLevel ?? getContextUsageLevel)(...args);
const hostGetContextUsageThemeColor: typeof getContextUsageThemeColor = (...args) =>
	(runtime.getContextUsageThemeColor ?? getContextUsageThemeColor)(...args);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function calculateContextTokens(usage: UsageLike): number {
  const totalTokens = finiteNumber(usage.totalTokens);
  if (totalTokens > 0) return totalTokens;
  return finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheRead) + finiteNumber(usage.cacheWrite);
}

function currentTheme() {
  return hostTheme();
}

function autoCompactSuffix(source: RenderSource): string {
  const activeTheme = currentTheme();
  return (source as SegmentContextLike).autoCompactEnabled && activeTheme?.icon.auto ? ` ${activeTheme.icon.auto}` : "";
}

function withIcon(icon: string | undefined, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function renderContextContent(text: string, pct?: number, contextWindow?: number): string {
  const activeTheme = currentTheme();
  if (!activeTheme) return withIcon("◫", text);

  const color = pct === undefined || contextWindow === undefined
    ? "statusLineContext"
    : hostGetContextUsageThemeColor(hostGetContextUsageLevel(pct, contextWindow));
  return withIcon(activeTheme.icon.context, activeTheme.fg(color, text));
}

function contextWindowFor(source: RenderSource): number {
  const directWindow = positiveNumber((source as SegmentContextLike).contextWindow);
  if (directWindow !== undefined) return directWindow;

  const runtime = source as RuntimeContextLike;
  const runtimeModelWindow = positiveNumber(runtime.model?.contextWindow);
  if (runtimeModelWindow !== undefined) return runtimeModelWindow;

  const usageWindow = positiveNumber(runtime.getContextUsage?.()?.contextWindow);
  if (usageWindow !== undefined) return usageWindow;

  const segment = source as SegmentContextLike;
  return positiveNumber(segment.session?.model?.contextWindow) ?? 0;
}

function sessionManagerFor(source: RenderSource): SessionManagerLike | undefined {
  const runtime = source as RuntimeContextLike;
  if (runtime.sessionManager) return runtime.sessionManager;
  return (source as SegmentContextLike).session?.sessionManager;
}

function assistantUsage(message: unknown): { usage: UsageLike; stopReason?: string } | undefined {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return undefined;
  const usage = asRecord(record.usage);
  if (!usage) return undefined;
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
  if (stopReason === "aborted" || stopReason === "error") return undefined;
  return {
    usage: {
      input: finiteNumber(usage.input),
      output: finiteNumber(usage.output),
      cacheRead: finiteNumber(usage.cacheRead),
      cacheWrite: finiteNumber(usage.cacheWrite),
      totalTokens: finiteNumber(usage.totalTokens),
    },
    stopReason,
  };
}

function latestRelevantEntry(source: RenderSource): RelevantEntry | undefined {
  const branch = sessionManagerFor(source)?.getBranch?.() ?? sessionManagerFor(source)?.getEntries?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = asRecord(branch[i]);
    if (!entry) continue;
    if (entry.type === "compaction") {
      return { kind: "compaction", tokensBefore: positiveNumber(entry.tokensBefore) };
    }
    if (entry.type === "message") {
      const usage = assistantUsage(entry.message);
      if (usage) return { kind: "usage", ...usage };
    }
  }
  return undefined;
}

function trimNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatTokens(tokens: number): string {
  const sign = tokens < 0 ? "-" : "";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${sign}${trimNumber(abs / 1_000_000, abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${sign}${trimNumber(abs / 1_000, abs >= 100_000 ? 0 : 1)}K`;
  return `${sign}${Math.round(abs)}`;
}

function formatPercent(value: number): string {
  return `${trimNumber(value, 1)}%`;
}

function providerWindowStats(usage: UsageLike, source: RenderSource): { used: number; contextWindow: number; pct: number } | undefined {
  const contextWindow = contextWindowFor(source);
  if (contextWindow <= 0) return undefined;

  const used = calculateContextTokens(usage);
  return { used, contextWindow, pct: (used / contextWindow) * 100 };
}

function renderCompactUsageStatus(usage: UsageLike, source: RenderSource): string | undefined {
  const stats = providerWindowStats(usage, source);
  if (!stats) return undefined;
  const text = `${hostFormatContextUsage(stats.pct, stats.contextWindow)}${autoCompactSuffix(source)}`;
  return renderContextContent(text, stats.pct, stats.contextWindow);
}

function renderDetailedUsageStatus(usage: UsageLike, source: RenderSource): string {
  const stats = providerWindowStats(usage, source);
  if (!stats) return "Provider context usage unavailable";
  return `Provider context ${formatPercent(stats.pct)}/${formatTokens(stats.contextWindow)} (${formatTokens(stats.used)} used)`;
}

function renderLatestSegment(source: RenderSource): string | undefined {
  if (transientText) return renderContextContent(transientText);

  const latest = latestRelevantEntry(source);
  if (!latest) return undefined;
  if (latest.kind === "compaction") return renderContextContent("waiting");
  return renderCompactUsageStatus(latest.usage, source);
}

function renderLatestDetail(source: RenderSource): string {
  const latest = latestRelevantEntry(source);
  if (!latest) return "Provider context usage pending";
  if (latest.kind === "compaction") {
    const suffix = latest.tokensBefore ? ` from ${formatTokens(latest.tokensBefore)}` : "";
    return `Provider context compacted${suffix}; waiting next provider usage`;
  }
  return renderDetailedUsageStatus(latest.usage, source);
}

function clearTransientAndInvalidate(ctx: RuntimeContextLike): void {
  transientText = undefined;
  ctx.ui?.setStatus(RENDER_INVALIDATE_KEY, undefined);
}

function invalidate(ctx: RuntimeContextLike): void {
  ctx.ui?.setStatus(RENDER_INVALIDATE_KEY, undefined);
}

function registerStatusLineSegment(_pi: ExtensionAPI): boolean {
  const segments = hostSegments();
  segments[SEGMENT_ID] = {
    id: SEGMENT_ID,
    render(ctx: SegmentContextLike) {
      const content = renderLatestSegment(ctx);
      return { content: content ?? "", visible: content !== undefined };
    },
  } as (typeof SEGMENTS)[keyof typeof SEGMENTS];

  const segmentIds = hostSegmentIds();
  if (!segmentIds.includes(SEGMENT_ID)) segmentIds.push(SEGMENT_ID);
  return true;
}

export default function autocompactPct(pi: ExtensionAPI) {
  pi.setLabel("Auto Compact Percent");

  // Bind to omp's OWN runtime exports (same module instances it renders with).
  // `pi.pi` is the injected `@oh-my-pi/pi-coding-agent` namespace; the bare
  // `import`s at the top of this file resolve to a separate bundled copy.
  runtime = ((pi as unknown as { pi?: Partial<OmpRuntime> }).pi) ?? {};

  if (!registerStatusLineSegment(pi)) {
    pi.logger.warn("omp-autocompact-pct could not register status line segment", { segment: SEGMENT_ID });
  }

  pi.on("session_start", (_event, ctx) => {
    clearTransientAndInvalidate(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    clearTransientAndInvalidate(ctx);
  });

  pi.on("session_branch", (_event, ctx) => {
    clearTransientAndInvalidate(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!assistantUsage(event.message)) return;
    clearTransientAndInvalidate(ctx);
  });

  pi.on("auto_compaction_start", (_event, ctx) => {
    transientText = "compacting";
    invalidate(ctx);
  });

  pi.on("auto_compaction_end", (event, ctx) => {
    if (event.skipped) {
      clearTransientAndInvalidate(ctx);
      return;
    }
    if (event.aborted || event.errorMessage) {
      transientText = "compact failed";
      invalidate(ctx);
      return;
    }
    transientText = "compacted";
    invalidate(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    transientText = "compacted";
    invalidate(ctx);
  });

  pi.registerCommand("autocompact-pct", {
    description: "Refresh and print the provider context-window usage status.",
    handler: async (_args, ctx) => {
      clearTransientAndInvalidate(ctx);
      ctx.ui.notify?.(renderLatestDetail(ctx), "info");
    },
  });
}

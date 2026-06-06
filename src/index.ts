import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ALL_SEGMENT_IDS, SEGMENTS } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";

const SEGMENT_ID = "autocompact_pct";
const RENDER_INVALIDATE_KEY = "omp-autocompact-pct-render";
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_RESERVE_FRACTION = 0.15;

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type CompactionSettingsLike = {
  enabled?: boolean;
  strategy?: "context-full" | "handoff" | "shake" | "off" | string;
  thresholdPercent?: number;
  thresholdTokens?: number;
  reserveTokens?: number;
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
};

type RenderSource = RuntimeContextLike | SegmentContextLike;

type RenderedSegmentLike = { content: string; visible: boolean };

type RelevantEntry =
  | { kind: "usage"; usage: UsageLike; stopReason?: string }
  | { kind: "compaction"; tokensBefore?: number };

let transientText: string | undefined;

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

function resolveThresholdTokens(contextWindow: number, settings: CompactionSettingsLike): number | undefined {
  if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return undefined;

  const thresholdTokens = positiveNumber(settings.thresholdTokens);
  if (thresholdTokens !== undefined) {
    return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
  }

  const thresholdPercent = positiveNumber(settings.thresholdPercent);
  if (thresholdPercent !== undefined) {
    const clamped = Math.min(99, Math.max(1, thresholdPercent));
    return Math.floor(contextWindow * (clamped / 100));
  }

  const configuredReserve = positiveNumber(settings.reserveTokens) ?? DEFAULT_RESERVE_TOKENS;
  const reserve = Math.max(Math.floor(contextWindow * DEFAULT_RESERVE_FRACTION), configuredReserve);
  return Math.max(1, contextWindow - reserve);
}

function readCompactionSettings(pi: ExtensionAPI): CompactionSettingsLike {
  try {
    const exported = pi.pi as { settings?: { getGroup?(prefix: "compaction"): unknown } };
    const group = asRecord(exported.settings?.getGroup?.("compaction"));
    if (!group) return defaultCompactionSettings();
    return {
      enabled: typeof group.enabled === "boolean" ? group.enabled : true,
      strategy: typeof group.strategy === "string" ? group.strategy : "context-full",
      thresholdPercent: finiteNumber(group.thresholdPercent),
      thresholdTokens: finiteNumber(group.thresholdTokens),
      reserveTokens: finiteNumber(group.reserveTokens) || DEFAULT_RESERVE_TOKENS,
    };
  } catch {
    return defaultCompactionSettings();
  }
}

function defaultCompactionSettings(): CompactionSettingsLike {
  return {
    enabled: true,
    strategy: "context-full",
    thresholdPercent: -1,
    thresholdTokens: -1,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
  };
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
  return `${trimNumber(value, value >= 100 ? 1 : 2)}%`;
}

function usageStats(usage: UsageLike, source: RenderSource, pi: ExtensionAPI): { used: number; threshold: number; headroom: number; pct: number } | undefined {
  const contextWindow = contextWindowFor(source);
  if (contextWindow <= 0) return undefined;

  const threshold = resolveThresholdTokens(contextWindow, readCompactionSettings(pi));
  if (threshold === undefined) return undefined;

  const used = calculateContextTokens(usage);
  const headroom = threshold - used;
  return { used, threshold, headroom, pct: threshold > 0 ? (used / threshold) * 100 : 0 };
}

function renderCompactUsageStatus(usage: UsageLike, source: RenderSource, pi: ExtensionAPI): string | undefined {
  const stats = usageStats(usage, source, pi);
  if (!stats) return "AC off";
  const signedHeadroom = stats.headroom >= 0 ? `+${formatTokens(stats.headroom)}` : formatTokens(stats.headroom);
  return `AC ${formatPercent(stats.pct)} ${signedHeadroom}`;
}

function renderDetailedUsageStatus(usage: UsageLike, source: RenderSource, pi: ExtensionAPI): string {
  const stats = usageStats(usage, source, pi);
  if (!stats) return "AC off";
  const status = stats.headroom >= 0 ? `+${formatTokens(stats.headroom)} left` : `${formatTokens(-stats.headroom)} over`;
  return `AC ${formatPercent(stats.pct)} ${status} (${formatTokens(stats.used)}/${formatTokens(stats.threshold)})`;
}

function renderLatestSegment(source: RenderSource, pi: ExtensionAPI): string | undefined {
  if (transientText) return transientText;

  const latest = latestRelevantEntry(source);
  if (!latest) return undefined;
  if (latest.kind === "compaction") return "AC waiting";
  return renderCompactUsageStatus(latest.usage, source, pi);
}

function renderLatestDetail(source: RenderSource, pi: ExtensionAPI): string {
  const latest = latestRelevantEntry(source);
  if (!latest) return "AC usage pending";
  if (latest.kind === "compaction") {
    const suffix = latest.tokensBefore ? ` from ${formatTokens(latest.tokensBefore)}` : "";
    return `AC compacted${suffix}; waiting next provider usage`;
  }
  return renderDetailedUsageStatus(latest.usage, source, pi);
}

function clearTransientAndInvalidate(ctx: RuntimeContextLike): void {
  transientText = undefined;
  ctx.ui?.setStatus(RENDER_INVALIDATE_KEY, undefined);
}

function invalidate(ctx: RuntimeContextLike): void {
  ctx.ui?.setStatus(RENDER_INVALIDATE_KEY, undefined);
}

function registerStatusLineSegment(pi: ExtensionAPI): boolean {
  SEGMENTS[SEGMENT_ID] = {
    id: SEGMENT_ID,
    render(ctx: SegmentContextLike) {
      const content = renderLatestSegment(ctx, pi);
      return { content: content ?? "", visible: content !== undefined };
    },
  } as (typeof SEGMENTS)[keyof typeof SEGMENTS];

  const segmentIds = ALL_SEGMENT_IDS as string[];
  if (!segmentIds.includes(SEGMENT_ID)) segmentIds.push(SEGMENT_ID);

  return true;
}

export default function autocompactPct(pi: ExtensionAPI) {
  pi.setLabel("Auto Compact Percent");

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

  pi.on("auto_compaction_start", (event, ctx) => {
    transientText = `AC compacting ${event.reason}`;
    invalidate(ctx);
  });

  pi.on("auto_compaction_end", (event, ctx) => {
    if (event.skipped) {
      clearTransientAndInvalidate(ctx);
      return;
    }
    if (event.aborted || event.errorMessage) {
      transientText = "AC compact failed";
      invalidate(ctx);
      return;
    }
    transientText = "AC compacted";
    invalidate(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    transientText = "AC compacted";
    invalidate(ctx);
  });

  pi.registerCommand("autocompact-pct", {
    description: "Refresh and print the auto-compaction threshold headroom status.",
    handler: async (_args, ctx) => {
      clearTransientAndInvalidate(ctx);
      ctx.ui.notify?.(renderLatestDetail(ctx, pi), "info");
    },
  });
}

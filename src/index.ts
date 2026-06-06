import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "omp-autocompact-pct";
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

type ContextLike = {
  ui: UiLike;
  model?: { contextWindow?: number };
  getContextUsage?(): ContextUsageLike | undefined;
  sessionManager?: SessionManagerLike;
};

type RelevantEntry =
  | { kind: "usage"; usage: UsageLike; stopReason?: string }
  | { kind: "compaction"; tokensBefore?: number };

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

function contextWindowFor(ctx: ContextLike): number {
  const modelWindow = positiveNumber(ctx.model?.contextWindow);
  if (modelWindow !== undefined) return modelWindow;
  const usageWindow = positiveNumber(ctx.getContextUsage?.()?.contextWindow);
  return usageWindow ?? 0;
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

function latestRelevantEntry(ctx: ContextLike): RelevantEntry | undefined {
  const branch = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
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

function renderUsageStatus(usage: UsageLike, ctx: ContextLike, pi: ExtensionAPI): string {
  const contextWindow = contextWindowFor(ctx);
  if (contextWindow <= 0) return "AC ? no context window";

  const settings = readCompactionSettings(pi);
  const threshold = resolveThresholdTokens(contextWindow, settings);
  if (threshold === undefined) return "AC off";

  const used = calculateContextTokens(usage);
  const headroom = threshold - used;
  const pct = threshold > 0 ? (used / threshold) * 100 : 0;
  const status = headroom >= 0 ? `+${formatTokens(headroom)} left` : `${formatTokens(-headroom)} over`;
  return `AC ${formatPercent(pct)} ${status} (${formatTokens(used)}/${formatTokens(threshold)})`;
}

function setFromLatest(ctx: ContextLike, pi: ExtensionAPI): void {
  const latest = latestRelevantEntry(ctx);
  if (!latest) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  if (latest.kind === "compaction") {
    const suffix = latest.tokensBefore ? ` from ${formatTokens(latest.tokensBefore)}` : "";
    ctx.ui.setStatus(STATUS_KEY, `AC compacted${suffix}; waiting next usage`);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(latest.usage, ctx, pi));
}

export default function autocompactPct(pi: ExtensionAPI) {
  pi.setLabel("Auto Compact Percent");

  pi.on("session_start", (_event, ctx) => {
    setFromLatest(ctx, pi);
  });

  pi.on("session_switch", (_event, ctx) => {
    setFromLatest(ctx, pi);
  });

  pi.on("session_branch", (_event, ctx) => {
    setFromLatest(ctx, pi);
  });

  pi.on("message_end", (event, ctx) => {
    const usage = assistantUsage(event.message);
    if (!usage) return;
    ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(usage.usage, ctx, pi));
  });

  pi.on("auto_compaction_start", (event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, `AC compacting ${event.reason}/${event.action}`);
  });

  pi.on("auto_compaction_end", (event, ctx) => {
    if (event.skipped) {
      setFromLatest(ctx, pi);
      return;
    }
    if (event.aborted || event.errorMessage) {
      ctx.ui.setStatus(STATUS_KEY, `AC compact failed: ${event.errorMessage ?? "aborted"}`);
      return;
    }
    const suffix = event.result?.tokensBefore ? ` from ${formatTokens(event.result.tokensBefore)}` : "";
    ctx.ui.setStatus(STATUS_KEY, `AC compacted${suffix}; waiting next usage`);
  });

  pi.on("session_compact", (event, ctx) => {
    const tokensBefore = positiveNumber(asRecord(event.compactionEntry)?.tokensBefore);
    const suffix = tokensBefore ? ` from ${formatTokens(tokensBefore)}` : "";
    ctx.ui.setStatus(STATUS_KEY, `AC compacted${suffix}; waiting next usage`);
  });

  pi.registerCommand("autocompact-pct", {
    description: "Refresh the auto-compaction threshold headroom status.",
    handler: async (_args, ctx) => {
      setFromLatest(ctx, pi);
      const latest = latestRelevantEntry(ctx);
      const message = latest?.kind === "usage" ? renderUsageStatus(latest.usage, ctx, pi) : "AC usage pending";
      ctx.ui.notify?.(message, "info");
    },
  });
}

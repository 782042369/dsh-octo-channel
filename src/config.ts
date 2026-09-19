/** Serializable configuration, schema, and direct-call defaults. */
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { SessionScope } from "./conversation.js";

/**
 * Human-interaction tools whose answer cannot reach a chat: both ask through
 * the host question seam, whose provider belongs to whichever UI registered
 * it first. Denied per chat agent so the model asks in the chat instead.
 */
const DEFAULT_DENY_TOOLS = ["ask_user_question", "exit_plan_mode"] as const;

/** The default chat workspace directory for Octo-driven agents. */
export function defaultChatWorkspaceDir(): string {
  return join(homedir(), ".dsh-octo");
}

/** Plugin configuration supplied by the profile composition or settings. */
export interface Config {
  /** Octo bot token: bf_ (BotFather user bot) or app_ (admin app bot). */
  botToken?: string;
  /** Octo server REST API base URL, e.g. https://im.example.com/api. */
  apiUrl?: string;
  /** WuKongIM WebSocket URL; auto-detected from the register response when omitted. */
  wsUrl?: string;
  /** Absolute workspace directory for chat-driven agents; defaults to ~/.dsh-octo. */
  cwd?: string;
  /** Provider route override for chat agents. */
  provider?: string;
  /** Model id override for chat agents. */
  model?: string;
  /** Agent preset chat agents join, when the deployment composes a roster. */
  preset?: string;
  /**
   * Which conversation facet owns one agent session. chat: every chat (DM,
   * group, or thread) one agent. chat-sender: each sender in a group gets
   * their own session.
   */
  sessionScope?: SessionScope;
  /** In group chats, only respond when the bot is @-mentioned. */
  requireMention?: boolean;
  /**
   * Keep chat turns lean (default true): the chat agent skips per-round
   * memory/todo wrap-up protocols so replies stay fast; it still uses those
   * tools when the user explicitly asks.
   */
  leanChat?: boolean;
  /**
   * If the first answer is not ready within this many milliseconds, send a
   * "received, working on it" ack. 0 disables the ack. Default 3000.
   */
  ackDelayMs?: number;
  /** Tools chat agents may not call, denied per agent at execution. */
  denyTools?: string[];
  /** Explicit sender allowlist; an empty list means allow all senders. */
  allowedUserIds?: string[];
  /** Explicit chat allowlist; an empty list means allow all chats. */
  allowedChatIds?: string[];
  /** Access mode: owner-only by default, explicit allowlist, or intentionally open. */
  accessMode?: "owner" | "allowlist" | "open";
  /** Sender denylist, evaluated before the allowlists. */
  deniedUserIds?: string[];
  /** Chat denylist, evaluated before the allowlists. */
  deniedChatIds?: string[];
  /** Maximum inbound text length accepted from Octo. */
  maxMessageChars?: number;
  /** Maximum queued turns per conversation before applying backpressure. */
  maxQueuedTurns?: number;
  /** Outbound replies longer than this are split into several chat messages. */
  maxReplyChars?: number;
  /** Finalize a turn in the chat when the host stops emitting events for this long. */
  turnIdleTimeoutMs?: number;
  /** Interval of the Octo online-status heartbeat. */
  heartbeatIntervalMs?: number;
}

/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
  botToken?: string | undefined;
  apiUrl?: string | undefined;
  wsUrl?: string | undefined;
  cwd: string;
  provider?: string | undefined;
  model?: string | undefined;
  preset?: string | undefined;
  sessionScope: SessionScope;
  requireMention: boolean;
  leanChat: boolean;
  accessMode: "owner" | "allowlist" | "open";
  ackDelayMs: number;
  denyTools: string[];
  allowedUserIds: string[];
  allowedChatIds: string[];
  deniedUserIds: string[];
  deniedChatIds: string[];
  maxMessageChars: number;
  maxQueuedTurns: number;
  maxReplyChars: number;
  turnIdleTimeoutMs: number;
  heartbeatIntervalMs: number;
}

/** Loader-visible configuration schema and defaults. */
export const Config: z<Config> = z.object({
  botToken: z.string().role("secret"),
  apiUrl: z.string(),
  wsUrl: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string(),
  preset: z.string(),
  sessionScope: z.union(["chat", "chat-sender"] as const).default("chat"),
  requireMention: z.boolean().default(true),
  leanChat: z.boolean().default(true),
  accessMode: z.union(["owner", "allowlist", "open"] as const).default("owner"),
  ackDelayMs: z.number().default(3000),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
  allowedUserIds: z.array(String).default([]),
  allowedChatIds: z.array(String).default([]),
  deniedUserIds: z.array(String).default([]),
  deniedChatIds: z.array(String).default([]),
  maxMessageChars: z.number().default(12000),
  maxQueuedTurns: z.number().default(3),
  maxReplyChars: z.number().default(3500),
  turnIdleTimeoutMs: z.number().default(1_800_000),
  heartbeatIntervalMs: z.number().default(30000),
});

/** Normalize a string list into a trimmed, duplicate-free policy set. */
function normalizeIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** Clamp a finite numeric setting to a safe integer range. */
function clampInt(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

/** Defaults for direct callers that bypass the Cordis Loader. */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    botToken: config.botToken,
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    cwd: config.cwd ?? defaultChatWorkspaceDir(),
    provider: config.provider,
    model: config.model,
    preset: config.preset,
    sessionScope: config.sessionScope ?? "chat",
    requireMention: config.requireMention ?? true,
    leanChat: config.leanChat ?? true,
    accessMode: config.accessMode === "allowlist" || config.accessMode === "open" ? config.accessMode : "owner",
    ackDelayMs: clampInt(config.ackDelayMs, 3000, 0, 300_000),
    denyTools: normalizeIds(config.denyTools ?? [...DEFAULT_DENY_TOOLS]),
    allowedUserIds: normalizeIds(config.allowedUserIds),
    allowedChatIds: normalizeIds(config.allowedChatIds),
    deniedUserIds: normalizeIds(config.deniedUserIds),
    deniedChatIds: normalizeIds(config.deniedChatIds),
    maxMessageChars: clampInt(config.maxMessageChars, 12_000, 256, 200_000),
    maxQueuedTurns: clampInt(config.maxQueuedTurns, 3, 1, 32),
    maxReplyChars: clampInt(config.maxReplyChars, 3_500, 500, 50_000),
    turnIdleTimeoutMs: clampInt(config.turnIdleTimeoutMs, 1_800_000, 30_000, 86_400_000),
    heartbeatIntervalMs: clampInt(config.heartbeatIntervalMs, 30_000, 5_000, 300_000),
  };
}
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
  ackDelayMs: number;
  denyTools: string[];
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
  ackDelayMs: z.number().default(3000),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
  heartbeatIntervalMs: z.number().default(30000),
});

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
    ackDelayMs: config.ackDelayMs ?? 3000,
    denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
  };
}
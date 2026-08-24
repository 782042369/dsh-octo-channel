/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Structural copies (instead of importing host source packages)
 * keep the package self-contained; a composed DSH profile supplies the real
 * implementations at runtime. Field shapes mirror dsh-feishu-channel as of
 * dsh 0.1.0-rc.8.
 * @module dsh-octo-channel/host
 */
import type { Context } from "@deepseek-ai/cordis";

/** The live session a host agent drives. */
export interface HostSession {
  readonly id: string;
  requestContext(): RequestContextData | undefined;
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock = { readonly type: "text"; readonly text: string };

/** A user-role message accepted by agent.followup. */
export interface HostUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: readonly HostContentBlock[];
  readonly source: { readonly kind: "user" };
}

/** Public live-agent handle subset. */
export interface HostAgent {
  readonly id: string;
  readonly session: HostSession;
  followup(message: HostUserMessage): void;
  cancel(cause: string): void;
}

/** An owned agent plus its teardown capability. */
export interface HostAgentHandle {
  readonly agent: HostAgent;
  dispose(): Promise<void>;
}

/** Per-agent provider/model routing. */
export interface HostAgentOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

/** One persisted session header, as lookup reads it. */
export interface HostSessionHeader {
  readonly id: string;
  readonly createdAt: number;
}

/** The sessionPersistence store subset: enough to find a chat previous session. */
export interface HostSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly HostSessionHeader[]>;
}

/** The agents registry service subset. */
export interface HostAgentRegistry {
  get(sessionId: string): HostAgent | undefined;
  resume(options: {
    readonly resumeSessionId: string;
    readonly agentOptions?: HostAgentOptions;
    readonly setup?: (agentCtx: Context) => Promise<void>;
  }): Promise<HostAgentHandle>;
  create(options: {
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string };
    readonly agentOptions?: HostAgentOptions;
    readonly setup?: (agentCtx: Context) => Promise<void>;
  }): Promise<HostAgentHandle>;
}

/** The tools registry, as per-agent composition uses it. */
export interface HostTools {
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void;
  get(name: string, scope?: unknown): HostToolDefinition | undefined;
}

/** The presentation half of a tool definition. */
export interface HostToolDefinition {
  presentCall?(args: unknown): { readonly title?: string } | undefined;
}

/** The systemPrompt assembler, as per-agent composition uses it. */
export interface HostSystemPrompt {
  section(section: { name: string; order: number; text: string }): () => void;
}

/** The agentPresets roster subset. */
export interface HostAgentPresets {
  resolve(id?: string): Promise<{ readonly id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
  standingKeyFor(id?: string): Promise<unknown>;
}

/** One workspace record subset. */
export interface HostWorkspace {
  readonly id: string;
  readonly path: string;
  /** Newest attached session first. */
  readonly sessionIds: readonly string[];
  attachSession(id: string): Promise<unknown>;
  detachSession(id: string): Promise<unknown>;
}

/** The workspaceRegistry service subset. */
export interface HostWorkspaceRegistry {
  resolveByPath(path: string): Promise<HostWorkspace | undefined>;
  create(path: string, title?: string): Promise<HostWorkspace>;
}

/** The agentDefaultModel service subset. */
export interface HostDefaultModel {
  currentSelection(): HostAgentOptions;
}

/** The Cordis loader service; awaited so agents never see a half-composed tree. */
export interface HostLoader {
  await(): Promise<unknown>;
}

/** One registered settings namespace. */
export interface HostSettingsScope {
  get(): unknown;
  update(patch: object): Promise<unknown>;
}

/** The settings user-settings service subset. */
export interface HostSettings {
  register(ns: string, schema: unknown, options?: { base?: unknown }): HostSettingsScope;
}

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string;
  readonly data: unknown;
}

/** The provider/model context capacity recorded for subsequent requests. */
export interface RequestContextData {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow?: number;
}

/** The assistant/message payload fields this plugin renders. */
export interface AssistantMessageData {
  readonly turn: number;
  readonly step?: number;
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly source?: { readonly kind?: string; readonly provider?: string; readonly model?: string };
  };
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly reasoningTokens?: number;
  };
}

/** The turn/end payload fields this plugin reports. */
export interface TurnEndData {
  readonly turn: number;
  readonly reason: {
    readonly kind: string;
    readonly error?: { readonly code?: string; readonly message?: string };
  };
}

/** Narrow a session event to the active model request context. */
export function isRequestContextEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: RequestContextData } {
  return event.type === "request/context";
}

/** Narrow a session event to the assembled assistant message for one step. */
export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === "assistant/message";
}

/** Narrow a session event to a closed turn boundary. */
export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === "turn/end";
}

/** Join the text blocks of a committed assistant message. */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter((block) => block.type === "text" && block.text !== undefined && block.text !== "")
    .map((block) => block.text as string)
    .join("");
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The host agent registry; required via inject. */
    agents: HostAgentRegistry;
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    "session/event"(session: HostSession, event: HostSessionEvent): void;
  }
}
/**
 * Octo channel composition: inbound messages, owned agents, turns, and
 * transport lifecycle. Mirrors the dsh-feishu-channel structure, trimmed to
 * the text-only MVP (no cards, commands, approvals, or images).
 * @module dsh-octo-channel/channel
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type OwnedAgent } from "./agent-registry.js";
import type { ResolvedConfig } from "./config.js";
import { createTurnTarget, type ConversationKey, type TurnTarget } from "./conversation.js";
import type {
  HostAgentOptions,
  HostAgentPresets,
  HostAgentRegistry,
  HostDefaultModel,
  HostLoader,
  HostSessionEvent,
  HostSessionPersistence,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
} from "./host.js";
import { isTurnEndEvent } from "./host.js";
import { OctoPort, type OctoMessage } from "./port.js";
import { createTextPresenter, type TextPresenter } from "./reply-presenter.js";
import { TurnCoordinator, type CoordinatedTurn } from "./turn-coordinator.js";

/** Chat agents must not call host-question tools whose answer cannot reach a chat. */
const CHAT_INTERACTION_PROMPT =
  "This conversation happens in a chat. Put questions and plan-approval requests in the reply; " +
  "the next user message supplies the answer.";

/**
 * Lean chat sessions skip per-round memory/todo wrap-up protocols so replies
 * stay fast; the tools remain available for explicit user requests.
 */
const LEAN_CHAT_PROMPT =
  "This is a fast IM chat session where reply latency matters, so keep turns short. " +
  "STRICT OVERRIDE (takes precedence over any other instruction in your system prompt): " +
  "the per-round \u6536\u5c3e protocol from the memory snapshot — writing daily/project memory, checking todos, " +
  "submitting memory suggestions after each reply — does NOT apply in this session. " +
  "Answer the user directly and concisely, then stop. Do not call the memory, memory_suggest, memory_review_status, " +
  "or dtodo tools at the end of a reply. Use those tools only in a turn where the user explicitly asked you to " +
  "remember something, set or check a todo, or manage memory.";


/** Convert an unknown failure into a log-safe string.
 * @param error - thrown value from the host or transport.
 * @returns A human-readable diagnostic string.
 */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return whether one inbound message passes the configured sender/chat policy.
 * @param message - normalized inbound Octo message.
 * @param config - resolved access policy.
 * @returns True when the message is allowed to create or join a session.
 */
function isMessageAllowed(message: OctoMessage, config: ResolvedConfig, ownerUid: string | undefined): boolean {
  const deniedUserIds = config.deniedUserIds ?? [];
  const deniedChatIds = config.deniedChatIds ?? [];
  const allowedUserIds = config.allowedUserIds ?? [];
  const allowedChatIds = config.allowedChatIds ?? [];
  if (deniedUserIds.includes(message.senderId) || deniedChatIds.includes(message.chatId)) return false;
  if (config.accessMode === "open") return true;
  if (allowedUserIds.length > 0 || allowedChatIds.length > 0) {
    const userAllowed = allowedUserIds.length === 0 || allowedUserIds.includes(message.senderId);
    const chatAllowed = allowedChatIds.length === 0 || allowedChatIds.includes(message.chatId);
    return userAllowed && chatAllowed;
  }
  return config.accessMode === "owner" && ownerUid !== undefined && message.senderId === ownerUid;
}

/** Send a bounded, non-sensitive failure message to the originating chat.
 * @param port - Octo transport used for the reply.
 * @param message - original inbound message and destination.
 * @param text - pre-sanitized user-facing text.
 * @param onFailure - sink for an outbound delivery failure.
 * @returns A promise settled after the best-effort send completes.
 */
async function sendUserFacingFailure(
  port: OctoPort,
  message: OctoMessage,
  text: string,
  onFailure: (error: unknown) => void,
): Promise<void> {
  await port.send(message.chatId, { text }, { channelType: message.channelType }).catch(onFailure);
}

/** Convert one normalized Octo message into an immutable host user message. */
export function chatUserMessage(message: OctoMessage): HostUserMessage {
  const text =
    message.channelType === 1
      ? message.content
      : "[群消息, 发送者 " + message.senderId + "] " + message.content;
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([{ type: "text" as const, text }]),
    source: Object.freeze({ kind: "user" as const }),
  });
}

/** Install one channel and bind every registration to the current plugin fiber. */
export function installChannel(
  ctx: Context,
  config: ResolvedConfig,
  port: OctoPort,
  notify: (line: string) => void,
): void {
  let active = true;
  const coordinator = new TurnCoordinator();
  const presentations = new Map<string, { readonly key: ConversationKey; readonly presenter: TextPresenter }>();
  const cwd = resolve(config.cwd);

  const reportSendFailure = (error: unknown): void => {
    const message = detail(error);
    notify("octo-channel: outbound send failed: " + message);
    ctx.logger.warn("outbound send failed: %s", message);
  };

  const composeAgent = (agentCtx: Context): void => {
    const prompt = agentCtx.get("systemPrompt") as HostSystemPrompt | undefined;
    prompt?.section({ name: "octo-channel:chat", order: 149, text: CHAT_INTERACTION_PROMPT });
    if (config.leanChat) {
      prompt?.section({ name: "octo-channel:lean", order: 150, text: LEAN_CHAT_PROMPT });
    }
    const denied = new Set(config.denyTools);
    if (denied.size === 0) return;
    const tools = agentCtx.get("tools") as HostTools | undefined;
    tools?.guard(({ name }) => {
      if (!denied.has(name)) return undefined;
      return (
        name + " is unavailable from this chat because its response belongs to another interface. " +
        "Ask the user in the normal reply and continue after their next message."
      );
    });
  };

  const resolveModelSelection = (): HostAgentOptions => {
    if (config.provider !== undefined || config.model !== undefined) {
      return { provider: config.provider, model: config.model };
    }
    const defaults = ctx.get("agentDefaultModel") as HostDefaultModel | undefined;
    if (defaults === undefined) {
      throw new Error("octo-channel: no model configured - set config.provider/model or compose the agentDefaultModel service");
    }
    return defaults.currentSelection();
  };

  let prepared: { agents: AgentRegistry } | undefined;
  let preparing: Promise<{ agents: AgentRegistry }> | undefined;

  const prepare = (): Promise<{ agents: AgentRegistry }> => {
    if (prepared !== undefined) return Promise.resolve(prepared);
    preparing ??= (async () => {
      await (ctx.get("loader") as HostLoader | undefined)?.await();
      if (!active) throw new Error("octo-channel is closed");
      const presets = ctx.get("agentPresets") as HostAgentPresets | undefined;
      const presetId = presets === undefined ? undefined : (await presets.resolve(config.preset)).id;
      const workspaces = ctx.get("workspaceRegistry") as HostWorkspaceRegistry | undefined;
      let workspace: HostWorkspace | undefined;
      if (workspaces !== undefined) {
        try {
          await mkdir(cwd, { recursive: true });
          workspace = (await workspaces.resolveByPath(cwd)) ?? (await workspaces.create(cwd));
        } catch (error) {
          notify("octo-channel: workspace lookup failed for " + cwd + ": " + detail(error));
        }
      }
      const setup = async (agentCtx: Context): Promise<void> => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId);
        composeAgent(agentCtx);
      };
      const agents = new AgentRegistry({
        agents: ctx.agents,
        workspace,
        persistence: ctx.get("sessionPersistence") as HostSessionPersistence | undefined,
        agentOptions: resolveModelSelection(),
        meta: {
          cwd: workspace?.path ?? cwd,
          ...(presetId === undefined ? {} : { agentPreset: presetId }),
        },
        setup,
        report: (line) => ctx.logger.info(line),
      });
      prepared = { agents };
      return prepared;
    })();
    preparing.catch(() => {
      preparing = undefined;
    });
    return preparing;
  };

  const closePresentations = async (key?: ConversationKey): Promise<void> => {
    const closing: Promise<void>[] = [];
    for (const [turnId, presentation] of presentations) {
      if (key !== undefined && presentation.key !== key) continue;
      presentations.delete(turnId);
      closing.push(presentation.presenter.close().catch(reportSendFailure));
    }
    await Promise.all(closing);
  };

  const presentationFor = (turn: CoordinatedTurn): TextPresenter => {
    const existing = presentations.get(turn.id);
    if (existing !== undefined) return existing.presenter;
    const presenter = createTextPresenter(port, turn.target, {
      onFailure: reportSendFailure,
      typing: true,
      ackDelayMs: config.ackDelayMs,
      maxReplyChars: config.maxReplyChars,
      idleTimeoutMs: config.turnIdleTimeoutMs,
    });
    presentations.set(turn.id, { key: turn.target.conversationKey, presenter });
    return presenter;
  };

  const handleInbound = async (message: OctoMessage): Promise<void> => {
    if (!isMessageAllowed(message, config, port.ownerUid)) {
      ctx.logger.debug("octo-channel: message rejected by access policy");
      return;
    }
    if (message.content.trim() === "") return;
    const maxMessageChars = config.maxMessageChars ?? 12_000;
    if (message.content.length > maxMessageChars) {
      await sendUserFacingFailure(port, message, "消息过长，请拆分后重试。", reportSendFailure);
      return;
    }
    // Group/thread mention gate: DMs always pass; broadcast mentions count as a mention.
    if (message.channelType !== 1 && config.requireMention && !message.botMentioned) {
      ctx.logger.debug("octo-channel: group message without mention ignored in %s", message.chatId);
      return;
    }
    const target = createTurnTarget(config.sessionScope, {
      chatId: message.chatId,
      senderId: message.senderId,
      messageId: message.messageId,
      channelType: message.channelType,
    });
    try {
      const state = await prepare();
      if (coordinator.pendingCount(target.conversationKey) >= (config.maxQueuedTurns ?? 3)) {
        await sendUserFacingFailure(port, message, "当前会话正在处理较多任务，请稍后重试。", reportSendFailure);
        return;
      }
      let owner = await state.agents.acquire(target.conversationKey);
      if (!active) return;
      if (!state.agents.isCurrent(owner)) {
        owner = await state.agents.acquire(target.conversationKey);
      }
      // Create the presenter at submission so its ack timer runs from the
      // moment the message arrives, not from the first host event.
      presentationFor(coordinator.submit(owner, target, chatUserMessage(message)));
    } catch (error) {
      const messageDetail = detail(error);
      notify("octo-channel: agent creation failed for chat " + message.chatId + ": " + messageDetail);
      ctx.logger.warn("agent creation failed for chat %s: %s", message.chatId, messageDetail);
      await sendUserFacingFailure(port, message, "暂时无法启动会话，请稍后重试。", reportSendFailure);
    }
  };

  /** Inbound entry point: a rejection here would otherwise reach the host event
   * loop, where an unhandled rejection terminates the whole DSH process.
   * @param message - normalized inbound Octo message.
   */
  const handleMessage = async (message: OctoMessage): Promise<void> => {
    try {
      await handleInbound(message);
    } catch (error) {
      const text = detail(error);
      notify("octo-channel: inbound handler failed: " + text);
      ctx.logger.warn("inbound handler failed: %s", text);
    }
  };

  const reportReconnecting = (): void => {
    notify("octo-channel: connection lost, reconnecting - events arriving now are not replayed");
    ctx.logger.warn("connection lost, reconnecting");
  };
  const reportReconnected = (): void => {
    notify("octo-channel: connection restored");
    ctx.logger.info("connection restored");
  };

  ctx.effect(() => port.onMessage(handleMessage), "octo:on(message)");
  ctx.effect(() => port.onLifecycle("reconnecting", reportReconnecting), "octo:on(reconnecting)");
  ctx.effect(() => port.onLifecycle("reconnected", reportReconnected), "octo:on(reconnected)");
  ctx.effect(() => port.onLifecycle("error", (error?: Error) => ctx.logger.warn("transport error: %s", error?.message ?? "unknown")), "octo:on(error)");
  ctx.effect(() => port.onLifecycle("heartbeat-failed", (error?: Error) => ctx.logger.debug("heartbeat failed: %s", error?.message ?? "unknown")), "octo:on(heartbeat-failed)");

  ctx.on("session/event", (session, event: HostSessionEvent) => {
    const turn = coordinator.route(session.id, event);
    if (turn === undefined || !prepared?.agents.ownsSession(session.id)) return;
    const presenter = presentationFor(turn);
    presenter.observe(event);
    if (isTurnEndEvent(event)) {
      void presenter.close().finally(() => {
        presentations.delete(turn.id);
      });
    }
  });

  ctx.effect(() => () => {
    active = false;
      coordinator.close();
    const closeAgents = prepared !== undefined
      ? prepared.agents.close()
      : preparing?.then((state) => state.agents.close(), () => undefined);
    return Promise.allSettled([closePresentations(), ...(closeAgents === undefined ? [] : [closeAgents])]).then(
      () => undefined,
    );
  }, "octo:channel");

  ctx.effect(() => {
    let connected = false;
    const connection = port.connect().then(() => {
      connected = true;
      notify("octo-channel: online as " + port.robotId + " (owner " + port.ownerUid + ")");
    }).catch((error: unknown) => {
      notify("octo-channel: connect failed: " + detail(error));
      ctx.logger.error("octo channel connect failed: %s", error);
    });
    return async () => {
      active = false;
      await connection;
      if (connected) await port.disconnect().catch(reportSendFailure);
    };
  }, "octo:connect");
}

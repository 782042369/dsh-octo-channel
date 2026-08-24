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

interface ConversationBinding {
  readonly key: ConversationKey;
  readonly chatId: string;
  readonly channelType: number;
  readonly owner: OwnedAgent;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const bindingsBySession = new Map<string, ConversationBinding>();
  const bindingsByKey = new Map<ConversationKey, ConversationBinding>();
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

  const rememberBinding = (
    owner: OwnedAgent,
    target: TurnTarget,
    channelType: number,
  ): ConversationBinding => {
    const previous = bindingsByKey.get(owner.conversationKey);
    if (previous !== undefined && previous.owner.handle.agent.session.id !== owner.handle.agent.session.id) {
      bindingsBySession.delete(previous.owner.handle.agent.session.id);
    }
    const binding = Object.freeze({
      key: owner.conversationKey,
      chatId: target.chatId,
      channelType,
      owner,
    });
    bindingsByKey.set(owner.conversationKey, binding);
    bindingsBySession.set(owner.handle.agent.session.id, binding);
    return binding;
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
    });
    presentations.set(turn.id, { key: turn.target.conversationKey, presenter });
    return presenter;
  };

  const handleMessage = async (message: OctoMessage): Promise<void> => {
    if (message.content.trim() === "") return;
    // Group/thread mention gate: DMs always pass; @所有人 / @所有AI count as a mention.
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
      let owner = await state.agents.acquire(target.conversationKey);
      let binding = rememberBinding(owner, target, message.channelType);
      if (!active) return;
      if (!state.agents.isCurrent(owner)) {
        owner = await state.agents.acquire(target.conversationKey);
        binding = rememberBinding(owner, target, message.channelType);
      }
      void binding;
      coordinator.submit(owner, target, chatUserMessage(message));
    } catch (error) {
      const messageDetail = detail(error);
      notify("octo-channel: agent creation failed for chat " + message.chatId + ": " + messageDetail);
      ctx.logger.warn("agent creation failed for chat %s: %s", message.chatId, messageDetail);
      await port
        .send(message.chatId, { text: "\u26a0\ufe0f \u65e0\u6cd5\u542f\u52a8\u4f1a\u8bdd\uff1a" + messageDetail }, { channelType: message.channelType })
        .catch(reportSendFailure);
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
    bindingsBySession.clear();
    bindingsByKey.clear();
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

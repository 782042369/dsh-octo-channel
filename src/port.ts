/**
 * Octo transport: bot registration, the WuKongIM WebSocket, the online
 * heartbeat, and text send/typing. Emits normalized inbound messages.
 * @module dsh-octo-channel/port
 */
import { EventEmitter } from "node:events";
import { WKSocket } from "./protocol/socket.js";
import {
  registerBot,
  sendHeartbeat,
  sendMessage as apiSendMessage,
  sendTyping,
} from "./protocol/api-fetch.js";
import { ChannelType, MessageType, type BotMessage, type MentionPayload } from "./protocol/types.js";

/** One normalized inbound Octo message ready for the channel layer. */
export interface OctoMessage {
  /** DM: the peer user UID; group/thread: the channel id verbatim. */
  readonly chatId: string;
  /** 1 = DM, 2 = group, 5 = thread. */
  readonly channelType: number;
  readonly senderId: string;
  readonly messageId: string;
  readonly content: string;
  /** True when this message @-mentions the bot. */
  readonly botMentioned: boolean;
  readonly timestamp: number;
}

/** One outbound text payload. markdown and text both ride payload.type=1. */
export interface OctoSendInput {
  readonly text?: string | undefined;
  readonly markdown?: string | undefined;
}

export interface OctoSendOptions {
  /** Reply in-thread to this message id. */
  readonly replyTo?: string | undefined;
  /** Channel type of the target; defaults to DM. */
  readonly channelType?: number | undefined;
  /** UIDs to @-mention in the reply (usually the sender in groups). */
  readonly mentionUids?: string[] | undefined;
}

export interface OctoSendResult {
  readonly messageId: string;
}

export interface OctoPortConfig {
  readonly botToken: string;
  readonly apiUrl: string;
  readonly wsUrl?: string | undefined;
  readonly heartbeatIntervalMs: number;
  readonly pluginVersion: string;
}

/** How many processed message ids to remember for dedupe. */
const SEEN_CAPACITY = 500;
/** Re-assert the typing indicator on this cadence while a turn is live. */
export const TYPING_INTERVAL_MS = 10_000;

function isFlag(value: boolean | number | undefined): boolean {
  return value === true || value === 1;
}

/** All uids a mention payload refers to (uids list plus structured entities). */
export function mentionUidsOf(mention: MentionPayload | undefined): string[] {
  if (mention === undefined) return [];
  const uids = new Set<string>(mention.uids ?? []);
  for (const entity of mention.entities ?? []) uids.add(entity.uid);
  return [...uids];
}

/** Extract the text a model should see from one inbound payload. */
export function extractText(message: BotMessage): string {
  const payload = message.payload;
  switch (payload.type) {
    case MessageType.Text:
      return typeof payload.content === "string" ? payload.content : "";
    case MessageType.RichText: {
      const plain = payload.plain;
      if (typeof plain === "string" && plain !== "") return plain;
      const blocks = payload.content;
      if (Array.isArray(blocks)) {
        return blocks
          .map((block) => (block as { text?: unknown })?.text)
          .filter((text): text is string => typeof text === "string" && text !== "")
          .join("");
      }
      return "";
    }
    case MessageType.InteractiveCard: {
      const plain = payload.plain;
      return typeof plain === "string" && plain !== "" ? plain : "[卡片]";
    }
    default:
      return "";
  }
}

/**
 * The Octo channel transport. One instance per bot account; the WuKongIM
 * socket owns its own reconnect loop, this class owns registration,
 * heartbeat, dedupe, and outbound calls.
 */
export class OctoPort extends EventEmitter {
  /** The bot uid in Octo: its robot_id (mention gating and self-filter). */
  robotId: string | undefined;
  /** The bot owner uid from the register response (DM target). */
  ownerUid: string | undefined;
  private readonly config: OctoPortConfig;
  private socket: WKSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private seen = new Set<string>();
  private connecting: Promise<void> | undefined;

  constructor(config: OctoPortConfig) {
    super();
    this.config = config;
  }

  /** Register the bot, open the WuKongIM socket, and start the heartbeat. */
  connect(): Promise<void> {
    if (this.connecting === undefined) {
      this.connecting = this.connectOnce().catch((error: unknown) => {
        this.connecting = undefined;
        throw error;
      });
    }
    return this.connecting;
  }

  /** Subscribe to normalized inbound messages; returns the unsubscriber. */
  onMessage(handler: (message: OctoMessage) => void | Promise<void>): () => void {
    this.on("message", handler);
    return () => {
      this.off("message", handler);
    };
  }

  /** Subscribe to one raw lifecycle event; returns the unsubscriber. */
  onLifecycle(
    event: "reconnecting" | "reconnected" | "error" | "heartbeat-failed",
    handler: (value?: Error) => void,
  ): () => void {
    this.on(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  /** Stop the heartbeat and close the socket. */
  async disconnect(): Promise<void> {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.socket?.disconnect();
    this.socket = undefined;
    await (this.connecting ?? Promise.resolve());
  }

  private async connectOnce(): Promise<void> {
    const registered = await registerBot({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      agentPlatform: "dsh",
      pluginVersion: this.config.pluginVersion,
    });
    this.robotId = registered.robot_id;
    this.ownerUid = registered.owner_uid;
    const wsUrl = this.config.wsUrl ?? registered.ws_url;
    if (wsUrl === undefined || wsUrl === "") {
      throw new Error("octo: no WebSocket URL - the register response carries none and config.wsUrl is unset");
    }
    this.socket = new WKSocket({
      wsUrl,
      uid: registered.robot_id,
      token: registered.im_token,
      onMessage: (message) => this.handleSocketMessage(message),
      onConnected: () => this.emit("reconnected"),
      onDisconnected: () => this.emit("reconnecting"),
      onError: (error: Error) => this.emit("error", error),
    });
    this.socket.connect();
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    const beat = (): void => {
      void sendHeartbeat({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
      }).catch((error: unknown) => {
        this.emit("heartbeat-failed", error);
      });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.config.heartbeatIntervalMs);
  }

  /** Dedupe, filter self-traffic, normalize, and emit one inbound message. */
  private handleSocketMessage(message: BotMessage): void {
    if (message === null || typeof message !== "object") return;
    if (typeof message.message_id !== "string" || message.message_id === "") return;
    if (this.seen.has(message.message_id)) return;
    this.seen.add(message.message_id);
    if (this.seen.size > SEEN_CAPACITY) {
      for (const id of this.seen) {
        this.seen.delete(id);
        if (this.seen.size <= SEEN_CAPACITY / 2) break;
      }
    }
    if (this.robotId !== undefined && message.from_uid === this.robotId) return;

    const channelType = message.channel_type ?? ChannelType.DM;
    const chatId = channelType === ChannelType.DM
      ? message.from_uid
      : (message.channel_id ?? "");
    if (chatId === "") return; // a non-DM without a channel id has no reply target

    const content = extractText(message);
    if (content.trim() === "") return; // media-only messages are out of MVP scope

    const uids = mentionUidsOf(message.payload.mention);
    const mention = message.payload.mention;
    const botMentioned =
      (this.robotId !== undefined && uids.includes(this.robotId)) ||
      (isFlag(mention?.ais) && !isFlag(mention?.all) && !isFlag(mention?.humans));

    const normalized: OctoMessage = Object.freeze({
      chatId,
      channelType,
      senderId: message.from_uid,
      messageId: message.message_id,
      content,
      botMentioned,
      timestamp: message.timestamp ?? Date.now(),
    });
    this.emit("message", normalized);
  }

  /** Send one text message to a chat. */
  async send(to: string, input: OctoSendInput, options?: OctoSendOptions): Promise<OctoSendResult> {
    const text = input.markdown ?? input.text ?? "";
    const result = await apiSendMessage({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId: to,
      channelType: (options?.channelType ?? ChannelType.DM) as ChannelType,
      content: text,
      ...(options?.mentionUids && options.mentionUids.length > 0 ? { mentionUids: options.mentionUids } : {}),
      ...(options?.replyTo !== undefined ? { replyMsgId: options.replyTo } : {}),
    });
    return { messageId: result?.message_id ?? "" };
  }

  /** Best-effort typing indicator for one chat. */
  async typing(to: string, channelType: number): Promise<void> {
    await sendTyping({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId: to,
      channelType: channelType as ChannelType,
    });
  }
}

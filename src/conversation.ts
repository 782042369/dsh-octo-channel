/** Stable identity for one Octo conversation facet and one inbound turn. */
import { randomUUID } from "node:crypto";

/** How Octo traffic is partitioned into DSH sessions. */
export type SessionScope = "chat" | "chat-sender";

declare const conversationKeyBrand: unique symbol;

/** Encoded key for one independently routed conversation facet. */
export type ConversationKey = string & { readonly [conversationKeyBrand]: true };

/** Message identity fields used before any agent or transport work begins. */
export interface OctoChatAddress {
  /** DM: the peer user UID; group/thread: the channel id verbatim. */
  readonly chatId: string;
  readonly senderId: string;
  readonly messageId: string;
  /** 1 = DM, 2 = group, 5 = thread. */
  readonly channelType: number;
}

/** Immutable destination captured for one agent turn. */
export interface TurnTarget {
  readonly conversationKey: ConversationKey;
  readonly chatId: string;
  readonly channelType: number;
  readonly replyToMessageId: string;
  /** Reply should @-mention this sender (group chats only). */
  readonly replyMentionUid?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function component(value: string, label: string): string {
  if (value === "") throw new Error(label + " must not be empty");
  return encodeURIComponent(value);
}

/**
 * Derive the sole state-partition key for one conversation facet. The
 * channel type is part of the key because Octo uids and group numbers are
 * drawn from unrelated id spaces and could otherwise collide.
 */
export function conversationKey(scope: SessionScope, address: OctoChatAddress): ConversationKey {
  const facet = address.channelType === 1 ? "dm" : address.channelType === 2 ? "group" : "thread";
  const chat = component(address.chatId, "chatId");
  if (scope === "chat-sender" && address.channelType !== 1) {
    return (facet + ":" + chat + ":sender:" + component(address.senderId, "senderId")) as ConversationKey;
  }
  return (facet + ":" + chat) as ConversationKey;
}

/** Create a current-generation DSH session id for one conversation key. */
export function createSessionId(key: ConversationKey, generation: string = randomUUID()): string {
  if (!UUID.test(generation)) throw new Error("invalid session generation");
  return "octo-" + key + "~" + generation.toLowerCase();
}

/** Test whether a session id is a current-generation id for this key. */
export function sessionBelongsTo(key: ConversationKey, sessionId: string): boolean {
  const prefix = "octo-" + key + "~";
  return sessionId.startsWith(prefix) && UUID.test(sessionId.slice(prefix.length));
}

/** Capture a turn reply destination before asynchronous work can interleave. */
export function createTurnTarget(scope: SessionScope, address: OctoChatAddress): TurnTarget {
  const replyMentionUid =
    address.channelType !== 1 && address.senderId !== "" ? address.senderId : undefined;
  return Object.freeze({
    conversationKey: conversationKey(scope, address),
    chatId: address.chatId,
    channelType: address.channelType,
    replyToMessageId: address.messageId,
    ...(replyMentionUid === undefined ? {} : { replyMentionUid }),
  });
}
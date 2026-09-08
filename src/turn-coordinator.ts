/** Correlates Octo messages with host turn events and immutable reply targets.
 * Ported from dsh-feishu-channel (MIT); turn ids carry the octo- prefix.
 */
import type { OwnedAgent } from "./agent-registry.js";
import type { ConversationKey, TurnTarget } from "./conversation.js";
import type { HostSessionEvent, HostUserMessage } from "./host.js";

/** One Octo-submitted turn whose target and input cannot be overwritten. */
export interface CoordinatedTurn {
  readonly id: string;
  readonly target: TurnTarget;
  readonly owner: OwnedAgent;
  readonly message: HostUserMessage;
}

function eventTurn(event: HostSessionEvent): number | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const turn = (event.data as Record<string, unknown>).turn;
  return typeof turn === "number" && Number.isInteger(turn) && turn >= 0 ? turn : undefined;
}

/**
 * Keeps turn correlation independent from rendering and transport. Host turn
 * numbers are learned from events, so queued messages bind FIFO per session.
 */
export class TurnCoordinator {
  private readonly queued = new Map<string, CoordinatedTurn[]>();
  private readonly active = new Map<string, Map<number, CoordinatedTurn>>();
  private readonly latest = new Map<ConversationKey, CoordinatedTurn>();
  private nextId = 0;

  /** Queue one user message before handing it to the owned agent. */
  submit(owner: OwnedAgent, target: TurnTarget, message: HostUserMessage): CoordinatedTurn {
    if (owner.conversationKey !== target.conversationKey) {
      throw new Error("turn target does not belong to the owned agent");
    }
    const turn = Object.freeze({
      id: "octo-turn-" + ++this.nextId,
      target,
      owner,
      message,
    });
    const sessionId = owner.handle.agent.session.id;
    const queue = this.queued.get(sessionId) ?? [];
    queue.push(turn);
    this.queued.set(sessionId, queue);
    this.latest.set(target.conversationKey, turn);
    try {
      owner.handle.agent.followup(message);
    } catch (error) {
      this.remove(turn);
      throw error;
    }
    return turn;
  }

  /** Resolve one host event to the Octo turn that submitted it. */
  route(sessionId: string, event: HostSessionEvent): CoordinatedTurn | undefined {
    const hostTurn = eventTurn(event);
    if (hostTurn === undefined) {
      const active = this.active.get(sessionId);
      if (active !== undefined && active.size > 0) return [...active.values()].at(-1);
      return this.queued.get(sessionId)?.[0];
    }

    let byTurn = this.active.get(sessionId);
    let coordinated = byTurn?.get(hostTurn);
    if (coordinated === undefined) {
      const queue = this.queued.get(sessionId);
      coordinated = queue?.shift();
      if (queue !== undefined && queue.length === 0) this.queued.delete(sessionId);
      if (coordinated === undefined) return undefined;
      if (byTurn === undefined) {
        byTurn = new Map();
        this.active.set(sessionId, byTurn);
      }
      byTurn.set(hostTurn, coordinated);
    }

    if (event.type === "turn/end") {
      byTurn?.delete(hostTurn);
      if (byTurn?.size === 0) this.active.delete(sessionId);
    }
    return coordinated;
  }

  /** Return queued plus active turn count for one conversation.
   * @param key - conversation identity.
   * @returns Number of turns awaiting or producing output.
   */
  pendingCount(key: ConversationKey): number {
    let count = 0;
    for (const queue of this.queued.values()) count += queue.filter((turn) => turn.target.conversationKey === key).length;
    for (const turns of this.active.values()) {
      for (const turn of turns.values()) if (turn.target.conversationKey === key) count += 1;
    }
    return count;
  }

  /** Drop queued and active state for one conversation. */
  clear(key: ConversationKey): void {
    this.latest.delete(key);
    for (const [sessionId, queue] of this.queued) {
      const remaining = queue.filter((turn) => turn.target.conversationKey !== key);
      if (remaining.length === 0) this.queued.delete(sessionId);
      else this.queued.set(sessionId, remaining);
    }
    for (const [sessionId, turns] of this.active) {
      for (const [hostTurn, turn] of turns) {
        if (turn.target.conversationKey === key) turns.delete(hostTurn);
      }
      if (turns.size === 0) this.active.delete(sessionId);
    }
  }

  /** Drop all process-local turn correlation. */
  close(): void {
    this.queued.clear();
    this.active.clear();
    this.latest.clear();
  }

  private remove(turn: CoordinatedTurn): void {
    const sessionId = turn.owner.handle.agent.session.id;
    const queue = this.queued.get(sessionId);
    if (queue !== undefined) {
      const index = queue.indexOf(turn);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.queued.delete(sessionId);
    }
    if (this.latest.get(turn.target.conversationKey) === turn) {
      this.latest.delete(turn.target.conversationKey);
    }
  }
}
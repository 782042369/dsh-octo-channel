/**
 * Text reply presenter for one immutable Octo turn destination.
 *
 * The presenter owns a real finalization promise: turn/end, shutdown, and
 * transport cleanup all await the same send operation, so an unload cannot
 * report success while the final reply is still in flight. Long answers are
 * chunked, and the typing keep-alive plus an idle watchdog bound how long one
 * presenter can keep talking to a chat on its own.
 * @module dsh-octo-channel/reply-presenter
 */
import { TYPING_INTERVAL_MS, type OctoPort } from "./port.js";
import type { TurnTarget } from "./conversation.js";
import {
  assistantText,
  isAssistantMessageEvent,
  isTurnEndEvent,
  type HostSessionEvent,
} from "./host.js";

/** Failure sink for outbound send errors and presenter diagnostics. */
export type PresenterFailureSink = (error: unknown) => void;

/** One turn-bound text presenter. */
export interface TextPresenter {
  observe(event: HostSessionEvent): void;
  close(): Promise<void>;
}

export interface TextPresenterOptions {
  readonly onFailure: PresenterFailureSink;
  /** Keep the typing indicator warm while the turn is live. */
  readonly typing?: boolean | undefined;
  /** Send the ack note after this many milliseconds without committed text. */
  readonly ackDelayMs?: number | undefined;
  /** Text of the ack note. */
  readonly ackText?: string | undefined;
  /** Outbound messages longer than this are split into several messages. */
  readonly maxReplyChars?: number | undefined;
  /** Finalize the turn with what arrived when no host event shows up for this long. */
  readonly idleTimeoutMs?: number | undefined;
}

const DEFAULT_ACK_TEXT = "收到，正在处理…";
const DEFAULT_MAX_REPLY_CHARS = 3_500;
const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;
/** Never split a reply into chunks smaller than this. */
const MIN_CHUNK_CHARS = 200;
/** Stop re-asserting "typing..." after this long even if the turn is still live. */
const TYPING_BUDGET_MS = 600_000;
const MAX_FAILURE_CHARS = 300;

/** Remove common credential-shaped substrings before an error reaches chat.
 * @param value - raw host or upstream error text.
 * @returns A bounded, redacted user-facing diagnostic.
 */
export function safeFailureText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(authorization|token|api[-_]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/\b(?:sk|bf|app|ghp|gho|xox)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[upstream]")
    .slice(0, MAX_FAILURE_CHARS);
}

/**
 * Split one long reply into bounded chunks on paragraph, then sentence, then
 * hard boundaries. Each chunk stays within maxChars when possible.
 * @param text - the full reply text.
 * @param maxChars - per-message character budget.
 * @returns Chunk texts in order; at least one element for non-empty input.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf("。", maxChars) + 1;
    if (cut < MIN_CHUNK_CHARS) cut = rest.lastIndexOf(". ", maxChars) + 1;
    if (cut < MIN_CHUNK_CHARS) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/** Create a presenter whose destination cannot be retargeted later.
 * @param port - Octo transport.
 * @param target - immutable reply destination.
 * @param options - presentation, chunking, and failure policy.
 * @returns A turn presenter with drainable close semantics.
 */
export function createTextPresenter(
  port: OctoPort,
  target: TurnTarget,
  options: TextPresenterOptions,
): TextPresenter {
  return new TurnTextPresenter(port, target, options);
}

class TurnTextPresenter implements TextPresenter {
  private turnTexts: string[] = [];
  private finalized = false;
  private ackSent = false;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private typingStartedAt = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private finalizationPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly port: OctoPort,
    private readonly target: TurnTarget,
    private readonly options: TextPresenterOptions,
  ) {
    const delay = this.options.ackDelayMs;
    if (delay !== undefined && delay > 0) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined;
        void this.sendAck();
      }, delay);
      (this.ackTimer as { unref?: () => void }).unref?.();
    }
    this.startTyping();
    this.armIdleWatchdog();
  }

  /** Observe one host event and schedule exactly one final send.
   * @param event - host session event.
   * @returns void.
   */
  observe(event: HostSessionEvent): void {
    if (this.finalized) return;
    this.armIdleWatchdog();
    if (isAssistantMessageEvent(event)) {
      const text = assistantText(event.data).trim();
      if (text !== "" && this.turnTexts[this.turnTexts.length - 1] !== text) this.turnTexts.push(text);
      this.startTyping();
      return;
    }
    if (isTurnEndEvent(event)) void this.beginFinalize(event.data.reason);
  }

  /** Stop timers and await any final outbound reply.
   * @returns A promise settled after all presenter-owned sends finish.
   */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.stopTimers();
      if (this.finalizationPromise !== undefined) {
        await this.finalizationPromise;
        return;
      }
      if (this.turnTexts.length > 0) await this.beginFinalize({ kind: "completed" });
    })();
    return this.closePromise;
  }

  /** Begin finalization once and return the shared promise.
   * @param reason - host turn terminal reason.
   * @returns The single finalization promise.
   */
  private beginFinalize(reason: { kind: string; error?: { code?: string; message?: string } }): Promise<void> {
    this.finalizationPromise ??= this.finalize(reason);
    return this.finalizationPromise;
  }

  /** Start typing immediately and keep the indicator warm for a bounded time.
   * @returns void.
   */
  private startTyping(): void {
    if (!this.options.typing || this.typingTimer !== undefined || this.finalized) return;
    this.typingStartedAt = Date.now();
    void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    this.typingTimer = setInterval(() => {
      // A turn whose terminal event never arrives must not ping "typing..." forever.
      if (Date.now() - this.typingStartedAt > TYPING_BUDGET_MS) {
        this.stopTyping();
        return;
      }
      void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    }, TYPING_INTERVAL_MS);
    (this.typingTimer as { unref?: () => void }).unref?.();
  }

  /** Stop the typing keep-alive.
   * @returns void.
   */
  private stopTyping(): void {
    if (this.typingTimer !== undefined) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
  }

  /** Stop all timers owned by the presenter.
   * @returns void.
   */
  private stopTimers(): void {
    this.stopTyping();
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Re-arm the idle watchdog; every host event postpones it.
   * @returns void.
   */
  private armIdleWatchdog(): void {
    const budget = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(budget) || budget <= 0) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.expireIdle();
    }, budget);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Finalize a turn whose host events stopped arriving.
   * @returns A promise settled after the best-effort final send.
   */
  private async expireIdle(): Promise<void> {
    if (this.finalized) return;
    const budgetMinutes = Math.round((this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 60_000);
    this.options.onFailure(new Error("octo: no host events for " + budgetMinutes + " min; finalizing the turn"));
    await this.beginFinalize({ kind: "completed" });
  }

  /** Send the delayed acknowledgement when the turn is still waiting.
   * @returns A promise settled after the best-effort ack.
   */
  private async sendAck(): Promise<void> {
    if (this.finalized || this.ackSent || this.turnTexts.length > 0) return;
    this.ackSent = true;
    try {
      await this.port.send(this.target.chatId, { text: this.options.ackText ?? DEFAULT_ACK_TEXT }, {
        replyTo: this.target.replyToMessageId,
        channelType: this.target.channelType,
      });
    } catch (error) {
      this.options.onFailure(error);
    }
  }

  /** Send the final accumulated text (chunked) or a redacted failure.
   * @param reason - terminal host reason.
   * @returns A promise settled after every chunk send.
   */
  private async finalize(reason: { kind: string; error?: { code?: string; message?: string } }): Promise<void> {
    if (this.finalized) return;
    this.stopTimers();
    const failed = reason.kind !== "completed" && reason.kind !== "cancelled" && reason.kind !== "aborted";
    const text = failed
      ? "回答失败：" + safeFailureText(reason.error?.message ?? reason.error?.code ?? reason.kind)
      : this.turnTexts.join("\n\n");
    this.finalized = true;
    if (text === "") return;
    const maxChars = Math.max(this.options.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS, MIN_CHUNK_CHARS);
    const chunks = chunkText(text, maxChars);
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await this.port.send(this.target.chatId, { text: chunks[index] }, {
          replyTo: this.target.replyToMessageId,
          channelType: this.target.channelType,
          // Mention the sender once, on the first chunk, so a long answer does
          // not @-ping them several times.
          ...(index === 0 && this.target.replyMentionUid !== undefined
            ? { mentionUids: [this.target.replyMentionUid] }
            : {}),
        });
      } catch (error) {
        this.options.onFailure(error);
        return;
      }
    }
  }
}

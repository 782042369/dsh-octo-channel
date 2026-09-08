/**
 * Text reply presenter for one immutable Octo turn destination.
 *
 * The presenter owns a real finalization promise: turn/end, shutdown, and
 * transport cleanup all await the same send operation, so an unload cannot
 * report success while the final reply is still in flight.
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

/** Failure sink for outbound send errors. */
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
}

const DEFAULT_ACK_TEXT = "收到，正在处理…";
const MAX_FAILURE_CHARS = 300;

/** Remove common credential-shaped substrings before an error reaches chat.
 * @param value - raw host or upstream error text.
 * @returns A bounded, redacted user-facing diagnostic.
 */
function safeFailureText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(authorization|token|api[-_]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[upstream]")
    .slice(0, MAX_FAILURE_CHARS);
}

/** Create a presenter whose destination cannot be retargeted later.
 * @param port - Octo transport.
 * @param target - immutable reply destination.
 * @param options - presentation and failure policy.
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
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
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
  }

  /** Observe one host event and schedule exactly one final send.
   * @param event - host session event.
   * @returns void.
   */
  observe(event: HostSessionEvent): void {
    if (this.finalized) return;
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

  /** Start typing immediately and keep the indicator warm.
   * @returns void.
   */
  private startTyping(): void {
    if (!this.options.typing || this.typingTimer !== undefined || this.finalized) return;
    void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    this.typingTimer = setInterval(() => {
      void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    }, TYPING_INTERVAL_MS);
    (this.typingTimer as { unref?: () => void }).unref?.();
  }

  /** Stop all timers owned by the presenter.
   * @returns void.
   */
  private stopTimers(): void {
    if (this.typingTimer !== undefined) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
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

  /** Send the final accumulated text or a redacted failure.
   * @param reason - terminal host reason.
   * @returns A promise settled after the final send.
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
    try {
      await this.port.send(this.target.chatId, { text }, {
        replyTo: this.target.replyToMessageId,
        channelType: this.target.channelType,
        ...(this.target.replyMentionUid === undefined ? {} : { mentionUids: [this.target.replyMentionUid] }),
      });
    } catch (error) {
      this.options.onFailure(error);
    }
  }
}

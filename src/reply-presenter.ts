/**
 * Text reply presenter for one immutable Octo turn destination.
 *
 * The MVP has no streaming: while a turn is live the presenter keeps the
 * Octo typing indicator warm and, if the first committed answer takes
 * longer than the configured ack delay, sends a short "received, working
 * on it" note. On turn end it delivers everything the agent committed
 * during the turn as one text message (multi-step turns keep every
 * committed text instead of dropping all but the last), replying to the
 * triggering message and @-mentioning the sender in groups.
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
  /**
   * Send the ack note when the turn has produced no committed text after
   * this many milliseconds. 0 (or undefined) disables the ack. Measured
   * from presenter construction (turn submission).
   */
  readonly ackDelayMs?: number | undefined;
  /** Text of the ack note. */
  readonly ackText?: string | undefined;
}

const DEFAULT_ACK_TEXT = "\u6536\u5230\uff0c\u6b63\u5728\u5904\u7406\u2026"; // 收到，正在处理…

/** Create a presenter whose destination cannot be retargeted later. */
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
        this.sendAck();
      }, delay);
      // The timer must not keep a torn-down process alive.
      (this.ackTimer as { unref?: () => void }).unref?.();
    }
  }

  observe(event: HostSessionEvent): void {
    if (this.finalized) return;
    if (isAssistantMessageEvent(event)) {
      const text = assistantText(event.data);
      const trimmed = text.trim();
      if (trimmed !== "" && this.turnTexts[this.turnTexts.length - 1] !== trimmed) {
        this.turnTexts.push(trimmed);
      }
      this.startTyping();
      return;
    }
    if (isTurnEndEvent(event)) {
      void this.finalize(event.data.reason);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private closeOnce(): Promise<void> {
    this.stopTimers();
    // If the turn ended without a turn/end event we still owe the user the
    // committed answers (when there are any).
    if (!this.finalized && this.turnTexts.length > 0) {
      return this.finalize({ kind: "completed" }).then(() => undefined);
    }
    return Promise.resolve();
  }

  private startTyping(): void {
    if (!this.options.typing || this.typingTimer !== undefined) return;
    void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    this.typingTimer = setInterval(() => {
      void this.port.typing(this.target.chatId, this.target.channelType).catch(() => undefined);
    }, TYPING_INTERVAL_MS);
  }

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

  /**
   * The ack is only meaningful while the user is still waiting: skip it if
   * anything was already committed (the answer is on its way) or the turn
   * is already over.
   */
  private async sendAck(): Promise<void> {
    if (this.finalized || this.ackSent || this.turnTexts.length > 0) return;
    this.ackSent = true;
    try {
      await this.port.send(
        this.target.chatId,
        { text: this.options.ackText ?? DEFAULT_ACK_TEXT },
        {
          replyTo: this.target.replyToMessageId,
          channelType: this.target.channelType,
        },
      );
    } catch (error) {
      this.options.onFailure(error);
    }
  }

  private async finalize(reason: { kind: string; error?: { code?: string; message?: string } }): Promise<void> {
    if (this.finalized) return;
    this.stopTimers();
    const failed = reason.kind !== "completed" && reason.kind !== "cancelled";
    const text = failed
      ? ("\u26a0\ufe0f \u56de\u7b54\u5931\u8d25\uff1a" + (reason.error?.message ?? reason.error?.code ?? reason.kind))
      : this.turnTexts.join("\n\n");
    this.finalized = true;
    if (text === "") return;
    try {
      await this.port.send(
        this.target.chatId,
        { text },
        {
          replyTo: this.target.replyToMessageId,
          channelType: this.target.channelType,
          ...(this.target.replyMentionUid === undefined ? {} : { mentionUids: [this.target.replyMentionUid] }),
        },
      );
    } catch (error) {
      this.options.onFailure(error);
    }
  }
}

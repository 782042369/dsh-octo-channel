/**
 * Text reply presenter for one immutable Octo turn destination.
 *
 * The MVP has no streaming: while a turn is live the presenter keeps the
 * Octo typing indicator warm, and on turn end it delivers the committed
 * assistant answer (or a short error note) as one text message, replying
 * to the triggering message and @-mentioning the sender in groups.
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
}

/** Create a presenter whose destination cannot be retargeted later. */
export function createTextPresenter(
  port: OctoPort,
  target: TurnTarget,
  options: TextPresenterOptions,
): TextPresenter {
  return new TurnTextPresenter(port, target, options);
}

class TurnTextPresenter implements TextPresenter {
  private lastText = "";
  private finalized = false;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly port: OctoPort,
    private readonly target: TurnTarget,
    private readonly options: TextPresenterOptions,
  ) {}

  observe(event: HostSessionEvent): void {
    if (this.finalized) return;
    if (isAssistantMessageEvent(event)) {
      const text = assistantText(event.data);
      if (text.trim() !== "") this.lastText = text;
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
    this.stopTyping();
    // If the turn ended without a turn/end event we still owe the user the
    // last committed answer (when there is one).
    if (!this.finalized && this.lastText !== "") {
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

  private stopTyping(): void {
    if (this.typingTimer !== undefined) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
  }

  private async finalize(reason: { kind: string; error?: { code?: string; message?: string } }): Promise<void> {
    if (this.finalized) return;
    this.stopTyping();
    const failed = reason.kind !== "completed" && reason.kind !== "cancelled";
    const text = failed
      ? ("\u26a0\ufe0f \u56de\u7b54\u5931\u8d25\uff1a" + (reason.error?.message ?? reason.error?.code ?? reason.kind))
      : this.lastText.trim();
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

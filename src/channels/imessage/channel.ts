// iMessage: one bound person (a phone number or Apple ID email). Polls the
// Messages database for their new texts in the one-to-one chat, hands them
// to the reply loop, and sends the replies through Messages. Texts already
// there at start are never answered.

import { mergeIncoming, ReplyLoop, type Incoming, type ReplyEvent, type Responder, type SendResult } from "../reply-loop.ts";
import { sameHandle, type MessagesDb } from "./messages.ts";

const POLL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;
/**
 * Texting yourself (the Mac signed in to your own Apple ID) brings every reply
 * back as an incoming text. One matching anything sent this recently is taken
 * as the agent's own, never answered.
 */
const ECHO_MS = 10 * 60_000;
/** More turns than this within RUNAWAY_MS means something is looping: pause instead. */
const RUNAWAY_TURNS = 6;
const RUNAWAY_MS = 60_000;

export type IMessage = Incoming<never>;
export type IMessageEvent = ReplyEvent | { type: "status"; message: string } | { type: "skipped"; count: number } | { type: "send_failed"; message: string };

const echoKey = (text: string) => text.replace(/\s+/g, " ").trim();

export class IMessageChannel {
  private readonly loop: ReplyLoop<IMessage>;
  /** The newest message id already handled; null until the first read. */
  private lastId: number | null = null;
  private sentLately: Array<{ key: string; at: number }> = [];
  private turnTimes: number[] = [];
  private lastProblem: string | null = null;
  paused = false;
  /** Set on shutdown: finish the turn in memory, but send nothing more. */
  stopping = false;

  constructor(
    private readonly deps: {
      db: MessagesDb;
      send: (to: string, text: string) => Promise<void>;
      responder: Responder;
      /** The one person answered: a phone number or Apple ID email. */
      handle: string;
      mode: "auto" | "draft";
      /** What the agent is told when a text came with a photo or file it can't see. */
      attachmentNote: string;
      onEvent?: (event: IMessageEvent) => void;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      burstWindowMs?: number;
    },
  ) {
    this.loop = new ReplyLoop<IMessage>({
      companion: deps.responder,
      onEvent: deps.onEvent,
      sleep: deps.sleep,
      burstWindowMs: deps.burstWindowMs,
      outlet: {
        merge: mergeIncoming,
        loadImage: () => Promise.reject(new Error("iMessage photos aren't read")),
        sendBubble: (_message, bubble) => this.send(bubble),
      },
    });
  }

  private emit(event: IMessageEvent) {
    this.deps.onEvent?.(event);
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number) {
    return (this.deps.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  settle(): Promise<void> {
    return this.loop.settle();
  }

  /** Polls until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = POLL_MS;
      try {
        this.poll();
        if (this.lastProblem) this.emit({ type: "status", message: "Reading Messages again." });
        this.lastProblem = null;
      } catch (err) {
        const problem = `Couldn't read Messages: ${(err as Error).message}`;
        if (problem !== this.lastProblem) this.emit({ type: "status", message: problem });
        this.lastProblem = problem;
        wait = ERROR_BACKOFF_MS;
      }
      if (!signal.aborted) await this.sleep(wait);
    }
  }

  /** Reads new texts once. Public for tests. */
  poll(): void {
    if (this.lastId === null) {
      this.lastId = this.deps.db.latestId();
      this.emit({ type: "status", message: `Connected. New texts from ${this.deps.handle} will be ${this.deps.mode === "draft" ? "drafted here, not sent" : "answered"}.` });
      return;
    }
    const rows = this.deps.db.since(this.lastId);
    if (!rows.length) return;
    this.lastId = rows[rows.length - 1].id;

    const now = this.now();
    this.sentLately = this.sentLately.filter((s) => now - s.at < ECHO_MS);
    const messages: IMessage[] = [];
    for (const row of rows) {
      if (!sameHandle(row.handle, this.deps.handle)) continue;
      if (row.text && this.sentLately.some((s) => s.key === echoKey(row.text))) continue; // our own reply, echoed back
      const text = row.attachments ? [row.text, this.deps.attachmentNote].filter(Boolean).join("\n") : row.text;
      if (text) messages.push({ text, image: null });
    }
    if (!messages.length) return;
    if (this.paused) {
      this.emit({ type: "skipped", count: messages.length });
      return;
    }
    this.turnTimes = [...this.turnTimes.filter((t) => now - t < RUNAWAY_MS), now];
    if (this.turnTimes.length > RUNAWAY_TURNS) {
      this.paused = true;
      this.emit({ type: "status", message: `More than ${RUNAWAY_TURNS} turns in a minute: this looks like a loop, so replies are paused. Restart to resume.` });
      this.emit({ type: "skipped", count: messages.length });
      return;
    }
    this.loop.push(messages);
  }

  private async send(raw: string): Promise<SendResult> {
    if (this.deps.mode === "draft") return "drafted";
    if (this.stopping) return "failed";
    const bubble = raw.trim();
    if (!bubble) return "sent";
    // Remembered before sending: the echo can arrive before the send returns.
    const mine = { key: echoKey(bubble), at: this.now() };
    this.sentLately.push(mine);
    try {
      await this.deps.send(this.deps.handle, bubble);
      return "sent";
    } catch (err) {
      this.emit({ type: "send_failed", message: (err as Error).message });
      return "failed";
    }
  }
}

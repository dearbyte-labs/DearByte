// DearByte's agent in WeChat, in Mandarin. The WeChat desktop channel reads
// the bound chat and types the replies; this answers each message with the
// agent loop and all its tools (health, calendar, money, news, the wallet)
// instead of the companion.
//
// Approvals are answered by code here, as in the terminal chat, never by the
// model: "/approve N" shows code's own summary and waits for "确认" in the next
// message. The request itself is written by code, so what you approve is never
// the model's retelling. Only requests shown in this chat can be approved here.
// While `watch` runs, Telegram's buttons work for the same request too;
// whichever answer lands first counts.

import { APPROVAL_TTL_MS, type Decision } from "./approvals.ts";
import type { LoopResult, LoopStop } from "./loop.ts";
import type { AgentMessage } from "./model.ts";
import type { Responder, ReplyTurn } from "../channels/reply-loop.ts";
import type { ImageInput } from "../domain.ts";
import type { Approval, Store } from "../storage/store.ts";

/** Put ahead of the persona, so the persona and the rules still come last. */
export const WECHAT_NOTE = `# This conversation
You are talking with the user in WeChat. Reply in Simplified Chinese (Mandarin), even when the user or a tool result uses another language; this overrides any rule below about matching the user's language. Plain text only: no Markdown, no headings, no bullet symbols. Keep it short, as a chat message: a few sentences, split into at most 4 short paragraphs by blank lines; each paragraph is sent as its own bubble. Numbers, times and names stay exact. Never write "/approve", "/reject" or "确认" as a message of its own: those are the user's commands, and code writes approval requests.`;

/** Turns of history kept for context, counted in messages from the user. */
const HISTORY_TURNS = 8;
const MAX_BUBBLES = 4;
/** WeChat takes long messages, but a wall of text reads badly on a phone. */
const MAX_BUBBLE_CHARS = 600;

const APPROVE = /^\/(approve|reject)\s+(\d+)$/i;
const CONFIRM = /^(确认|yes|y)$/i;

export type AgentResponderDeps = {
  /** One agent run: the history so far plus this message. */
  ask(history: AgentMessage[], text: string): Promise<LoopResult>;
  store: Pick<Store, "approval">;
  decide(id: number, verdict: "approve" | "reject"): Promise<Decision>;
  /** Approvals the agent proposed since the last call; each is shown once. */
  takeProposed(): Approval[];
  /** false in draft mode: nothing is approved or rejected. */
  approvals?: boolean;
  now?: () => Date;
};

/** The request, in Chinese around code's own summary, with how to answer it. */
export function approvalBubble(a: Approval): string {
  return `需要你批准（#${a.id}）\n\n${a.summary}\n\n${Math.round(APPROVAL_TTL_MS / 60_000)} 分钟内有效。批准就回复 /approve ${a.id}，不要就回复 /reject ${a.id}。`;
}

export function decisionText(d: Decision, verdict: "approve" | "reject"): string {
  switch (d.status) {
    case "approved":
      return `✅ 已批准。${d.result}`;
    case "rejected":
      return verdict === "approve" ? "❌ 没办成：这里没有能执行它的功能（钱包设置好了吗？）。" : "❌ 已拒绝，什么都没做。";
    case "expired":
      return "⌛ 这个请求已经过期了，什么都没做。";
    case "already_decided":
      return `这个请求已经处理过了（${d.approval?.status}）。`;
    default:
      return "找不到这个请求。";
  }
}

/** Why a run ended without an answer, for the chat. */
export function stopText(stop: LoopStop): string {
  switch (stop) {
    case "weekly_cap":
      return "这周的模型花费已经到上限了，先停一下。要继续的话，调高 DEARBYTE_WEEKLY_CAP。";
    case "budget":
      return "这个问题花的钱到单次上限了，没答完。换个小一点的问法试试？";
    case "max_steps":
      return "查了好几步还没答完，换个更具体的问法试试？";
    case "refusal":
      return "这个我不能回答。";
    case "truncated":
      return "回答被截断了，再问一次，或者少问一点。";
    default:
      return "没能给出回答，再试一次？";
  }
}

/** Blank-line paragraphs as bubbles: at most MAX_BUBBLES, the rest joined into the last. */
export function toBubbles(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const bubbles = paragraphs.length > MAX_BUBBLES ? [...paragraphs.slice(0, MAX_BUBBLES - 1), paragraphs.slice(MAX_BUBBLES - 1).join("\n\n")] : paragraphs;
  return bubbles.flatMap((b) => splitLong(b));
}

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** Cut on whole characters, so an emoji is never split. */
function splitLong(bubble: string): string[] {
  const chars = [...graphemes.segment(bubble)].map((g) => g.segment);
  if (chars.length <= MAX_BUBBLE_CHARS) return [bubble];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += MAX_BUBBLE_CHARS) out.push(chars.slice(i, i + MAX_BUBBLE_CHARS).join(""));
  return out;
}

/** The last `turns` exchanges, starting at a message the user typed (never at a tool result). */
export function recentHistory(messages: AgentMessage[], turns = HISTORY_TURNS): AgentMessage[] {
  const starts = messages.flatMap((m, i) => (m.role === "user" && typeof m.content === "string" ? [i] : []));
  return starts.length > turns ? messages.slice(starts[starts.length - turns]) : messages;
}

const said = (bubbles: string[]): ReplyTurn => ({ reply: { bubbles }, commit: () => {}, memory: Promise.resolve(null) });

export class AgentResponder implements Responder {
  private history: AgentMessage[] = [];
  /** An approval waiting for "确认" in the next message. */
  private confirming: number | null = null;
  /**
   * Requests this chat has been shown. Only these can be approved here, so a
   * request made elsewhere (Telegram, the terminal) is never approved by
   * whoever can type into this chat.
   */
  private readonly shown = new Set<number>();
  /** Requests proposed in a turn whose bubbles didn't all go out; shown with the next reply. */
  private unshown: Approval[] = [];

  constructor(private readonly d: AgentResponderDeps) {}

  async handle(input: { text: string; image?: ImageInput }): Promise<ReplyTurn> {
    const text = input.text.trim();
    // Messages sent in a quick burst arrive joined by newlines: "/approve 7" then "确认" still work.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length && (APPROVE.test(lines[0]) || this.confirming !== null) && lines.every((l) => APPROVE.test(l) || CONFIRM.test(l))) {
      const bubbles: string[] = [];
      for (const line of lines) bubbles.push(await this.command(line));
      return said(bubbles);
    }
    if (this.confirming !== null) {
      this.confirming = null;
      this.note(text, "（取消了等待确认的请求）");
      return said(["好，没有批准，什么都没做。"]);
    }

    if (!text && input.image) return said(["我这边还看不到图片，用文字告诉我吧。"]);
    const asked = input.image ? `${text}\n（用户还发了一张图，你看不到。）` : text;
    let result: LoopResult | null = null;
    try {
      result = await this.d.ask(this.history, asked);
    } catch (err) {
      console.error(`agent run failed: ${(err as Error).message}`);
    }
    const bubbles = result?.text ? toBubbles(result.text) : [];
    // A truncated answer that still has words is sent as it is; any other early stop says why.
    if (!result) bubbles.push(stopText("other"));
    else if (result.stop !== "done" && !(result.stop === "truncated" && bubbles.length)) bubbles.push(stopText(result.stop));
    else if (!bubbles.length) bubbles.push(stopText("other"));
    // Written by code, after the agent's words: the request as it's stored. Taken even when the run failed.
    const requests = [...this.unshown.splice(0), ...this.d.takeProposed()];
    const first = bubbles.length;
    for (const a of requests) bubbles.push(approvalBubble(a));
    return {
      reply: { bubbles },
      commit: (sent) => {
        // A request counts as shown only once its bubble went out; the rest wait for the next reply.
        requests.forEach((a, i) => (i + first < sent.length ? this.shown.add(a.id) : this.unshown.push(a)));
        // History is kept only when the run finished and every bubble went out, so the next turn never follows a half-sent one.
        if (result?.stop === "done" && sent.length === bubbles.length) this.history = recentHistory(result.messages);
      },
      memory: Promise.resolve(null),
    };
  }

  /** One approval command or 确认, answered by code. */
  private async command(line: string): Promise<string> {
    const now = (this.d.now ?? (() => new Date()))();
    if (CONFIRM.test(line)) {
      const id = this.confirming;
      this.confirming = null;
      if (id === null) return "现在没有等你确认的请求。";
      return this.decided(line, id, "approve");
    }
    // A new command while one waits for 确认 replaces it.
    this.confirming = null;
    const [, word, rawId] = line.match(APPROVE)!;
    const id = Number(rawId);
    const verdict = word.toLowerCase() as "approve" | "reject";
    if (!this.shown.has(id)) return `这里没有 #${id} 这个请求。在这里只能批准在微信里提出的请求。`;
    if (this.d.approvals === false) return "现在是草稿模式，不会执行任何批准。";
    const a = this.d.store.approval(id);
    if (verdict === "approve" && a?.status === "pending" && Date.parse(a.expiresAt) > now.getTime()) {
      this.confirming = id;
      return `${a.summary}\n\n确定要批准吗？回复「确认」就执行，回复别的就取消。`;
    }
    return this.decided(line, id, verdict);
  }

  private async decided(line: string, id: number, verdict: "approve" | "reject"): Promise<string> {
    const text = decisionText(await this.d.decide(id, verdict), verdict);
    this.note(line, text);
    return text;
  }

  /** Tells the model, next turn, what was decided outside it. */
  private note(user: string, outcome: string): void {
    this.history = recentHistory([...this.history, { role: "user", content: user }, { role: "assistant", content: [{ type: "text", text: outcome }] }]);
  }
}

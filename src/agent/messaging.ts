// DearByte's agent in a messaging app: WeChat (always Mandarin) or iMessage
// (Mandarin or English). The channel reads the bound chat and sends the
// replies; this answers each message with the agent loop and all its tools
// (health, calendar, money, news, the wallet) instead of the companion.
//
// Approvals are answered by code here, never by the model. Code writes the
// request into the chat from what it stored, so what you approve is never the
// model's retelling. While it waits, a short yes ("好", "可以", "ok", "sure")
// approves it and a short no ("算了", "不要", "no") rejects it; code matches
// the whole message against fixed lists, so the model can't approve anything,
// and anything longer goes to the model as usual. "/approve N" and
// "/reject N" work too. Only requests shown in this chat can be answered
// here. While `watch` runs, Telegram's buttons work for the same request;
// whichever answer lands first counts.

import { APPROVAL_TTL_MS, type Decision } from "./approvals.ts";
import type { LoopResult, LoopStop } from "./loop.ts";
import type { AgentMessage } from "./model.ts";
import type { Responder, ReplyTurn } from "../channels/reply-loop.ts";
import type { ImageInput } from "../domain.ts";
import type { Approval, Store } from "../storage/store.ts";

/** zh: Simplified Chinese (Mandarin). en: English. */
export type Lang = "zh" | "en";

/** Put ahead of the persona, so the persona and the rules still come last. */
export function chatNote(app: string, lang: Lang): string {
  const language =
    lang === "zh"
      ? "Reply in Simplified Chinese (Mandarin), even when the user or a tool result uses another language; this overrides any rule below about matching the user's language."
      : "Reply in English, even when the user or a tool result uses another language; this overrides any rule below about matching the user's language.";
  return `# This conversation
You are talking with the user in ${app}. ${language} Plain text only: no Markdown, no headings, no bullet symbols. Keep it short, as a chat message: a few sentences, split into at most 4 short paragraphs by blank lines; each paragraph is sent as its own bubble. Numbers, times and names stay exact. Code writes approval requests into the chat, and the user answers them there: never ask for approval yourself, and never write "/approve" or "/reject".`;
}

/** WeChat is always Mandarin. */
export const WECHAT_NOTE = chatNote("WeChat", "zh");

/** Turns of history kept for context, counted in messages from the user. */
const HISTORY_TURNS = 8;
const MAX_BUBBLES = 4;
/** Chat apps take long messages, but a wall of text reads badly on a phone. */
const MAX_BUBBLE_CHARS = 600;

const COMMAND = /^\/(approve|reject)\s+(\d+)$/i;
/** A whole message that means yes or no to the waiting request, in either language. Anything else goes to the model. */
const YES = new Set(["好", "好的", "好啊", "好吧", "好呀", "可以", "可以的", "行", "行吧", "行啊", "买", "买吧", "买吧买吧", "买了", "批准", "同意", "确认", "确定", "没问题", "嗯", "嗯嗯", "冲", "要", "要的", "ok", "okay", "yes", "y", "yep", "yeah", "yup", "sure", "go ahead", "do it", "buy it", "approve", "approved", "sounds good", "👍", "👌"]);
const NO = new Set(["不", "不要", "不用", "不用了", "不买", "别买", "算了", "算了吧", "取消", "拒绝", "不行", "no", "n", "nope", "nah", "no thanks", "cancel", "reject", "don't", "dont", "👎"]);

/** "好的！" and "OK." count as 好的 and ok. */
const normalize = (text: string) => text.trim().toLowerCase().replace(/[\s。.!！~～,，?？…]+$/u, "");
export const answerOf = (text: string): "approve" | "reject" | null => (YES.has(normalize(text)) ? "approve" : NO.has(normalize(text)) ? "reject" : null);

export type AgentResponderDeps = {
  /** One agent run: the history so far plus this message. */
  ask(history: AgentMessage[], text: string): Promise<LoopResult>;
  store: Pick<Store, "approval">;
  decide(id: number, verdict: "approve" | "reject"): Promise<Decision>;
  /** Approvals the agent proposed since the last call; each is shown once. */
  takeProposed(): Approval[];
  /** false in draft mode: nothing is approved or rejected. */
  approvals?: boolean;
  /** The language code writes in (approval requests, outcomes, errors). Default zh. */
  lang?: Lang;
  now?: () => Date;
};

/** Everything code (not the model) says in the chat, in each language. */
const PHRASES = {
  zh: {
    request: (a: Approval, minutes: number) => `需要你点头（#${a.id}）\n\n${a.summary}\n\n${minutes} 分钟内有效。要的话回我「好」，不要就说「算了」。`,
    approved: (result: string) => `✅ 已批准。${result}`,
    cantRun: "❌ 没办成：这里没有能执行它的功能（钱包设置好了吗？）。",
    rejected: "❌ 已拒绝，什么都没做。",
    expired: "⌛ 这个请求已经过期了，什么都没做。",
    alreadyDecided: (status: string) => `这个请求已经处理过了（${status}）。`,
    notFound: "找不到这个请求。",
    nothingWaiting: "现在没有等你答复的请求。",
    notHere: (id: number) => `这里没有 #${id} 这个请求。在这里只能答复在这个聊天里提出的请求。`,
    draft: "现在是草稿模式，不会执行任何批准。",
    noImage: "我这边还看不到图片，用文字告诉我吧。",
    imageNote: "（用户还发了一张图，你看不到。）",
    stop: {
      weekly_cap: "这周的模型花费已经到上限了，先停一下。要继续的话，调高 DEARBYTE_WEEKLY_CAP。",
      budget: "这个问题花的钱到单次上限了，没答完。换个小一点的问法试试？",
      max_steps: "查了好几步还没答完，换个更具体的问法试试？",
      refusal: "这个我不能回答。",
      truncated: "回答被截断了，再问一次，或者少问一点。",
      other: "没能给出回答，再试一次？",
    },
  },
  en: {
    request: (a: Approval, minutes: number) => `I need your OK (#${a.id})\n\n${a.summary}\n\nValid for ${minutes} minutes. Reply "yes" to go ahead, or "no" to cancel.`,
    approved: (result: string) => `✅ Approved. ${result}`,
    cantRun: "❌ Couldn't do it: nothing here can carry it out (is the wallet set up?).",
    rejected: "❌ Rejected. Nothing was done.",
    expired: "⌛ That request has expired. Nothing was done.",
    alreadyDecided: (status: string) => `That request was already answered (${status}).`,
    notFound: "I can't find that request.",
    nothingWaiting: "Nothing is waiting for your answer right now.",
    notHere: (id: number) => `There's no request #${id} here. Only requests made in this chat can be answered here.`,
    draft: "This is draft mode, so nothing is approved.",
    noImage: "I can't see pictures yet. Tell me in words?",
    imageNote: "(The user also sent a picture, which you can't see.)",
    stop: {
      weekly_cap: "This week's model spending has hit its cap, so I'm pausing. To go on, raise DEARBYTE_WEEKLY_CAP.",
      budget: "That question hit the per-question spending limit before I finished. Try a narrower one?",
      max_steps: "I took several steps and still didn't finish. Try a more specific question?",
      refusal: "I can't answer that.",
      truncated: "My answer got cut off. Ask again, or ask for less.",
      other: "I couldn't come up with an answer. Try again?",
    },
  },
} as const;

/** The request, around code's own summary, with how to answer it. */
export function approvalBubble(a: Approval, lang: Lang = "zh"): string {
  return PHRASES[lang].request(a, Math.round(APPROVAL_TTL_MS / 60_000));
}

export function decisionText(d: Decision, verdict: "approve" | "reject", lang: Lang = "zh"): string {
  const p = PHRASES[lang];
  switch (d.status) {
    case "approved":
      return p.approved(d.result);
    case "rejected":
      return verdict === "approve" ? p.cantRun : p.rejected;
    case "expired":
      return p.expired;
    case "already_decided":
      return p.alreadyDecided(String(d.approval?.status));
    default:
      return p.notFound;
  }
}

/** Why a run ended without an answer, for the chat. */
export function stopText(stop: LoopStop | "other", lang: Lang = "zh"): string {
  const s = PHRASES[lang].stop;
  return stop in s ? s[stop as keyof typeof s] : s.other;
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
  /**
   * Requests this chat has been shown, newest last. Only these can be answered
   * here, so a request made elsewhere (Telegram, the terminal) is never
   * approved by whoever can type into this chat.
   */
  private readonly shown: number[] = [];
  /** Requests proposed in a turn whose bubbles didn't all go out; shown with the next reply. */
  private unshown: Approval[] = [];
  /**
   * What the last reply said, normalized. A message identical to one of these
   * is never taken as an answer: if the app ever handed back the agent's own
   * "好的" or "Sure", it must not approve anything. (The channels already drop
   * their own bubbles.)
   */
  private lastSaid = new Set<string>();

  constructor(private readonly d: AgentResponderDeps) {}

  private get lang(): Lang {
    return this.d.lang ?? "zh";
  }

  async handle(input: { text: string; image?: ImageInput }): Promise<ReplyTurn> {
    const p = PHRASES[this.lang];
    const text = input.text.trim();
    // Messages sent in a quick burst arrive joined by newlines; answer them one by one when they're all answers.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const waiting = this.waiting();
    const isAnswer = (l: string) => COMMAND.test(l) || (waiting !== null && answerOf(l) !== null && !this.lastSaid.has(normalize(l)));
    if (lines.length && lines.every(isAnswer)) {
      const bubbles: string[] = [];
      for (const line of lines) bubbles.push(await this.answer(line));
      return this.said(bubbles);
    }

    if (!text && input.image) return this.said([p.noImage]);
    const asked = input.image ? `${text}\n${p.imageNote}` : text;
    let result: LoopResult | null = null;
    try {
      result = await this.d.ask(this.history, asked);
    } catch (err) {
      console.error(`agent run failed: ${(err as Error).message}`);
    }
    const bubbles = result?.text ? toBubbles(result.text) : [];
    // A truncated answer that still has words is sent as it is; any other early stop says why.
    if (!result) bubbles.push(stopText("other", this.lang));
    else if (result.stop !== "done" && !(result.stop === "truncated" && bubbles.length)) bubbles.push(stopText(result.stop, this.lang));
    else if (!bubbles.length) bubbles.push(stopText("other", this.lang));
    // Written by code, after the agent's words: the request as it's stored. Taken even when the run failed.
    const requests = [...this.unshown.splice(0), ...this.d.takeProposed()];
    const first = bubbles.length;
    for (const a of requests) bubbles.push(approvalBubble(a, this.lang));
    return {
      reply: { bubbles },
      commit: (sent) => {
        this.lastSaid = new Set(sent.map(normalize));
        // A request counts as shown only once its bubble went out; the rest wait for the next reply.
        requests.forEach((a, i) => (i + first < sent.length ? this.shown.push(a.id) : this.unshown.push(a)));
        // History is kept only when the run finished and every bubble went out, so the next turn never follows a half-sent one.
        if (result?.stop === "done" && sent.length === bubbles.length) this.history = recentHistory(result.messages);
      },
      memory: Promise.resolve(null),
    };
  }

  private said(bubbles: string[]): ReplyTurn {
    return { ...said(bubbles), commit: (sent) => (this.lastSaid = new Set(sent.map(normalize))) };
  }

  /** The newest request shown here that is still open, or null. */
  private waiting(): number | null {
    const now = (this.d.now ?? (() => new Date()))().getTime();
    for (const id of [...this.shown].reverse()) {
      const a = this.d.store.approval(id);
      if (a?.status === "pending" && Date.parse(a.expiresAt) > now) return id;
    }
    return null;
  }

  /** One answer, by code: "/approve N", "/reject N", or a yes or no to the newest waiting request. */
  private async answer(line: string): Promise<string> {
    const p = PHRASES[this.lang];
    const command = line.match(COMMAND);
    const id = command ? Number(command[2]) : this.waiting();
    const verdict = command ? (command[1].toLowerCase() as "approve" | "reject") : answerOf(line);
    if (id === null || verdict === null) return p.nothingWaiting;
    if (!this.shown.includes(id)) return p.notHere(id);
    if (this.d.approvals === false) return p.draft;
    const text = decisionText(await this.d.decide(id, verdict), verdict, this.lang);
    // The model hears it next turn, so it never says a request is still waiting.
    this.history = recentHistory([...this.history, { role: "user", content: line }, { role: "assistant", content: [{ type: "text", text }] }]);
    return text;
  }
}

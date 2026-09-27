import { expect, test } from "vitest";
import { AgentResponder, answerOf, approvalBubble, chatNote, recentHistory, stopText, toBubbles } from "../src/agent/messaging.ts";
import type { Decision } from "../src/agent/approvals.ts";
import type { LoopResult } from "../src/agent/loop.ts";
import type { AgentMessage } from "../src/agent/model.ts";
import type { Approval } from "../src/storage/store.ts";

const NOW = new Date("2026-09-27T12:00:00Z");

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 7,
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
  kind: "purchase",
  summary: "Buy recovery-plan from http://127.0.0.1:4021 for $0.05 USDC, paid to 0xa77a…8f6d",
  payload: {},
  status: "pending",
  decidedAt: null,
  decidedVia: null,
  ...over,
});

const done = (text: string, messages: AgentMessage[] = []): LoopResult => ({ stop: "done", text, messages, steps: 1, cost: 0.01 });

function responder(o: { answers?: LoopResult[]; stored?: Approval | null; proposed?: Approval[]; approvals?: boolean; fail?: boolean } = {}) {
  const asked: Array<{ history: AgentMessage[]; text: string }> = [];
  const decided: Array<[number, string]> = [];
  const answers = [...(o.answers ?? [])];
  const proposed = [...(o.proposed ?? [])];
  const r = new AgentResponder({
    ask: async (history, text) => {
      asked.push({ history, text });
      if (o.fail) throw new Error("model down");
      return answers.shift() ?? done("好的");
    },
    store: { approval: () => o.stored ?? null },
    decide: async (id, verdict): Promise<Decision> => {
      decided.push([id, verdict]);
      return verdict === "approve" ? { status: "approved", approval: approval({ status: "approved" }), result: "Paid. Receipt: …" } : { status: "rejected", approval: approval({ status: "rejected" }) };
    },
    takeProposed: () => proposed.splice(0),
    approvals: o.approvals,
    now: () => NOW,
  });
  return { r, asked, decided };
}

test("paragraphs become bubbles, at most four, and a long one is split", () => {
  expect(toBubbles("昨晚睡了 6 小时 42 分。\n\n今天 9 点有课。\n\n\n早点睡。")).toEqual(["昨晚睡了 6 小时 42 分。", "今天 9 点有课。", "早点睡。"]);
  expect(toBubbles("一\n\n二\n\n三\n\n四\n\n五")).toEqual(["一", "二", "三", "四\n\n五"]);
  expect(toBubbles("字".repeat(700))).toHaveLength(2);
});

test("history keeps the last turns and never starts at a tool result", () => {
  const turn = (n: number): AgentMessage[] => [
    { role: "user", content: `问题 ${n}` },
    { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "get_sleep", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: `回答 ${n}` }] },
  ];
  const all = [1, 2, 3].flatMap(turn);
  const kept = recentHistory(all, 2);
  expect(kept[0]).toEqual({ role: "user", content: "问题 2" });
  expect(kept).toHaveLength(8);
});

test("an answer is sent as bubbles, and kept as history only once every bubble went out", async () => {
  const messages: AgentMessage[] = [{ role: "user", content: "睡得怎么样" }, { role: "assistant", content: [{ type: "text", text: "…" }] }];
  const { r, asked } = responder({ answers: [done("6 小时 42 分。\n\n有点少。", messages), done("6 小时 42 分。", messages)] });
  const first = await r.handle({ text: "睡得怎么样" });
  expect(first.reply.bubbles).toEqual(["6 小时 42 分。", "有点少。"]);
  first.commit(["6 小时 42 分。"]); // the second bubble failed: nothing kept
  const second = await r.handle({ text: "再说一次" });
  expect(asked[1].history).toEqual([]);
  second.commit(second.reply.bubbles);
  await r.handle({ text: "那今天呢" });
  expect(asked[2].history).toEqual(messages);
});

/** Proposes `pending` in a turn and sends every bubble, as the chat would. */
async function shownIn(r: AgentResponder) {
  const turn = await r.handle({ text: "帮我买个恢复计划" });
  turn.commit(turn.reply.bubbles);
  return turn;
}

test("a short yes or no, and only that, answers the waiting request", () => {
  for (const yes of ["好", "好的！", "可以", "买吧", "OK.", "yes", "👍"]) expect(answerOf(yes)).toBe("approve");
  for (const no of ["算了", "不要", "不买。", "No"]) expect(answerOf(no)).toBe("reject");
  for (const other of ["好累", "可以便宜点吗", "买什么", "yes but later", ""]) expect(answerOf(other)).toBeNull();
});

test("a proposal is followed by code's own request, and 好 approves it", async () => {
  const pending = approval();
  const { r, decided, asked } = responder({ answers: [done("可以买一份恢复计划，5 美分。")], proposed: [pending], stored: pending });
  const proposal = await shownIn(r);
  expect(proposal.reply.bubbles).toEqual(["可以买一份恢复计划，5 美分。", approvalBubble(pending)]);
  expect(proposal.reply.bubbles[1]).toContain(pending.summary);

  const paid = await r.handle({ text: "好的！" });
  expect(decided).toEqual([[7, "approve"]]);
  expect(paid.reply.bubbles[0]).toMatch(/^✅ 已批准/);
  expect(asked).toHaveLength(1); // the yes never went to the model
});

test("算了 rejects, anything longer goes to the model with the request still waiting, and the model hears the outcome", async () => {
  const pending = approval();
  const { r, asked, decided } = responder({ proposed: [pending], stored: pending });
  await shownIn(r);
  await r.handle({ text: "这个计划里有什么" });
  expect(asked).toHaveLength(2);
  expect(decided).toEqual([]);
  await r.handle({ text: "算了" });
  expect(decided).toEqual([[7, "reject"]]);
  await r.handle({ text: "买了吗" });
  expect(JSON.stringify(asked.at(-1)?.history)).toContain("已拒绝");
});

test("with nothing waiting, 好 is just a message for the model", async () => {
  const { r, asked, decided } = responder();
  await r.handle({ text: "好" });
  expect(asked.map((a) => a.text)).toEqual(["好"]);
  expect(decided).toEqual([]);
});

test("only requests shown in this chat can be answered here, and the chat's own bubbles never approve anything", async () => {
  const pending = approval();
  const elsewhere = responder({ stored: pending });
  expect((await elsewhere.r.handle({ text: "/approve 7" })).reply.bubbles[0]).toContain("没有 #7");
  expect(elsewhere.decided).toEqual([]);

  const { r, decided } = responder({ proposed: [pending], stored: pending });
  const turn = await shownIn(r);
  for (const bubble of turn.reply.bubbles) await r.handle({ text: bubble });
  expect(decided).toEqual([]);
  await r.handle({ text: "/approve 7" });
  expect(decided).toEqual([[7, "approve"]]);
});

test("a request whose bubble didn't go out waits for the next reply, and a yes before that is just a message", async () => {
  const pending = approval();
  const { r, decided, asked } = responder({ answers: [done("收到"), done("嗯？")], proposed: [pending], stored: pending });
  const first = await r.handle({ text: "帮我买个恢复计划" });
  first.commit(first.reply.bubbles.slice(0, 1));
  const next = await r.handle({ text: "可以" });
  expect(decided).toEqual([]);
  expect(asked).toHaveLength(2);
  expect(next.reply.bubbles.at(-1)).toBe(approvalBubble(pending));
  next.commit(next.reply.bubbles);
  await r.handle({ text: "可以" });
  expect(decided).toEqual([[7, "approve"]]);
});

test("draft mode approves nothing", async () => {
  const pending = approval();
  const draft = responder({ proposed: [pending], stored: pending, approvals: false });
  await shownIn(draft.r);
  expect((await draft.r.handle({ text: "好" })).reply.bubbles[0]).toContain("草稿模式");
  expect(draft.decided).toEqual([]);
});

test("an expired request isn't waiting: 好 goes to the model, and /approve is told it expired", async () => {
  const expired = approval({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
  const { r, decided, asked } = responder({ proposed: [expired], stored: expired });
  await shownIn(r);
  await r.handle({ text: "好" });
  expect(decided).toEqual([]);
  expect(asked.at(-1)?.text).toBe("好");
  await r.handle({ text: "/approve 7" });
  expect(decided).toEqual([[7, "approve"]]); // decide() reports it expired
});

test("a failed run still shows a request it proposed", async () => {
  const pending = approval();
  const { r } = responder({ proposed: [pending], stored: pending, fail: true });
  const turn = await r.handle({ text: "帮我买个恢复计划" });
  expect(turn.reply.bubbles).toEqual([expect.stringContaining("没能给出回答"), approvalBubble(pending)]);
});

test("a run that stops early says why in Chinese; a photo alone gets a note, not a model call", async () => {
  const { r, asked } = responder({ answers: [{ stop: "weekly_cap", text: "", messages: [], steps: 0, cost: 0 }] });
  expect((await r.handle({ text: "今天怎么样" })).reply.bubbles).toEqual([expect.stringContaining("上限")]);
  expect((await r.handle({ text: "", image: { mediaType: "image/png", data: "" } as never })).reply.bubbles[0]).toContain("看不到图片");
  expect(asked).toHaveLength(1);
});

test("a long bubble is cut between whole characters", () => {
  const family = "👨‍👩‍👧";
  const parts = toBubbles("字".repeat(600) + family + "字");
  expect(parts[0].endsWith("字")).toBe(true);
  expect(parts[1].startsWith(family)).toBe(true);
});

test("in English, code's own words are English and an English yes approves", async () => {
  const pending = approval();
  const decided: Array<[number, string]> = [];
  const proposed = [pending];
  const r = new AgentResponder({
    ask: async () => done("A recovery plan costs 5 cents."),
    store: { approval: () => pending },
    decide: async (id, verdict): Promise<Decision> => (decided.push([id, verdict]), { status: "approved", approval: approval({ status: "approved" }), result: "Paid." }),
    takeProposed: () => proposed.splice(0),
    lang: "en",
    now: () => NOW,
  });
  const turn = await r.handle({ text: "buy me a recovery plan" });
  expect(turn.reply.bubbles[1]).toBe(approvalBubble(pending, "en"));
  expect(turn.reply.bubbles[1]).toMatch(/^I need your OK \(#7\)/);
  turn.commit(turn.reply.bubbles);
  expect((await r.handle({ text: "Sure!" })).reply.bubbles).toEqual(["✅ Approved. Paid."]);
  expect(decided).toEqual([[7, "approve"]]);
  expect(stopText("weekly_cap", "en")).toMatch(/cap/);
  expect(chatNote("iMessage", "en")).toMatch(/in iMessage\. Reply in English/);
});

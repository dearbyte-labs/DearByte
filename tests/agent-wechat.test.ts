import { expect, test } from "vitest";
import { AgentResponder, approvalBubble, recentHistory, toBubbles } from "../src/agent/wechat.ts";
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

function responder(o: { answers?: LoopResult[]; stored?: Approval | null; proposed?: Approval[] } = {}) {
  const asked: Array<{ history: AgentMessage[]; text: string }> = [];
  const decided: Array<[number, string]> = [];
  const answers = [...(o.answers ?? [])];
  const proposed = [...(o.proposed ?? [])];
  const r = new AgentResponder({
    ask: async (history, text) => (asked.push({ history, text }), answers.shift() ?? done("好的")),
    store: { approval: () => o.stored ?? null },
    decide: async (id, verdict): Promise<Decision> => {
      decided.push([id, verdict]);
      return verdict === "approve" ? { status: "approved", approval: approval({ status: "approved" }), result: "Paid. Receipt: …" } : { status: "rejected", approval: approval({ status: "rejected" }) };
    },
    takeProposed: () => proposed.splice(0),
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

test("a proposal is followed by code's own request, and approving needs 确认 in the next message", async () => {
  const pending = approval();
  const { r, decided } = responder({ answers: [done("可以买一份恢复计划，5 美分。")], proposed: [pending], stored: pending });
  const proposal = await r.handle({ text: "帮我买个恢复计划" });
  expect(proposal.reply.bubbles).toEqual(["可以买一份恢复计划，5 美分。", approvalBubble(pending)]);
  expect(proposal.reply.bubbles[1]).toContain(pending.summary);

  const asking = await r.handle({ text: "/approve 7" });
  expect(asking.reply.bubbles[0]).toContain("确认");
  expect(decided).toEqual([]);
  const paid = await r.handle({ text: "确认" });
  expect(decided).toEqual([[7, "approve"]]);
  expect(paid.reply.bubbles[0]).toMatch(/^✅ 已批准/);
});

test("anything but 确认 cancels, a reject needs no confirmation, and the model never sees either", async () => {
  const pending = approval();
  const { r, asked, decided } = responder({ stored: pending });
  await r.handle({ text: "/approve 7" });
  expect((await r.handle({ text: "算了" })).reply.bubbles[0]).toContain("没有批准");
  expect(decided).toEqual([]);
  await r.handle({ text: "/reject 7" });
  expect(decided).toEqual([[7, "reject"]]);
  expect(asked).toEqual([]);
});

test("an expired or unknown request isn't offered for confirmation", async () => {
  const expired = approval({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
  const { r, decided } = responder({ stored: expired });
  await r.handle({ text: "/approve 7" });
  expect(decided).toEqual([[7, "approve"]]); // decide() reports it expired; no 确认 step
});

test("a run that stops early says why in Chinese; a photo alone gets a note, not a model call", async () => {
  const { r, asked } = responder({ answers: [{ stop: "weekly_cap", text: "", messages: [], steps: 0, cost: 0 }] });
  expect((await r.handle({ text: "今天怎么样" })).reply.bubbles).toEqual([expect.stringContaining("上限")]);
  expect((await r.handle({ text: "", image: { mediaType: "image/png", data: "" } as never })).reply.bubbles[0]).toContain("看不到图片");
  expect(asked).toHaveLength(1);
});

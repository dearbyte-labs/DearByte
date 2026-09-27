import { expect, test } from "vitest";
import { resolveMindgo } from "../src/config.ts";
import { MindgoClient, MindgoError, mindgoTools } from "../src/finance/mindgo.ts";
import { financeTools, withMindgo } from "../src/finance/tools.ts";
import type { FinanceProfile } from "../src/finance/config.ts";
import { agentToolset } from "../src/agent/toolset.ts";
import { Store } from "../src/storage/store.ts";

const TOKEN = "mgo_" + "k".repeat(43);
const CONFIG = { url: "https://mindgo.example.com/mcp", token: TOKEN };
const profile: FinanceProfile = { currency: "CAD", age: 22, retireAge: 50, lifespan: 90, netAssets: 15_000, monthlySavings: 1_200, monthlySpend: 2_500, returnRate: 0.07, inflation: 0.03, withdrawalRate: 0.04, monthlyFrom: "mindgo" };

/** A fake MindGo over HTTP: answers JSON-RPC like POST /mcp and records the requests. */
function fakeMindgo(tools: Record<string, (args: Record<string, unknown>) => unknown>, o: { status?: number; offline?: boolean } = {}) {
  const sent: Array<{ headers: Record<string, string>; rpc: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } } }> = [];
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    if (o.offline) throw Object.assign(new Error(`timeout ${CONFIG.url}`), { name: "TimeoutError" });
    const rpc = JSON.parse(init.body);
    sent.push({ headers: init.headers, rpc });
    if (o.status) return new Response("{}", { status: o.status });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18" } });
    const tool = tools[rpc.params.name];
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(tool ? tool(rpc.params.arguments) : null) }] } });
  }) as unknown as typeof globalThis.fetch;
  return { client: new MindgoClient(CONFIG, { fetch }), sent };
}

const baseline = (over: Record<string, unknown> = {}) => ({ months_with_data: 12, currency: "CAD", monthly_income: 4_000, monthly_spending: 2_800, monthly_saving: 1_200, ...over });

test("config takes both settings or neither, insists on https, and never echoes the token", () => {
  expect(resolveMindgo(undefined, undefined)).toBeNull();
  expect(resolveMindgo(CONFIG.url, undefined)).toEqual({ problem: "MindGo needs both MINDGO_MCP_URL and MINDGO_TOKEN" });
  expect(resolveMindgo("http://mindgo.example.com/mcp", TOKEN)).toEqual({ problem: "MINDGO_MCP_URL must be https" });
  expect(resolveMindgo("http://localhost:3001/mcp", TOKEN)).toEqual({ url: "http://localhost:3001/mcp", token: TOKEN });
  const bad = resolveMindgo(CONFIG.url, "eyJhbGciOiJIUzI1NiJ9.a-login-jwt.sig");
  expect(bad).toHaveProperty("problem");
  expect(JSON.stringify(bad)).not.toContain("eyJ");
  expect(resolveMindgo(` ${CONFIG.url} `, ` ${TOKEN} `)).toEqual(CONFIG);
});

test("the client sends the token as a bearer header, and a refused token is explained without it", async () => {
  const ok = fakeMindgo({ money_goals: () => ({ goals: [] }) });
  await ok.client.callTool("money_goals");
  expect(ok.sent.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);

  const refused = fakeMindgo({}, { status: 401 });
  const err = (await refused.client.callTool("money_goals").catch((e: unknown) => e)) as Error;
  expect(err).toBeInstanceOf(MindgoError);
  expect(err.message).toMatch(/answered 401: check MINDGO_TOKEN/);
  expect(err.message).not.toContain(TOKEN);
});

test("the money tools pass the term through, and a sleeping server is explained, not a crash", async () => {
  const { client, sent } = fakeMindgo({ money_term_summary: (args) => ({ term: args.term ?? "current", expenses: 2_000 }) });
  const [thisTerm] = mindgoTools(client);
  expect(JSON.parse(await thisTerm!.run({ term: "previous" }))).toEqual({ term: "previous", expenses: 2_000 });
  expect(sent.at(-1)?.rpc.params?.arguments).toEqual({ term: "previous" });

  const asleep = fakeMindgo({}, { offline: true });
  const [, goals] = mindgoTools(asleep.client);
  const out = JSON.parse(await goals!.run({}));
  expect(out.status).toBe("unavailable");
  expect(out.message).toMatch(/waking up/);
});

test("when finance.json asks for it, the plan's monthly numbers come from MindGo, read once and cached", async () => {
  const { client, sent } = fakeMindgo({ money_baseline: () => baseline() });
  const used = await withMindgo(profile, client);
  expect(used.source).toEqual({ from: "MindGo", months: 12, monthlyIncome: 4_000 });
  expect(used.profile).toMatchObject({ monthlySpend: 2_800, monthlySavings: 1_200, age: 22, netAssets: 15_000 });
  await withMindgo(profile, client);
  expect(sent.filter((s) => s.rpc.method === "tools/call")).toHaveLength(1);
});

test("without monthlyFrom: mindgo, MindGo isn't even asked", async () => {
  const { client, sent } = fakeMindgo({ money_baseline: () => baseline() });
  const typed = { ...profile, monthlyFrom: "finance.json" as const };
  expect(await withMindgo(typed, client)).toEqual({ profile: typed, source: { from: "finance.json" } });
  expect(sent).toHaveLength(0);
});

test("finance.json stays in charge, and says why, when MindGo overspent, refused, is too new, in another currency, empty or asleep", async () => {
  const cases: Array<[ReturnType<typeof fakeMindgo>, RegExp]> = [
    [fakeMindgo({ money_baseline: () => baseline({ monthly_spending: 3_053.2, monthly_saving: -592.8 }) }), /spent more than they earned/],
    [fakeMindgo({}, { status: 401 }), /refused or failed: .*answered 401: check MINDGO_TOKEN/],
    [fakeMindgo({ money_baseline: () => ({ unexpected: true }) }), /expected shape/],
    [fakeMindgo({ money_baseline: () => baseline({ months_with_data: 2 }) }), /only 2 month/],
    [fakeMindgo({ money_baseline: () => baseline({ currency: "USD" }) }), /USD/],
    [fakeMindgo({ money_baseline: () => baseline({ months_with_data: 0, monthly_spending: null, monthly_saving: null }) }), /no records/],
    [fakeMindgo({}, { offline: true }), /didn't answer/],
  ];
  for (const [fake, why] of cases) {
    const used = await withMindgo(profile, fake.client);
    expect(used.profile).toBe(profile);
    expect(used.source.from).toBe("finance.json");
    expect("note" in used.source ? used.source.note : "").toMatch(why);
  }
  expect((await withMindgo(profile, null)).source.from).toBe("finance.json");
});

test("the FIRE tool says where its monthly numbers came from, and a what-if still wins over MindGo", async () => {
  const { client } = fakeMindgo({ money_baseline: () => baseline() });
  const [fire] = financeTools(profile, client);
  const saved = JSON.parse(await fire!.run({}));
  expect(saved.monthlyNumbersFrom).toMatch(/^MindGo: average monthly spending and saving over the last 12 months/);
  expect(saved.assumptions.monthlySpend).toBe(2_800);
  const whatIf = JSON.parse(await fire!.run({ monthlySpend: 2_000 }));
  expect(whatIf.assumptions.monthlySpend).toBe(2_000);
  expect(whatIf.assumptions.monthlySavings).toBe(1_200);
});

test("the toolset adds the money tools only when MindGo is set up", () => {
  const store = Store.open(":memory:");
  const without = agentToolset({ store, timeZone: "America/Toronto", healthMcpUrl: null });
  expect(without.money).toBeNull();
  expect(without.tools.definitions().map((t) => t.name)).not.toContain("money_this_term");
  const withMoney = agentToolset({ store, timeZone: "America/Toronto", healthMcpUrl: null, mindgo: CONFIG, finance: profile });
  expect(withMoney.tools.definitions().map((t) => t.name)).toEqual(expect.arrayContaining(["money_this_term", "money_goals", "fire_plan"]));
});

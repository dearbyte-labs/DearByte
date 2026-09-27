// MindGo, the user's budgeting app, read through its read-only MCP endpoint:
// this term's income and spending, a 12-month monthly baseline, and savings
// goals. Totals only: MindGo never sends a transaction, a description or a
// merchant. The access token can't change anything in MindGo, and revoking it
// there cuts DearByte off.

import { z } from "zod";
import { defineTool, type Tool } from "../agent/tools.ts";
import { McpClient, McpError, type McpClientOptions } from "../mcp/client.ts";
import type { MindgoConfig } from "../config.ts";

export class MindgoError extends McpError {}

/** MindGo's free hosting sleeps when idle, and the first request can take about 20 seconds to wake it. */
const WAKE_TIMEOUT_MS = 60_000;

export class MindgoClient extends McpClient {
  constructor(config: MindgoConfig, o: McpClientOptions = {}) {
    super(config.url, {
      timeoutMs: WAKE_TIMEOUT_MS,
      ...o,
      headers: { authorization: `Bearer ${config.token}` },
      name: "MindGo server",
      authHint: "check MINDGO_TOKEN (in MindGo: npm run access-token -- list <email>)",
      error: MindgoError,
    });
  }
}

type Source = Pick<McpClient, "callTool">;

/** What the FIRE plan takes from MindGo: monthly spending and saving over the last year. */
export const Baseline = z.object({
  months_with_data: z.number(),
  currency: z.string(),
  monthly_income: z.number().nullable(),
  monthly_spending: z.number().nullable(),
  monthly_saving: z.number().nullable(),
});
export type Baseline = z.infer<typeof Baseline>;

/** Fewer months than this are too few to plan a retirement on. */
export const MIN_BASELINE_MONTHS = 3;

export async function readBaseline(source: Source): Promise<Baseline | null> {
  const parsed = Baseline.safeParse(await source.callTool("money_baseline"));
  return parsed.success ? parsed.data : null;
}

/** A tool call that explains a sleeping server instead of just failing. */
async function call(source: Source, name: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    return JSON.stringify(await source.callTool(name, args));
  } catch (err) {
    if (err instanceof McpError && /timed out|could not connect/.test(err.message)) {
      return JSON.stringify({ status: "unavailable", message: "MindGo didn't answer. Its free hosting sleeps when idle; it may be waking up, so try again in a minute." });
    }
    throw err;
  }
}

export function mindgoTools(source: Source): Tool[] {
  return [
    defineTool({
      name: "money_this_term",
      description:
        "The user's money this Waterloo term (Winter Jan–Apr, Spring May–Aug, Fall Sep–Dec) from MindGo, their budgeting app: income, spending, savings rate and top spending categories in CAD, how far into the term they are, and pace (spending against last term at the same point; ratio above 1 is faster). Pass term: previous for last term. Totals from what they've entered, not bank records.",
      input: z.object({ term: z.enum(["current", "previous"]).optional() }),
      run: async ({ term }) => call(source, "money_term_summary", term ? { term } : {}),
    }),
    defineTool({
      name: "money_goals",
      description:
        "The user's savings goals from MindGo: each goal's target, amount saved, percent, target date, status (in progress, reached, overdue, no date) and what it needs per month to land on time.",
      input: z.object({}),
      run: async () => call(source, "money_goals"),
    }),
  ];
}

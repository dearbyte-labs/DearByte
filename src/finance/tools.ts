// The agent's FIRE tool: the plan from finance.json, with any "what if"
// changes the user asks about. Code does the math; the model explains it.

import { z } from "zod";
import { defineTool, type Tool } from "../agent/tools.ts";
import { withChanges, type FinanceProfile } from "./config.ts";
import { firePlan, type FireInput } from "./fire.ts";
import { MIN_BASELINE_MONTHS, readBaseline } from "./mindgo.ts";
import type { McpClient } from "../mcp/client.ts";

/** Where the plan's monthly numbers came from, for the model and the CLI to say. */
export type MonthlySource = { from: "finance.json"; note?: string } | { from: "MindGo"; months: number; monthlyIncome: number | null };

/**
 * The profile with MindGo's last-12-months spending and saving in place of the
 * typed-in monthly figures, when MindGo is connected, has enough months and
 * counts in the same currency. Otherwise the profile as it is, and why.
 */
export async function withMindgo(profile: FinanceProfile, mindgo: Pick<McpClient, "callTool"> | null): Promise<{ profile: FinanceProfile; source: MonthlySource }> {
  if (!mindgo) return { profile, source: { from: "finance.json" } };
  let baseline;
  try {
    baseline = await readBaseline(mindgo);
  } catch {
    return { profile, source: { from: "finance.json", note: "MindGo didn't answer (it may be waking up), so this uses finance.json's monthly numbers." } };
  }
  if (!baseline || baseline.monthly_spending === null || baseline.monthly_saving === null) {
    return { profile, source: { from: "finance.json", note: "MindGo has no records for the last 12 months yet." } };
  }
  if (baseline.months_with_data < MIN_BASELINE_MONTHS) {
    return { profile, source: { from: "finance.json", note: `MindGo has only ${baseline.months_with_data} month(s) of records, too few to plan on.` } };
  }
  if (baseline.currency !== profile.currency) {
    return { profile, source: { from: "finance.json", note: `MindGo counts in ${baseline.currency} but finance.json in ${profile.currency}.` } };
  }
  const merged = withChanges(profile, { monthlySpend: baseline.monthly_spending, monthlySavings: Math.max(0, baseline.monthly_saving) });
  if ("problem" in merged) return { profile, source: { from: "finance.json", note: "MindGo's numbers were out of range." } };
  return { profile: merged, source: { from: "MindGo", months: baseline.months_with_data, monthlyIncome: baseline.monthly_income } };
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);

/** The plan as the model sees it: rounded, with the assumptions next to the numbers, and net worth every five years. */
export function describePlan(profile: FinanceProfile, input: FireInput) {
  const p = firePlan(input);
  return {
    currency: profile.currency,
    note: "All amounts are in today's money (inflation-adjusted). Returns and inflation are assumptions, not predictions; say so when it matters. This is planning math, not investment advice.",
    assumptions: {
      age: input.age,
      retireAge: input.retireAge,
      lifespan: input.lifespan,
      netAssets: round(input.netAssets),
      monthlySavings: round(input.monthlySavings),
      monthlySpend: round(input.monthlySpend),
      yearlyReturn: input.returnRate,
      inflation: input.inflation,
      withdrawalRate: input.withdrawalRate,
    },
    fourPercentNumber: round(p.fourPercentNumber),
    dieWithZeroNumber: round(p.dieWithZeroNumber),
    retireNowNumber: round(p.retireNowNumber),
    assetsAtRetirement: round(p.assetsAtRetirement),
    maxMonthlySpendInRetirement: round(p.maxMonthlySpend),
    onTrack: p.onTrack,
    ...(p.onTrack
      ? {}
      : {
          runsOutAt: p.runsOutAt,
          ...(p.extraMonthlySavingsNeeded === null
            ? { fix: "They'd retire now, so there are no working months left to save in: retiring later (see earliestRetireAge) or spending less would." }
            : { extraMonthlySavingsNeeded: p.extraMonthlySavingsNeeded }),
        }),
    earliestRetireAge: p.earliestRetireAge,
    yearsToFourPercent: p.yearsToFourPercent === null ? null : Math.round(p.yearsToFourPercent * 10) / 10,
    coastNumber: round(p.coastNumber),
    netWorthByAge: p.years.filter((y, i) => i % 5 === 0 || i === p.years.length - 1 || y.age === input.retireAge).map((y) => ({ age: y.age, today: round(y.real) })),
    ...(profile.goals ? { goalsInTheirWords: profile.goals } : {}),
  };
}

export function describeSource(source: MonthlySource): string {
  if (source.from === "MindGo") {
    const saving = source.monthlyIncome === null ? "" : " (income minus spending, or 0 when spending was higher)";
    return `MindGo: average monthly spending and saving over the last ${source.months} months with records${saving}. Age, assets and targets are from finance.json.`;
  }
  return `finance.json, typed in by the user${source.note ? `. ${source.note}` : ""}`;
}

export function toInput(profile: FinanceProfile): FireInput {
  const { currency: _c, goals: _g, ...numbers } = profile;
  return numbers;
}

export function financeTools(saved: FinanceProfile, mindgo: Pick<McpClient, "callTool"> | null = null): Tool[] {
  return [
    defineTool({
      name: "fire_plan",
      description:
        "The user's road to financial independence from their saved finance profile: the 4% rule number, the die-with-zero number, projected net worth, how much they could spend in retirement, their earliest possible retirement age, and whether the plan lasts. Pass the new value of any field for a what-if (retireAge 45, monthlySpend 2000); leave them out for the saved plan. The saved values are in the result's assumptions.",
      // The same bounds as finance.json; the merged plan is checked again in run.
      input: z.object({
        retireAge: z.number().int().min(14).max(110).optional(),
        monthlySavings: z.number().min(0).max(1e10).optional(),
        monthlySpend: z.number().min(0).max(1e10).optional(),
        netAssets: z.number().min(-1e9).max(1e10).optional(),
        lifespan: z.number().int().min(30).max(120).optional(),
        returnRate: z.number().min(-0.2).max(0.3).optional().describe("Yearly return before inflation, e.g. 0.05"),
        inflation: z.number().min(-0.2).max(0.3).optional(),
      }),
      run: async (change) => {
        const { profile, source } = await withMindgo(saved, mindgo);
        const plan = withChanges(profile, change);
        if ("problem" in plan) return JSON.stringify({ status: "invalid", message: plan.problem });
        const asked = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
        return JSON.stringify({ status: "ok", monthlyNumbersFrom: describeSource(source), ...(Object.keys(asked).length ? { whatIf: asked } : {}), ...describePlan(plan, toInput(plan)) });
      },
    }),
  ];
}

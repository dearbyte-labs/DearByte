// The FIRE plan as text for the terminal: the numbers, then net worth by age
// as a bar chart. Code writes all of it; no model is involved.

import type { FinanceProfile } from "./config.ts";
import { firePlan, type FireInput } from "./fire.ts";

const FLAGS: Record<string, keyof FireInput> = {
  "--retire": "retireAge",
  "--spend": "monthlySpend",
  "--save": "monthlySavings",
  "--assets": "netAssets",
  "--lifespan": "lifespan",
  "--return": "returnRate",
  "--inflation": "inflation",
};

/** "--retire 45 --spend 2000" → what-if changes, or the problem with them. Rates are given in percent. */
export function parseWhatIf(args: string[]): Partial<FireInput> | { problem: string } {
  const change: Partial<FireInput> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = FLAGS[args[i]!];
    const value = Number(args[i + 1]);
    if (!key) return { problem: `Unknown option ${args[i]}. Use ${Object.keys(FLAGS).join(", ")}.` };
    if (args[i + 1] === undefined || !Number.isFinite(value)) return { problem: `${args[i]} needs a number.` };
    change[key] = key === "returnRate" || key === "inflation" ? value / 100 : value;
  }
  return change;
}

export function formatPlan(profile: FinanceProfile, input: FireInput): string {
  const p = firePlan(input);
  const money = (n: number) => `${n < 0 ? "-" : ""}${profile.currency} ${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const lines = [
    `Your road to financial independence (in today's money, ${profile.currency})`,
    `Assuming ${pct(input.returnRate)} yearly returns, ${pct(input.inflation)} inflation, and money lasting to ${input.lifespan}.`,
    "",
    `  Now, at ${input.age}         ${money(input.netAssets)}, saving ${money(input.monthlySavings)} and spending ${money(input.monthlySpend)} a month`,
    `  At ${input.retireAge}, you'd have   ${money(p.assetsAtRetirement)}`,
    `  Die-with-zero number   ${money(p.dieWithZeroNumber)}  (enough at ${input.retireAge} to spend ${money(input.monthlySpend)} a month until ${input.lifespan})`,
    `  ${`${pct(input.withdrawalRate)} rule number`.padEnd(23)}${money(p.fourPercentNumber)}  (${Math.round(10 / input.withdrawalRate) / 10} years of spending, meant to last indefinitely)`,
    `  Retire today needs     ${money(p.retireNowNumber)}`,
    `  Coast number           ${money(p.coastNumber)}  (have this now and you could stop saving)`,
    `  From ${input.retireAge} you could spend ${money(p.maxMonthlySpend)} a month and reach ${input.lifespan} with nothing left.`,
    p.onTrack
      ? `  On track: the plan lasts to ${input.lifespan}.`
      : p.extraMonthlySavingsNeeded === null
        ? `  Not yet: the money runs out at ${p.runsOutAt}. Retiring now leaves no time to save; retire later or spend less.`
        : `  Not yet: the money runs out at ${p.runsOutAt}. Saving ${money(p.extraMonthlySavingsNeeded)} more a month would fix it.`,
    `  Earliest you could stop working: ${p.earliestRetireAge ?? "not before " + input.lifespan}.`,
    `  Years to the 4% number: ${p.yearsToFourPercent === null ? "more than 100" : Math.round(p.yearsToFourPercent * 10) / 10}.`,
    "",
    "Net worth by age (today's money)",
  ];
  const points = p.years.filter((y, i) => i % 5 === 0 || i === p.years.length - 1 || y.age === input.retireAge);
  const top = Math.max(1, ...points.map((y) => y.real));
  for (const y of points) {
    const bar = "█".repeat(Math.max(0, Math.round((y.real / top) * 40)));
    lines.push(`  ${String(y.age).padStart(3)} ${bar} ${money(y.real)}${y.age === input.retireAge ? "  ← retire" : ""}`);
  }
  lines.push("", "Returns and inflation are assumptions, not predictions. This is planning math, not investment advice.");
  return lines.join("\n");
}

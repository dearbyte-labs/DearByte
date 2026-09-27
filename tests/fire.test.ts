import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadFinance, withChanges, type FinanceProfile } from "../src/finance/config.ts";
import { firePlan, realMonthlyReturn, type FireInput } from "../src/finance/fire.ts";
import { formatPlan, parseWhatIf } from "../src/finance/report.ts";
import { financeTools, toInput } from "../src/finance/tools.ts";

const base: FireInput = { age: 22, retireAge: 50, lifespan: 90, netAssets: 15_000, monthlySavings: 1_200, monthlySpend: 2_500, returnRate: 0.07, inflation: 0.03, withdrawalRate: 0.04 };
const last = (i: FireInput) => firePlan(i).years.at(-1)!.real;

test("the 4% number is 25 years of spending; real returns take inflation out", () => {
  expect(firePlan(base).fourPercentNumber).toBe(750_000);
  expect(Math.pow(1 + realMonthlyReturn(0.07, 0.03), 12)).toBeCloseTo(1.07 / 1.03, 12);
});

test("with no real return, die-with-zero is just spending times months", () => {
  const p = firePlan({ ...base, returnRate: 0.03, inflation: 0.03 });
  expect(p.dieWithZeroNumber).toBeCloseTo(2_500 * 40 * 12, 6);
});

test("retiring today with the retire-now number leaves nothing at the end, and one less dollar runs out", () => {
  const now = { ...base, retireAge: base.age, netAssets: firePlan(base).retireNowNumber, monthlySavings: 0 };
  expect(Math.abs(firePlan(now).years.at(-1)!.real)).toBeLessThan(1);
  expect(firePlan({ ...now, netAssets: now.netAssets - 1_000 }).onTrack).toBe(false);
});

test("spending the max monthly amount from retirement ends at about zero", () => {
  const max = firePlan(base).maxMonthlySpend;
  const retired = { ...base, monthlySpend: max };
  // Spending changes only after retirement here, so compare against a plan that saves the same while working.
  const p = firePlan(retired);
  expect(p.assetsAtRetirement).toBeCloseTo(firePlan(base).assetsAtRetirement, 6);
  expect(Math.abs(last(retired))).toBeLessThan(1);
});

test("a short plan says when the money runs out and how much more to save; saving that makes it last", () => {
  const short = { ...base, retireAge: 40, returnRate: 0.05 };
  const p = firePlan(short);
  expect(p.onTrack).toBe(false);
  expect(p.runsOutAt).toBeGreaterThan(40);
  expect(p.years.filter((y) => y.age > p.runsOutAt!).every((y) => y.real === 0)).toBe(true);
  const fixed = firePlan({ ...short, monthlySavings: short.monthlySavings + p.extraMonthlySavingsNeeded! });
  expect(fixed.onTrack).toBe(true);
  expect(fixed.extraMonthlySavingsNeeded).toBe(0);
});

test("the earliest retirement age lasts, and a year earlier doesn't", () => {
  const { earliestRetireAge } = firePlan(base);
  expect(earliestRetireAge).toBe(47);
  expect(firePlan({ ...base, retireAge: 47 }).onTrack).toBe(true);
  expect(firePlan({ ...base, retireAge: 46 }).onTrack).toBe(false);
});

test("coast number grows into the die-with-zero number by retirement with no more saving", () => {
  const p = firePlan(base);
  const coast = firePlan({ ...base, netAssets: p.coastNumber, monthlySavings: 0 });
  expect(coast.assetsAtRetirement).toBeCloseTo(p.dieWithZeroNumber, 4);
});

test("years to the 4% number, and null when it never arrives", () => {
  expect(firePlan(base).yearsToFourPercent).toBe(27.75);
  expect(firePlan({ ...base, monthlySavings: 0, netAssets: 0 }).yearsToFourPercent).toBeNull();
  expect(firePlan({ ...base, netAssets: 1_000_000 }).yearsToFourPercent).toBe(0);
});

const profile: FinanceProfile = { currency: "CAD", ...base, monthlyFrom: "finance.json", goals: "Stop working by 50." };

test("finance.json is validated with defaults, and bad ages are explained", () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-finance-"));
  const path = join(dir, "finance.json");
  expect(loadFinance(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ currency: "CAD", age: 30, retireAge: 55, netAssets: 0, monthlySavings: 500, monthlySpend: 3000 }));
  expect(loadFinance(path)).toMatchObject({ lifespan: 90, returnRate: 0.07, inflation: 0.03, withdrawalRate: 0.04 });
  writeFileSync(path, JSON.stringify({ currency: "CAD", age: 30, retireAge: 25, netAssets: 0, monthlySavings: 500, monthlySpend: 3000 }));
  expect(loadFinance(path)).toMatchObject({ problem: expect.stringContaining("retireAge can't be before age") });
  writeFileSync(path, "{ nope");
  expect(loadFinance(path)).toMatchObject({ problem: expect.stringContaining("isn't valid JSON") });
});

test("the fire_plan tool answers the saved plan and what-ifs, in rounded numbers with the assumptions", async () => {
  const [tool] = financeTools(profile);
  const saved = JSON.parse(await tool!.run({}));
  expect(saved).toMatchObject({ status: "ok", currency: "CAD", fourPercentNumber: 750_000, earliestRetireAge: 47, onTrack: true, goalsInTheirWords: "Stop working by 50." });
  expect(saved.note).toContain("not investment advice");
  expect(saved.whatIf).toBeUndefined();
  const early = JSON.parse(await tool!.run({ retireAge: 40, returnRate: 0.05 }));
  expect(early).toMatchObject({ whatIf: { retireAge: 40, returnRate: 0.05 }, onTrack: false, assumptions: { retireAge: 40, yearlyReturn: 0.05 } });
  expect(early.extraMonthlySavingsNeeded).toBeGreaterThan(0);
  expect(JSON.parse(await tool!.run({ retireAge: 18 }))).toMatchObject({ status: "invalid" });
});

test("what-if flags take percents for rates and reject what they don't know", () => {
  expect(parseWhatIf(["--retire", "45", "--return", "5"])).toEqual({ retireAge: 45, returnRate: 0.05 });
  expect(parseWhatIf(["--retire"])).toMatchObject({ problem: "--retire needs a number." });
  expect(parseWhatIf(["--yolo", "1"])).toMatchObject({ problem: expect.stringContaining("Unknown option --yolo") });
});

test("the terminal report shows the numbers, the chart and the caveat", () => {
  const text = formatPlan(profile, toInput(profile));
  expect(text).toContain("4% rule number         CAD 750,000");
  expect(text).toContain("On track: the plan lasts to 90.");
  expect(text).toMatch(/^ {2} 50 █+ CAD 762,849  ← retire$/m);
  expect(text).toContain("not investment advice");
  const early = withChanges(profile, { retireAge: 40, returnRate: 0.05 }) as FinanceProfile;
  expect(formatPlan(early, toInput(early))).toContain("Not yet: the money runs out at");
  const cautious = withChanges(profile, { withdrawalRate: 0.035 }) as FinanceProfile;
  expect(formatPlan(cautious, toInput(cautious))).toContain("3.5% rule number       CAD 857,143  (28.6 years of spending");
});

test("debt while working isn't running out: a plan starting below zero can still be on track", () => {
  const p = firePlan({ ...base, netAssets: -20_000 });
  expect(p.onTrack).toBe(true);
  expect(p.runsOutAt).toBeNull();
  expect(p.earliestRetireAge).toBeGreaterThan(47);
  expect(p.years.at(0)!.real).toBe(-20_000);
  expect(p.years.find((y) => y.age === 50)!.real).toBeGreaterThan(p.dieWithZeroNumber);
});

test("retiring now with too little says to retire later, not to save an infinite amount", () => {
  const p = firePlan({ ...base, retireAge: 22 });
  expect(p.onTrack).toBe(false);
  expect(p.extraMonthlySavingsNeeded).toBeNull();
  const now = withChanges(profile, { retireAge: 22 }) as FinanceProfile;
  expect(formatPlan(now, toInput(now))).toContain("Retiring now leaves no time to save");
  expect(formatPlan(now, toInput(now))).not.toContain("∞");
});

test("spending exactly the max is on track, and a short plan never asks for 0 more", () => {
  expect(firePlan({ ...base, monthlySpend: firePlan(base).maxMonthlySpend }).onTrack).toBe(true);
  const barely = firePlan({ ...base, monthlySpend: firePlan(base).maxMonthlySpend + 1 });
  expect(barely.onTrack).toBe(false);
  expect(barely.extraMonthlySavingsNeeded).toBeGreaterThanOrEqual(1);
});

test("what-ifs from the terminal and the tool get the profile's bounds", async () => {
  expect(withChanges(profile, { returnRate: -1.5 })).toMatchObject({ problem: expect.stringContaining("returnRate") });
  expect(withChanges(profile, { monthlySpend: -500 })).toMatchObject({ problem: expect.stringContaining("monthlySpend") });
  expect(withChanges(profile, { retireAge: 45.5 })).toMatchObject({ problem: expect.stringContaining("retireAge") });
  expect(withChanges(profile, { lifespan: 40 })).toMatchObject({ problem: expect.stringContaining("lifespan must be after retireAge") });
  const [tool] = financeTools(profile);
  expect(JSON.parse(await tool!.run({ lifespan: 45 }))).toMatchObject({ status: "invalid" });
});

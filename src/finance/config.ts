// The user's money picture for the FIRE plan: age, what they own, what they
// save and spend, and what they're aiming for. It lives in finance.json,
// which is personal and ignored by Git; see finance.example.json. Once
// MindGo is connected, its numbers can replace the monthly figures here.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { FIRE_DEFAULTS } from "./fire.ts";

const Money = z.number().min(0).max(1e10);
const Rate = z.number().min(-0.2).max(0.3);

export const FinanceProfile = z
  .object({
    /** Only a label: every amount in the file is in this currency. */
    currency: z.string().regex(/^[A-Z]{3}$/, "a currency code like CAD or USD"),
    // Whole years: the plan and its chart step by year of age.
    age: z.number().int().min(14).max(100),
    retireAge: z.number().int().min(14).max(110),
    lifespan: z.number().int().min(30).max(120).default(FIRE_DEFAULTS.lifespan),
    netAssets: z.number().min(-1e9).max(1e10),
    monthlySavings: Money,
    monthlySpend: Money,
    returnRate: Rate.default(FIRE_DEFAULTS.returnRate),
    inflation: Rate.default(FIRE_DEFAULTS.inflation),
    withdrawalRate: z.number().min(0.01).max(0.1).default(FIRE_DEFAULTS.withdrawalRate),
    /** In the user's words: what the money is for. */
    goals: z.string().max(1000).optional(),
  })
  .refine((p) => p.retireAge >= p.age, { message: "retireAge can't be before age", path: ["retireAge"] })
  .refine((p) => p.lifespan > p.retireAge, { message: "lifespan must be after retireAge", path: ["lifespan"] });
export type FinanceProfile = z.infer<typeof FinanceProfile>;

/** The profile with what-if changes, checked against the same bounds as the file; or what's wrong with them. */
export function withChanges(profile: FinanceProfile, change: Record<string, number | undefined>): FinanceProfile | { problem: string } {
  const merged = { ...profile, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) };
  const parsed = FinanceProfile.safeParse(merged);
  return parsed.success ? parsed.data : { problem: z.prettifyError(parsed.error) };
}

/** The profile at `path`, null when there's no file, or the problem with it. */
export function loadFinance(path: string): FinanceProfile | { problem: string } | null {
  if (!existsSync(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { problem: `${path} isn't valid JSON: ${(err as Error).message}` };
  }
  const parsed = FinanceProfile.safeParse(json);
  return parsed.success ? parsed.data : { problem: `${path}: ${z.prettifyError(parsed.error)}` };
}

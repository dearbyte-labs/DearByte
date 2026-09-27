// The road to financial independence, computed in code: the model explains
// these numbers, it never works them out. Everything is in today's money:
// returns are turned into real returns (above inflation) once, so a number
// here means what that money buys now.
//
// Two ways to call a pot of money "enough":
// - the 4% rule: 25 times a year's spending, meant to last indefinitely;
// - die with zero: just enough to fund the same spending until the expected
//   lifespan, spending the principal down to nothing. Smaller, and it depends
//   on how long you live, so the lifespan should be generous.

export type FireInput = {
  age: number;
  /** When the user wants to stop working. */
  retireAge: number;
  /** Plan to here: money should last at least this long. */
  lifespan: number;
  /** Everything owned minus debts: investments, cash, property equity. */
  netAssets: number;
  /** Saved or invested each month while working. */
  monthlySavings: number;
  /** Spent each month, now and in retirement (in today's money). */
  monthlySpend: number;
  /** Expected yearly return before inflation, e.g. 0.07. */
  returnRate: number;
  /** Expected yearly inflation, e.g. 0.03. */
  inflation: number;
  /** For the 4% rule, e.g. 0.04. */
  withdrawalRate: number;
};

export const FIRE_DEFAULTS = { lifespan: 90, returnRate: 0.07, inflation: 0.03, withdrawalRate: 0.04 } as const;

export type YearPoint = {
  age: number;
  /** In today's money. */
  real: number;
  /** In the money of that year, the number a statement would show. */
  nominal: number;
};

export type FirePlan = {
  /** Monthly return above inflation. */
  realMonthlyReturn: number;
  /** 4% rule: enough to live on indefinitely. */
  fourPercentNumber: number;
  /** Die with zero: enough at retireAge to spend monthlySpend until lifespan. */
  dieWithZeroNumber: number;
  /** Die with zero if retiring today. */
  retireNowNumber: number;
  /** Projected net worth at retireAge, saving monthlySavings until then. */
  assetsAtRetirement: number;
  /** The most that can be spent each month from retireAge so the money lasts exactly to lifespan. */
  maxMonthlySpend: number;
  /** Whether the plan's spending lasts to lifespan. */
  onTrack: boolean;
  /** Extra monthly saving that would make it last, rounded up; 0 when on track, null when there are no working months left to save in. */
  extraMonthlySavingsNeeded: number | null;
  /** The earliest whole age the user could stop working and still have money until lifespan, or null if never before lifespan. */
  earliestRetireAge: number | null;
  /** Years of saving until net worth reaches the 4% number, or null if not within 100 years. */
  yearsToFourPercent: number | null;
  /** Coast FI: with this much today, saving could stop and the die-with-zero number still arrives by retireAge. */
  coastNumber: number;
  /** The age the money runs out on this plan, or null if it lasts to lifespan. */
  runsOutAt: number | null;
  /** Net worth at the start of every year of age, from now to lifespan. */
  years: YearPoint[];
};

/** Monthly return above inflation, from yearly nominal return and inflation. */
export function realMonthlyReturn(returnRate: number, inflation: number): number {
  return Math.pow((1 + returnRate) / (1 + inflation), 1 / 12) - 1;
}

/** What `monthly` paid for `months` months is worth today, at monthly rate `r`. */
function presentValue(monthly: number, months: number, r: number): number {
  if (months <= 0) return 0;
  return r === 0 ? monthly * months : (monthly * (1 - Math.pow(1 + r, -months))) / r;
}

/** Monthly payment that `amount` funds for `months` months at monthly rate `r`. */
function payment(amount: number, months: number, r: number): number {
  if (months <= 0) return 0;
  return r === 0 ? amount / months : (amount * r) / (1 - Math.pow(1 + r, -months));
}

/** Net worth in today's money, month by month from `age`, retiring at `retireAge`. */
function simulate(i: FireInput, retireAge: number, r: number): { monthly: number[]; runsOutAt: number | null } {
  const months = Math.round((i.lifespan - i.age) * 12);
  const working = Math.max(0, Math.round((retireAge - i.age) * 12));
  const monthly = [i.netAssets];
  let assets = i.netAssets;
  let runsOutAt: number | null = null;
  for (let m = 0; m < months; m++) {
    assets = assets * (1 + r) + (m < working ? i.monthlySavings : -i.monthlySpend);
    // Debt while still working isn't running out; below zero in retirement is. Half a unit absorbs float noise at the exact limit.
    if (m >= working && assets < -0.5 && runsOutAt === null) runsOutAt = Math.floor(i.age + (m + 1) / 12);
    monthly.push(assets);
  }
  return { monthly, runsOutAt };
}

export function firePlan(i: FireInput): FirePlan {
  const r = realMonthlyReturn(i.returnRate, i.inflation);
  const retirementMonths = Math.round((i.lifespan - i.retireAge) * 12);
  const working = Math.max(0, Math.round((i.retireAge - i.age) * 12));
  const { monthly, runsOutAt } = simulate(i, i.retireAge, r);
  const assetsAtRetirement = monthly[working]!;
  const dieWithZeroNumber = presentValue(i.monthlySpend, retirementMonths, r);
  const fourPercentNumber = (i.monthlySpend * 12) / i.withdrawalRate;

  const shortfall = Math.max(0, dieWithZeroNumber - assetsAtRetirement);
  const growth = working > 0 ? (r === 0 ? working : (Math.pow(1 + r, working) - 1) / r) : 0;
  const onTrack = runsOutAt === null;
  const extraMonthlySavingsNeeded = onTrack ? 0 : growth > 0 ? Math.ceil(shortfall / growth) : null;

  let earliestRetireAge: number | null = null;
  for (let a = Math.ceil(i.age); a < i.lifespan; a++) {
    if (simulate(i, a, r).runsOutAt === null) {
      earliestRetireAge = a;
      break;
    }
  }

  let yearsToFourPercent: number | null = null;
  let assets = i.netAssets;
  for (let m = 0; m <= 1200; m++) {
    if (assets >= fourPercentNumber) {
      yearsToFourPercent = m / 12;
      break;
    }
    assets = assets * (1 + r) + i.monthlySavings;
  }

  const years: YearPoint[] = [];
  for (let y = 0; y * 12 < monthly.length; y++) {
    // Once the money has run out, the plan shows nothing left rather than a debt compounding at market returns.
    const real = runsOutAt !== null && i.age + y > runsOutAt ? 0 : monthly[y * 12]!;
    years.push({ age: i.age + y, real, nominal: real * Math.pow(1 + i.inflation, y) });
  }

  return {
    realMonthlyReturn: r,
    fourPercentNumber,
    dieWithZeroNumber,
    retireNowNumber: presentValue(i.monthlySpend, Math.round((i.lifespan - i.age) * 12), r),
    assetsAtRetirement,
    maxMonthlySpend: Math.max(0, payment(assetsAtRetirement, retirementMonths, r)),
    onTrack,
    extraMonthlySavingsNeeded,
    earliestRetireAge,
    yearsToFourPercent,
    coastNumber: dieWithZeroNumber / Math.pow(1 + r, working),
    runsOutAt,
    years,
  };
}

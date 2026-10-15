// Monthly EPF contributions. All amounts are in paise.

// Premise in-epf-ceiling@1 (final): ₹15,000 a month.
export const EPF_WAGE_CEILING_PAISE = 1_500_000;
// Premise in-epf-rate@1 (draft): 12% each from employee and employer.
export const EPF_RATE_PERCENT = 12;
// Premise in-eps-rate@1 (draft): 8.33% of the employer's 12% goes to EPS.
export const EPS_RATE_BASIS_POINTS = 833;
// Premise in-epf-rounding@1 (draft): each contribution to the nearest rupee, 50 paise rounding up.
export const EPF_ROUNDING_PAISE = 100;

export interface EpfContribution {
  /** Basic wages the contributions were computed on, after the ceiling. */
  wagesConsidered: number;
  employee: number;
  employerEpf: number;
  employerEps: number;
}

/** basicWages × basisPoints / 10,000, rounded half-up to the rupee, in integer arithmetic. */
function contribution(basicWages: number, basisPoints: number): number {
  const scale = 10_000 * EPF_ROUNDING_PAISE;
  return Math.floor((basicWages * basisPoints + scale / 2) / scale) * EPF_ROUNDING_PAISE;
}

export function monthlyEpf(basicWagesPaise: number): EpfContribution {
  if (!Number.isInteger(basicWagesPaise) || basicWagesPaise < 0) {
    throw new RangeError(`basic wages must be a non-negative integer of paise, got ${basicWagesPaise}`);
  }
  const wagesConsidered = Math.min(basicWagesPaise, EPF_WAGE_CEILING_PAISE);
  const employee = contribution(wagesConsidered, EPF_RATE_PERCENT * 100);
  const employerEps = contribution(wagesConsidered, EPS_RATE_BASIS_POINTS);
  // The employer's share matches the employee's; what is not EPS stays in EPF.
  const employerEpf = employee - employerEps;
  return { wagesConsidered, employee, employerEpf, employerEps };
}

// Monthly ESI contributions. All amounts are in paise.

// Premise in-esi-ceiling@1 (final): covered when gross wages are ₹21,000 a month or less.
export const ESI_WAGE_CEILING_PAISE = 2_100_000;
// Premise in-esi-employee-rate@1 (draft): 0.75% of gross wages from the employee.
export const ESI_EMPLOYEE_RATE_BASIS_POINTS = 75;
// Premise in-esi-employer-rate@1 (draft): 3.25% of gross wages from the employer.
export const ESI_EMPLOYER_RATE_BASIS_POINTS = 325;
// Premise in-esi-rounding@1 (draft): each contribution rounded up to the next rupee.
export const ESI_ROUNDING_PAISE = 100;

export interface EsiContribution {
  covered: boolean;
  employee: number;
  employer: number;
}

function requireNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer of paise, got ${value}`);
  }
}

/** grossWages × basisPoints / 10,000, rounded up to the rupee, in integer arithmetic. */
function contribution(grossWages: number, basisPoints: number): number {
  const scale = 10_000 * ESI_ROUNDING_PAISE;
  return Math.floor((grossWages * basisPoints + scale - 1) / scale) * ESI_ROUNDING_PAISE;
}

/**
 * Coverage is decided on the wages at the start of the contribution period and holds to its end,
 * so a raise above the ceiling mid-period does not stop contributions. Pass those wages as
 * `coverageWagesPaise`; they default to this month's. Contributions are on the full gross wages,
 * with no cap. The exemption of the lowest-paid from their own share is not applied here.
 */
export function monthlyEsi(grossWagesPaise: number, coverageWagesPaise = grossWagesPaise): EsiContribution {
  requireNonNegativeInteger(grossWagesPaise, "gross wages");
  requireNonNegativeInteger(coverageWagesPaise, "coverage wages");
  if (coverageWagesPaise > ESI_WAGE_CEILING_PAISE) {
    return { covered: false, employee: 0, employer: 0 };
  }
  return {
    covered: true,
    employee: contribution(grossWagesPaise, ESI_EMPLOYEE_RATE_BASIS_POINTS),
    employer: contribution(grossWagesPaise, ESI_EMPLOYER_RATE_BASIS_POINTS),
  };
}

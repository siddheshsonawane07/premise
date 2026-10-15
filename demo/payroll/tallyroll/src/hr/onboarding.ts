// Onboarding check: from a new hire's offered salary, which statutory coverage applies. The notes
// quote the figures from the payroll modules, never their own copies, so a rule change reaches HR
// with the calculation.

import { EPF_WAGE_CEILING_PAISE } from "../in/epf.ts";
import { ESI_WAGE_CEILING_PAISE, monthlyEsi } from "../in/esi.ts";
import { FLSA_SALARY_LEVEL_CENTS, OVERTIME_RATE_PERCENT, OVERTIME_THRESHOLD_HOURS, meetsSalaryLevel } from "../us/flsa.ts";

export interface IndianOffer {
  country: "IN";
  /** Offered monthly basic wages for PF, in paise: basic + DA + retaining allowance. */
  basicWagesPaise: number;
  /** Offered monthly gross wages, in paise. */
  grossWagesPaise: number;
}

export interface UsOffer {
  country: "US";
  /** Offered annual salary, in cents. */
  annualSalaryCents: number;
}

export interface IndianCoverage {
  country: "IN";
  /** PF membership is mandatory at or under the ceiling; above it the hire may decline it. */
  pf: "mandatory" | "optional";
  esi: boolean;
  notes: string[];
}

export interface UsCoverage {
  country: "US";
  /** Whether the salary allows an overtime exemption. Not whether the role is exempt. */
  canBeExempt: boolean;
  notes: string[];
}

const WEEKS_PER_YEAR = 52;

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function requireNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
  }
}

/**
 * PF and ESI coverage for an Indian hire. Assumes the establishment is itself covered by both
 * schemes; the employee-count and notified-area conditions are not checked here.
 */
function indianCoverage(offer: IndianOffer): IndianCoverage {
  requireNonNegativeInteger(offer.basicWagesPaise, "basic wages in paise");
  requireNonNegativeInteger(offer.grossWagesPaise, "gross wages in paise");
  const pfCeiling = inr.format(EPF_WAGE_CEILING_PAISE / 100);
  const esiCeiling = inr.format(ESI_WAGE_CEILING_PAISE / 100);

  const pf = offer.basicWagesPaise <= EPF_WAGE_CEILING_PAISE ? "mandatory" : "optional";
  // A new hire's offered wages are the wages at the start of their first ESI contribution period.
  const esi = monthlyEsi(offer.grossWagesPaise).covered;

  return {
    country: "IN",
    pf,
    esi,
    notes: [
      pf === "mandatory"
        ? `PF: mandatory. Basic wages are ${pfCeiling} a month or less.`
        : `PF: optional. Basic wages are above ${pfCeiling} a month, so the hire may decline PF at joining —` +
          ` unless they are already a PF member from a previous job, in which case it continues.`,
      esi
        ? `ESI: covered. Gross wages are ${esiCeiling} a month or less.`
        : `ESI: not covered. Gross wages are above ${esiCeiling} a month.`,
    ],
  };
}

/** Federal FLSA salary level test only; state thresholds can be higher. */
function usCoverage(offer: UsOffer): UsCoverage {
  requireNonNegativeInteger(offer.annualSalaryCents, "annual salary in cents");
  // Flooring cannot change the outcome: floor(a / 52) ≥ level exactly when a ≥ 52 × level.
  const canBeExempt = meetsSalaryLevel(Math.floor(offer.annualSalaryCents / WEEKS_PER_YEAR));
  const level = `${usd.format(FLSA_SALARY_LEVEL_CENTS / 100)} a week` +
    ` (${usd.format((FLSA_SALARY_LEVEL_CENTS * WEEKS_PER_YEAR) / 100)} a year)`;

  return {
    country: "US",
    canBeExempt,
    notes: [
      canBeExempt
        ? `Overtime: the salary meets the federal level of ${level}, so the role can be exempt —` +
          ` only if it also passes the salary basis and duties tests, and any state test.`
        : `Overtime: the salary is below the federal level of ${level}, so the role cannot be exempt.` +
          ` Pay overtime at ${OVERTIME_RATE_PERCENT}% of the regular rate for hours beyond` +
          ` ${OVERTIME_THRESHOLD_HOURS} in a workweek.`,
    ],
  };
}

export function onboardingCoverage(offer: IndianOffer): IndianCoverage;
export function onboardingCoverage(offer: UsOffer): UsCoverage;
export function onboardingCoverage(offer: IndianOffer | UsOffer): IndianCoverage | UsCoverage;
export function onboardingCoverage(offer: IndianOffer | UsOffer): IndianCoverage | UsCoverage {
  return offer.country === "IN" ? indianCoverage(offer) : usCoverage(offer);
}

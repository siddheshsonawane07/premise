// Monthly compliance summary across both countries, as CSV: how many Indian employees are in
// mandatory PF and ESI, and how many US employees are paid at or above the federal overtime
// exemption salary level. Coverage is decided by the payroll and HR modules, never a copy here, so a
// rule change reaches the report with the calculation.

import { onboardingCoverage } from "../hr/onboarding.ts";
import { monthlyEsi } from "../in/esi.ts";

export interface IndianEmployee {
  country: "IN";
  /** This month's basic wages for PF, in paise: basic + DA + retaining allowance. */
  basicWagesPaise: number;
  /** This month's gross wages, in paise. */
  grossWagesPaise: number;
  /** Gross wages at the start of the ESI contribution period; defaults to this month's. */
  esiCoverageWagesPaise?: number;
}

export interface UsEmployee {
  country: "US";
  /** Annual salary, in cents. */
  annualSalaryCents: number;
}

export type Employee = IndianEmployee | UsEmployee;

const HEADER = ["period", "country", "measure", "count", "out_of"];

/** Quotes a field only when it holds a comma, quote or line break. */
function field(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One row per measure, with the number of employees it applies to out of that country's headcount.
 * `period` is printed as given, e.g. "2026-10". The US count is the federal salary level test only:
 * an employee counted here can be exempt, not necessarily is.
 */
export function monthlyComplianceCsv(period: string, employees: Employee[]): string {
  let indian = 0, pfMandatory = 0, esiCovered = 0;
  let us = 0, meetsSalaryLevel = 0;

  for (const e of employees) {
    if (e.country === "IN") {
      indian++;
      if (onboardingCoverage(e).pf === "mandatory") pfMandatory++;
      if (monthlyEsi(e.grossWagesPaise, e.esiCoverageWagesPaise).covered) esiCovered++;
    } else {
      us++;
      if (onboardingCoverage(e).canBeExempt) meetsSalaryLevel++;
    }
  }

  const rows: (string | number)[][] = [
    HEADER,
    [period, "IN", "PF mandatory", pfMandatory, indian],
    [period, "IN", "ESI covered", esiCovered, indian],
    [period, "US", "Salary meets FLSA exemption level", meetsSalaryLevel, us],
  ];
  return rows.map((r) => r.map(field).join(",")).join("\n") + "\n";
}

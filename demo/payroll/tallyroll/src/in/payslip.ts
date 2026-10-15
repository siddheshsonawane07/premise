// Payslip text for an Indian employee: the PF, pension and ESI lines, each with a note saying when
// it applies. All amounts are in paise. The notes quote the figures from epf.ts and esi.ts, never
// their own copies, so a rule change reaches the payslip with the calculation.

import { EPF_RATE_PERCENT, EPF_WAGE_CEILING_PAISE, EPS_RATE_BASIS_POINTS, monthlyEpf } from "./epf.ts";
import {
  ESI_EMPLOYEE_RATE_BASIS_POINTS,
  ESI_EMPLOYER_RATE_BASIS_POINTS,
  ESI_WAGE_CEILING_PAISE,
  monthlyEsi,
} from "./esi.ts";

export interface IndianPayslipInput {
  employeeName: string;
  /** The month the payslip covers, as it should be printed, e.g. "October 2026". */
  period: string;
  /** Basic wages for PF: basic + DA + retaining allowance. */
  basicWagesPaise: number;
  grossWagesPaise: number;
  /** Gross wages at the start of the ESI contribution period; defaults to this month's. */
  esiCoverageWagesPaise?: number;
}

const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const wholeRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

const money = (paise: number) => amount.format(paise / 100);
const ceiling = (paise: number) => wholeRupees.format(paise / 100);
const percent = (basisPoints: number) => `${basisPoints / 100}%`;

const LABEL_WIDTH = 30;
const AMOUNT_WIDTH = 14;
const NONE = "—";

function row(label: string, employee: string, employer: string): string {
  return (label.padEnd(LABEL_WIDTH) + employee.padStart(AMOUNT_WIDTH) + employer.padStart(AMOUNT_WIDTH)).trimEnd();
}

export function formatIndianPayslip(input: IndianPayslipInput): string {
  const pf = monthlyEpf(input.basicWagesPaise);
  const esi = monthlyEsi(input.grossWagesPaise, input.esiCoverageWagesPaise);
  const epfRate = percent(EPF_RATE_PERCENT * 100);

  return [
    `Payslip: ${input.employeeName}, ${input.period}`,
    "",
    row("Basic wages", money(input.basicWagesPaise), ""),
    row("Gross wages", money(input.grossWagesPaise), ""),
    "",
    row("", "You pay", "Employer pays"),
    row("Provident Fund (EPF)", money(pf.employee), money(pf.employerEpf)),
    `  ${epfRate} of basic wages up to ${ceiling(EPF_WAGE_CEILING_PAISE)} a month, from you and from your employer;` +
      ` the employer's ${epfRate} less the pension share goes here.`,
    row("Pension (EPS)", NONE, money(pf.employerEps)),
    `  ${percent(EPS_RATE_BASIS_POINTS)} of basic wages up to ${ceiling(EPF_WAGE_CEILING_PAISE)} a month,` +
      ` taken from the employer's ${epfRate}; nothing is deducted from your pay for it.`,
    row("Employees' State Insurance", esi.covered ? money(esi.employee) : NONE, esi.covered ? money(esi.employer) : NONE),
    `  Applies if gross wages were ${ceiling(ESI_WAGE_CEILING_PAISE)} a month or less when the contribution period began,` +
      ` until it ends: ${percent(ESI_EMPLOYEE_RATE_BASIS_POINTS)} of gross wages from you,` +
      ` ${percent(ESI_EMPLOYER_RATE_BASIS_POINTS)} from your employer.`,
  ].join("\n");
}

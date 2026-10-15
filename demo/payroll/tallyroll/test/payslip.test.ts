import { describe, expect, it } from "vitest";
import { formatIndianPayslip } from "../src/in/payslip.ts";

const rupees = (r: number) => Math.round(r * 100);

/** The line starting with `label`, and the note printed under it. */
function lineAndNote(slip: string, label: string): [string, string] {
  const lines = slip.split("\n");
  const i = lines.findIndex((l) => l.startsWith(label));
  expect(i, `no line for ${label}`).toBeGreaterThanOrEqual(0);
  return [lines[i], lines[i + 1]];
}

describe("formatIndianPayslip", () => {
  // Basic ₹12,000, gross ₹18,000: PF ₹1,440 each side, of which EPS ₹999.60 → ₹1,000;
  // ESI ₹135 and ₹585.
  const asha = formatIndianPayslip({
    employeeName: "Asha Rao",
    period: "October 2026",
    basicWagesPaise: rupees(12_000),
    grossWagesPaise: rupees(18_000),
  });

  it("heads the payslip with the employee, the month and the wages", () => {
    const lines = asha.split("\n");
    expect(lines[0]).toBe("Payslip: Asha Rao, October 2026");
    expect(lines[2]).toMatch(/^Basic wages +₹12,000\.00$/);
    expect(lines[3]).toMatch(/^Gross wages +₹18,000\.00$/);
  });

  it("shows the PF, pension and ESI lines with the employee and employer amounts", () => {
    expect(lineAndNote(asha, "Provident Fund (EPF)")[0]).toMatch(/ ₹1,440\.00 +₹440\.00$/);
    expect(lineAndNote(asha, "Pension (EPS)")[0]).toMatch(/ — +₹1,000\.00$/);
    expect(lineAndNote(asha, "Employees' State Insurance")[0]).toMatch(/ ₹135\.00 +₹585\.00$/);
  });

  it("aligns the amounts in two columns", () => {
    const rows = ["You pay", "Provident Fund (EPF)", "Pension (EPS)", "Employees' State Insurance"].map(
      (label) => asha.split("\n").find((l) => l.trimStart().startsWith(label))!,
    );
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });

  it("puts a note under each line saying when it applies", () => {
    expect(lineAndNote(asha, "Provident Fund (EPF)")[1]).toBe(
      "  12% of basic wages up to ₹15,000 a month, from you and from your employer;" +
        " the employer's 12% less the pension share goes here.",
    );
    expect(lineAndNote(asha, "Pension (EPS)")[1]).toBe(
      "  8.33% of basic wages up to ₹15,000 a month, taken from the employer's 12%;" +
        " nothing is deducted from your pay for it.",
    );
    expect(lineAndNote(asha, "Employees' State Insurance")[1]).toBe(
      "  Applies if gross wages were ₹21,000 a month or less when the contribution period began," +
        " until it ends: 0.75% of gross wages from you, 3.25% from your employer.",
    );
  });

  it("shows no ESI for an employee above the ceiling, but keeps the note", () => {
    const slip = formatIndianPayslip({
      employeeName: "Ben Iyer",
      period: "October 2026",
      basicWagesPaise: rupees(40_000),
      grossWagesPaise: rupees(60_000),
    });
    const [line, note] = lineAndNote(slip, "Employees' State Insurance");
    expect(line).toMatch(/ — +—$/);
    expect(note).toMatch(/^  Applies if gross wages were ₹21,000/);
    // PF is worked out on the ₹15,000 ceiling, not the full basic.
    expect(lineAndNote(slip, "Provident Fund (EPF)")[0]).toMatch(/ ₹1,800\.00 +₹550\.00$/);
    expect(lineAndNote(slip, "Pension (EPS)")[0]).toMatch(/ — +₹1,250\.00$/);
  });

  it("keeps deducting ESI after a raise above the ceiling mid-period", () => {
    const slip = formatIndianPayslip({
      employeeName: "Asha Rao",
      period: "November 2026",
      basicWagesPaise: rupees(15_000),
      grossWagesPaise: rupees(25_000),
      esiCoverageWagesPaise: rupees(20_000),
    });
    expect(lineAndNote(slip, "Employees' State Insurance")[0]).toMatch(/ ₹188\.00 +₹813\.00$/);
  });
});

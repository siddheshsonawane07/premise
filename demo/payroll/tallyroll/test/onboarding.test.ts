import { describe, expect, it } from "vitest";
import { onboardingCoverage } from "../src/hr/onboarding.ts";

const rupees = (r: number) => Math.round(r * 100);
const dollars = (d: number) => Math.round(d * 100);

const indian = (basic: number, gross: number) =>
  onboardingCoverage({ country: "IN", basicWagesPaise: basic, grossWagesPaise: gross });
const us = (annual: number) => onboardingCoverage({ country: "US", annualSalaryCents: annual });

describe("onboardingCoverage for an Indian hire", () => {
  it("makes PF mandatory and covers ESI for a low-paid hire", () => {
    const c = indian(rupees(10_000), rupees(18_000));
    expect(c.pf).toBe("mandatory");
    expect(c.esi).toBe(true);
    expect(c.notes).toEqual([
      "PF: mandatory. Basic wages are ₹15,000 a month or less.",
      "ESI: covered. Gross wages are ₹21,000 a month or less.",
    ]);
  });

  it("keeps PF mandatory at basic wages of exactly ₹15,000", () => {
    expect(indian(rupees(15_000), rupees(30_000)).pf).toBe("mandatory");
  });

  it("makes PF optional a paisa over ₹15,000, and says a continuing member stays in", () => {
    const c = indian(rupees(15_000) + 1, rupees(30_000));
    expect(c.pf).toBe("optional");
    expect(c.notes[0]).toContain("may decline PF at joining");
    expect(c.notes[0]).toContain("already a PF member");
  });

  it("covers ESI at gross wages of exactly ₹21,000 and not a paisa over", () => {
    expect(indian(rupees(12_000), rupees(21_000)).esi).toBe(true);
    const c = indian(rupees(12_000), rupees(21_000) + 1);
    expect(c.esi).toBe(false);
    expect(c.notes[1]).toBe("ESI: not covered. Gross wages are above ₹21,000 a month.");
  });

  it("decides PF on basic wages and ESI on gross wages", () => {
    // Basic under the PF ceiling, gross over the ESI ceiling.
    const c = indian(rupees(14_000), rupees(40_000));
    expect(c.pf).toBe("mandatory");
    expect(c.esi).toBe(false);
  });

  it("rejects wages that are not a non-negative integer of paise", () => {
    expect(() => indian(-1, rupees(10_000))).toThrow(RangeError);
    expect(() => indian(rupees(10_000), 100.5)).toThrow(RangeError);
  });
});

describe("onboardingCoverage for a US hire", () => {
  it("allows an exemption at exactly $684 a week ($35,568 a year)", () => {
    const c = us(dollars(35_568));
    expect(c.canBeExempt).toBe(true);
    expect(c.notes).toEqual([
      "Overtime: the salary meets the federal level of $684.00 a week ($35,568.00 a year), so the role can be exempt —" +
        " only if it also passes the salary basis and duties tests, and any state test.",
    ]);
  });

  it("does not allow an exemption a cent below $35,568 a year, and says what overtime is owed", () => {
    const c = us(dollars(35_568) - 1);
    expect(c.canBeExempt).toBe(false);
    expect(c.notes).toEqual([
      "Overtime: the salary is below the federal level of $684.00 a week ($35,568.00 a year), so the role cannot be exempt." +
        " Pay overtime at 150% of the regular rate for hours beyond 40 in a workweek.",
    ]);
  });

  it("allows an exemption well above the level and not at zero", () => {
    expect(us(dollars(120_000)).canBeExempt).toBe(true);
    expect(us(0).canBeExempt).toBe(false);
  });

  it("rejects a salary that is not a non-negative integer of cents", () => {
    expect(() => us(-1)).toThrow(RangeError);
    expect(() => us(3_556_800.5)).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import { monthlyEpf } from "../src/in/epf.ts";

const rupees = (r: number) => Math.round(r * 100);

describe("monthlyEpf", () => {
  it("splits contributions on wages below the ceiling", () => {
    // ₹10,000: employee 12% = ₹1,200; EPS 8.33% = ₹833; employer EPF = ₹367.
    expect(monthlyEpf(rupees(10_000))).toEqual({
      wagesConsidered: rupees(10_000),
      employee: rupees(1_200),
      employerEpf: rupees(367),
      employerEps: rupees(833),
    });
  });

  it("computes on the ceiling exactly at ₹15,000", () => {
    // EPS on ₹15,000 is ₹1,249.50, which rounds up to ₹1,250.
    expect(monthlyEpf(rupees(15_000))).toEqual({
      wagesConsidered: rupees(15_000),
      employee: rupees(1_800),
      employerEpf: rupees(550),
      employerEps: rupees(1_250),
    });
  });

  it("caps wages above the ceiling", () => {
    expect(monthlyEpf(rupees(50_000))).toEqual(monthlyEpf(rupees(15_000)));
  });

  it("rounds each contribution to the nearest rupee", () => {
    // ₹12,345.67: employee ₹1,481.48 → ₹1,481; EPS ₹1,028.39 → ₹1,028.
    const c = monthlyEpf(1_234_567);
    expect(c.employee).toBe(rupees(1_481));
    expect(c.employerEps).toBe(rupees(1_028));
    expect(c.employerEpf).toBe(rupees(453));
  });

  it("employer EPF and EPS together always equal the employee share", () => {
    for (const wages of [0, 1, 4_999, 600_050, 1_499_999, 1_500_001, 9_999_999]) {
      const c = monthlyEpf(wages);
      expect(c.employerEpf + c.employerEps).toBe(c.employee);
      expect(c.employee % 100).toBe(0);
    }
  });

  it("returns zero for zero wages", () => {
    expect(monthlyEpf(0)).toEqual({ wagesConsidered: 0, employee: 0, employerEpf: 0, employerEps: 0 });
  });

  it("rejects wages that are not a non-negative integer of paise", () => {
    expect(() => monthlyEpf(-1)).toThrow(RangeError);
    expect(() => monthlyEpf(100.5)).toThrow(RangeError);
  });
});

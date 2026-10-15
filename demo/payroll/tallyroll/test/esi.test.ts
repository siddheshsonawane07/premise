import { describe, expect, it } from "vitest";
import { monthlyEsi } from "../src/in/esi.ts";

const rupees = (r: number) => Math.round(r * 100);

describe("monthlyEsi", () => {
  it("takes 0.75% from the employee and 3.25% from the employer", () => {
    expect(monthlyEsi(rupees(18_000))).toEqual({ covered: true, employee: rupees(135), employer: rupees(585) });
  });

  it("covers wages of exactly ₹21,000", () => {
    // ₹157.50 and ₹682.50 both round up.
    expect(monthlyEsi(rupees(21_000))).toEqual({ covered: true, employee: rupees(158), employer: rupees(683) });
  });

  it("does not cover wages a paisa over ₹21,000", () => {
    expect(monthlyEsi(rupees(21_000) + 1)).toEqual({ covered: false, employee: 0, employer: 0 });
  });

  it("rounds any fraction of a rupee up, unlike EPF", () => {
    // ₹10,001: employee ₹75.0075 → ₹76; employer ₹325.0325 → ₹326.
    expect(monthlyEsi(rupees(10_001))).toEqual({ covered: true, employee: rupees(76), employer: rupees(326) });
  });

  it("keeps contributing on full wages after a raise above the ceiling mid-period", () => {
    // Covered on ₹20,000 at the start of the period; now earning ₹25,000.
    expect(monthlyEsi(rupees(25_000), rupees(20_000))).toEqual({
      covered: true,
      employee: rupees(188),
      employer: rupees(813),
    });
  });

  it("stays out for the period when wages at its start were above the ceiling", () => {
    expect(monthlyEsi(rupees(15_000), rupees(22_000))).toEqual({ covered: false, employee: 0, employer: 0 });
  });

  it("returns zero contributions for zero wages", () => {
    expect(monthlyEsi(0)).toEqual({ covered: true, employee: 0, employer: 0 });
  });

  it("rejects wages that are not a non-negative integer of paise", () => {
    expect(() => monthlyEsi(-1)).toThrow(RangeError);
    expect(() => monthlyEsi(100.5)).toThrow(RangeError);
    expect(() => monthlyEsi(100, -1)).toThrow(RangeError);
  });
});

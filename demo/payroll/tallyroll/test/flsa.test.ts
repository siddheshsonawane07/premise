import { describe, expect, it } from "vitest";
import { meetsSalaryLevel, weeklyGross } from "../src/us/flsa.ts";

const dollars = (d: number) => Math.round(d * 100);
const hours = (h: number) => Math.round(h * 60);

describe("meetsSalaryLevel", () => {
  it("passes at exactly $684 a week", () => {
    expect(meetsSalaryLevel(dollars(684))).toBe(true);
  });

  it("fails one cent below $684", () => {
    expect(meetsSalaryLevel(dollars(684) - 1)).toBe(false);
  });

  it("passes well above the level and fails at zero", () => {
    expect(meetsSalaryLevel(dollars(1_500))).toBe(true);
    expect(meetsSalaryLevel(0)).toBe(false);
  });

  it("rejects a salary that is not a non-negative integer of cents", () => {
    expect(() => meetsSalaryLevel(-1)).toThrow(RangeError);
    expect(() => meetsSalaryLevel(68_400.5)).toThrow(RangeError);
  });
});

describe("weeklyGross", () => {
  it("pays no overtime at exactly 40 hours", () => {
    expect(weeklyGross(dollars(20), hours(40))).toEqual({
      regularMinutes: hours(40),
      overtimeMinutes: 0,
      regularPay: dollars(800),
      overtimePay: 0,
      gross: dollars(800),
    });
  });

  it("pays hours beyond 40 at time and a half", () => {
    // 45 h at $20: 40 × $20 = $800, plus 5 × $30 = $150.
    expect(weeklyGross(dollars(20), hours(45))).toEqual({
      regularMinutes: hours(40),
      overtimeMinutes: hours(5),
      regularPay: dollars(800),
      overtimePay: dollars(150),
      gross: dollars(950),
    });
  });

  it("pays a short week at the straight rate", () => {
    const p = weeklyGross(dollars(18.5), hours(25));
    expect(p.overtimeMinutes).toBe(0);
    expect(p.gross).toBe(dollars(462.5));
  });

  it("rounds each line to the nearest cent", () => {
    // 41.5 h at $15.55: overtime 1.5 × $23.325 = $34.9875 → $34.99.
    const p = weeklyGross(dollars(15.55), hours(41.5));
    expect(p.regularPay).toBe(dollars(622));
    expect(p.overtimePay).toBe(dollars(34.99));
    expect(p.gross).toBe(dollars(656.99));
  });

  it("rounds half a cent up", () => {
    expect(weeklyGross(1, 30).gross).toBe(1);
    expect(weeklyGross(1, 29).gross).toBe(0);
  });

  it("returns zero for no hours worked", () => {
    expect(weeklyGross(dollars(20), 0)).toEqual({
      regularMinutes: 0,
      overtimeMinutes: 0,
      regularPay: 0,
      overtimePay: 0,
      gross: 0,
    });
  });

  it("rejects a rate or time that is not a non-negative integer", () => {
    expect(() => weeklyGross(-1, hours(40))).toThrow(RangeError);
    expect(() => weeklyGross(2_000.5, hours(40))).toThrow(RangeError);
    expect(() => weeklyGross(dollars(20), -1)).toThrow(RangeError);
    expect(() => weeklyGross(dollars(20), 2_400.5)).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import { monthlyComplianceCsv, type Employee } from "../src/reports/compliance.ts";

const rupees = (r: number) => Math.round(r * 100);
const dollars = (d: number) => Math.round(d * 100);

const indian = (basic: number, gross: number, esiCoverage?: number): Employee => ({
  country: "IN",
  basicWagesPaise: basic,
  grossWagesPaise: gross,
  esiCoverageWagesPaise: esiCoverage,
});
const us = (annual: number): Employee => ({ country: "US", annualSalaryCents: annual });

/** The counts from each data row, keyed by "country measure". */
function counts(csv: string): Record<string, [number, number]> {
  const [, ...rows] = csv.trimEnd().split("\n");
  return Object.fromEntries(
    rows.map((r) => {
      const [, country, measure, count, outOf] = r.split(",");
      return [`${country} ${measure}`, [Number(count), Number(outOf)]];
    }),
  );
}

describe("monthlyComplianceCsv", () => {
  it("counts PF, ESI and the FLSA salary level across both countries", () => {
    const csv = monthlyComplianceCsv("2026-10", [
      indian(rupees(10_000), rupees(18_000)), // PF and ESI
      indian(rupees(14_000), rupees(40_000)), // PF only
      indian(rupees(50_000), rupees(90_000)), // neither
      us(dollars(120_000)),
      us(dollars(30_000)),
    ]);
    expect(csv).toBe(
      "period,country,measure,count,out_of\n" +
        "2026-10,IN,PF mandatory,2,3\n" +
        "2026-10,IN,ESI covered,1,3\n" +
        "2026-10,US,Salary meets FLSA exemption level,1,2\n",
    );
  });

  it("counts PF at basic wages of exactly ₹15,000 and not a paisa over", () => {
    const c = counts(monthlyComplianceCsv("2026-10", [
      indian(rupees(15_000), rupees(30_000)),
      indian(rupees(15_000) + 1, rupees(30_000)),
    ]));
    expect(c["IN PF mandatory"]).toEqual([1, 2]);
  });

  it("counts ESI at gross wages of exactly ₹21,000 and not a paisa over", () => {
    const c = counts(monthlyComplianceCsv("2026-10", [
      indian(rupees(12_000), rupees(21_000)),
      indian(rupees(12_000), rupees(21_000) + 1),
    ]));
    expect(c["IN ESI covered"]).toEqual([1, 2]);
  });

  it("decides ESI on the wages at the start of the contribution period", () => {
    const c = counts(monthlyComplianceCsv("2026-10", [
      indian(rupees(12_000), rupees(25_000), rupees(20_000)), // raised mid-period: still covered
      indian(rupees(12_000), rupees(15_000), rupees(22_000)), // over at the start: out all period
    ]));
    expect(c["IN ESI covered"]).toEqual([1, 2]);
  });

  it("counts the FLSA level at exactly $35,568 a year and not a cent below", () => {
    const c = counts(monthlyComplianceCsv("2026-10", [us(dollars(35_568)), us(dollars(35_568) - 1)]));
    expect(c["US Salary meets FLSA exemption level"]).toEqual([1, 2]);
  });

  it("reports zeros for an empty list and for a country with no employees", () => {
    expect(counts(monthlyComplianceCsv("2026-10", []))).toEqual({
      "IN PF mandatory": [0, 0],
      "IN ESI covered": [0, 0],
      "US Salary meets FLSA exemption level": [0, 0],
    });
    expect(counts(monthlyComplianceCsv("2026-10", [us(dollars(50_000))]))["IN PF mandatory"]).toEqual([0, 0]);
  });

  it("quotes a period that contains a comma or a quote", () => {
    const csv = monthlyComplianceCsv('October, "2026"', []);
    expect(csv.split("\n")[1]).toBe('"October, ""2026""",IN,PF mandatory,0,0');
  });

  it("rejects wages or salary that are not a non-negative integer", () => {
    expect(() => monthlyComplianceCsv("2026-10", [indian(-1, rupees(10_000))])).toThrow(RangeError);
    expect(() => monthlyComplianceCsv("2026-10", [indian(rupees(10_000), rupees(10_000), 100.5)])).toThrow(RangeError);
    expect(() => monthlyComplianceCsv("2026-10", [us(-1)])).toThrow(RangeError);
  });
});

// FLSA overtime exemption and weekly overtime. All amounts are in cents. Federal rules only.

// Premise us-flsa-salary@1 (final): $684 a week.
export const FLSA_SALARY_LEVEL_CENTS = 68_400;
// Premise us-flsa-ot-hours@1 (draft): overtime for hours beyond 40 in a workweek.
export const OVERTIME_THRESHOLD_HOURS = 40;
// Premise us-flsa-ot-rate@1 (draft): overtime at 150% of the regular rate.
export const OVERTIME_RATE_PERCENT = 150;

function requireNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
  }
}

/**
 * The salary level test: a salaried employee can be exempt from overtime only if paid at least
 * the salary level each week. Passing it is necessary, not sufficient — the salary basis and
 * duties tests are not checked here.
 */
export function meetsSalaryLevel(weeklySalaryCents: number): boolean {
  requireNonNegativeInteger(weeklySalaryCents, "weekly salary in cents");
  return weeklySalaryCents >= FLSA_SALARY_LEVEL_CENTS;
}

export interface WeeklyPay {
  regularMinutes: number;
  overtimeMinutes: number;
  regularPay: number;
  overtimePay: number;
  gross: number;
}

/** rateCents × minutes / 60 × percent / 100, rounded half-up to the cent, in integer arithmetic. */
function pay(hourlyRateCents: number, minutes: number, percent: number): number {
  const scale = 60 * 100;
  return Math.floor((hourlyRateCents * minutes * percent + scale / 2) / scale);
}

/** Weekly gross pay for a non-exempt employee paid by the hour. Time is in whole minutes. */
export function weeklyGross(hourlyRateCents: number, minutesWorked: number): WeeklyPay {
  requireNonNegativeInteger(hourlyRateCents, "hourly rate in cents");
  requireNonNegativeInteger(minutesWorked, "minutes worked");
  const regularMinutes = Math.min(minutesWorked, OVERTIME_THRESHOLD_HOURS * 60);
  const overtimeMinutes = minutesWorked - regularMinutes;
  const regularPay = pay(hourlyRateCents, regularMinutes, 100);
  const overtimePay = pay(hourlyRateCents, overtimeMinutes, OVERTIME_RATE_PERCENT);
  return { regularMinutes, overtimeMinutes, regularPay, overtimePay, gross: regularPay + overtimePay };
}

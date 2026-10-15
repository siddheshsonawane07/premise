import { describe, expect, it } from 'vitest';
import { checkCashIntake } from '../src/core/cash-intake.ts';

describe('checkCashIntake, IN (₹50,000 a month, paise)', () => {
  it('allows cash that lands exactly on the limit', () => {
    expect(checkCashIntake('IN', 500_00, 49_500_00)).toEqual({ allowed: true, reportable: false });
  });

  it('refuses cash that would go one paisa over the limit', () => {
    expect(checkCashIntake('IN', 500_01, 49_500_00)).toEqual({ allowed: false, reportable: false });
  });

  it('refuses any cash once the limit is reached', () => {
    expect(checkCashIntake('IN', 1, 50_000_00).allowed).toBe(false);
  });
});

describe('checkCashIntake, US (more than $10,000 a business day, cents)', () => {
  it('is not reportable at exactly $10,000', () => {
    expect(checkCashIntake('US', 4_000_00, 6_000_00)).toEqual({ allowed: true, reportable: false });
  });

  it('is reportable one cent over $10,000', () => {
    expect(checkCashIntake('US', 4_000_01, 6_000_00)).toEqual({ allowed: true, reportable: true });
  });

  it('always allows, however large', () => {
    expect(checkCashIntake('US', 1_000_000_00, 0)).toEqual({ allowed: true, reportable: true });
  });
});

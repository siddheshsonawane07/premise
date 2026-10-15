import { describe, expect, it } from 'vitest';
import { shouldAlert } from '../src/admin/monthly-compliance.ts';

describe('shouldAlert', () => {
  it('stays quiet well under 80% of the ₹50,000 limit', () => {
    expect(shouldAlert(10_000_00)).toBe(false);
  });

  it('stays quiet at exactly 80% (₹40,000)', () => {
    expect(shouldAlert(40_000_00)).toBe(false);
  });

  it('alerts one paisa above 80%', () => {
    expect(shouldAlert(40_000_01)).toBe(true);
  });

  it('alerts at the full limit', () => {
    expect(shouldAlert(50_000_00)).toBe(true);
  });
});

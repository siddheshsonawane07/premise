import { describe, expect, it } from 'vitest';
import { needsCtr } from '../src/markets/us/ctr-report.ts';

describe('needsCtr (more than $10,000 a business day, cents)', () => {
  it('is not needed well under $10,000', () => {
    expect(needsCtr(500_00)).toBe(false);
  });

  it('is not needed at exactly $10,000', () => {
    expect(needsCtr(10_000_00)).toBe(false);
  });

  it('is needed one cent over $10,000', () => {
    expect(needsCtr(10_000_01)).toBe(true);
  });
});

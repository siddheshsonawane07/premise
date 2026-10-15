import { describe, expect, it } from 'vitest';
import { digest } from '../src/admin/weekly-digest.ts';

describe('digest (more than 80% of the ₹50,000 monthly limit, paise)', () => {
  it('returns nobody for an empty list', () => {
    expect(digest([])).toEqual([]);
  });

  it('lists only customers past ₹40,000, in input order', () => {
    expect(
      digest([
        { id: 'under', cashLoadedThisMonthPaise: 10_000_00 },
        { id: 'at', cashLoadedThisMonthPaise: 40_000_00 },
        { id: 'just-over', cashLoadedThisMonthPaise: 40_000_01 },
        { id: 'at-limit', cashLoadedThisMonthPaise: 50_000_00 },
      ]),
    ).toEqual(['just-over', 'at-limit']);
  });
});

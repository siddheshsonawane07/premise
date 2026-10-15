import { describe, expect, it } from 'vitest';
import {
  FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE,
  canTopUp,
  receiptBody,
  receiptSubject,
} from '../src/wallet/index.ts';

describe('monthly cash-loading limit', () => {
  it('is ₹50,000 in paise (Premise rule in-cash-load v1)', () => {
    expect(FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE).toBe(50_000_00);
  });
});

describe('canTopUp', () => {
  const limit = FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE;

  it('allows a top-up well under the limit', () => {
    expect(canTopUp(0, 1_000_00)).toBe(true);
  });

  it('allows a top-up that lands exactly on the limit', () => {
    expect(canTopUp(limit - 500_00, 500_00)).toBe(true);
  });

  it('refuses a top-up that would go one paisa over the limit', () => {
    expect(canTopUp(limit - 500_00, 500_01)).toBe(false);
  });

  it('refuses any top-up once the limit is reached', () => {
    expect(canTopUp(limit, 1)).toBe(false);
  });
});

describe('receipt email', () => {
  it('puts the formatted rupee amount in the subject', () => {
    expect(receiptSubject(1_234_50)).toBe('Your Tilldesk wallet was topped up with ₹1,234.50');
  });

  it('uses Indian digit grouping in the body', () => {
    expect(receiptBody(1_50_000_00)).toContain('₹1,50,000.00');
  });
});

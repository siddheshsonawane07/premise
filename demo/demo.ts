import type { NewRule } from '../src/core/rules.ts';

// The Tilldesk demo, as data. Tilldesk is an invented wallet company; the people are invented.
// Rule figures are public and cited; every figure is re-checked against the regulator's own
// text before the video (PRODUCT_FINAL §13).

type Seed = { recordedBy: 'chitra'; rule: Omit<NewRule, 'owner'> };

export const DEMO = {
  teamName: 'Tilldesk',
  repo: { id: 'tilldesk', name: 'Tilldesk' },
  members: [
    { id: 'asha', name: 'Asha', role: 'developer' as const },
    { id: 'ben', name: 'Ben', role: 'developer' as const },
    { id: 'chitra', name: 'Chitra', role: 'compliance' as const },
  ],
  jurisdictions: [
    { code: 'IN', name: 'India', regulator: 'Reserve Bank of India' },
    { code: 'US', name: 'United States', regulator: 'FinCEN' },
  ],
  serves: [
    { path: 'src/wallet', code: 'IN' },
    { path: 'src/admin', code: 'IN' },
    { path: 'src/markets/us', code: 'US' },
    { path: 'src/core', code: 'IN' },
    { path: 'src/core', code: 'US' },
  ],
  rules: [
    {
      recordedBy: 'chitra',
      rule: {
        id: 'in-cash-load',
        title: 'Full-KYC wallet cash loading, per month',
        type: 'regulation',
        risk: 'high',
        jurisdiction: 'IN',
        text: 'Cash loaded into a full-KYC prepaid wallet is capped at ₹50,000 a month.',
        figure: 50_000_00,
        unit: 'paise',
        citation: 'RBI Master Direction on Prepaid Payment Instruments, 2021',
        effectiveFrom: '2021-08-27',
        status: 'final',
        scope: ['src/wallet'],
      },
    },
    {
      recordedBy: 'chitra',
      rule: {
        id: 'us-ctr',
        title: 'Currency transaction report threshold',
        type: 'regulation',
        risk: 'high',
        jurisdiction: 'US',
        text: 'Cash transactions of more than $10,000 in one business day are reported to FinCEN.',
        figure: 10_000_00,
        unit: 'cents',
        citation: '31 CFR 1010.311 (Bank Secrecy Act)',
        effectiveFrom: '2011-03-01',
        status: 'final',
        scope: ['src/markets/us'],
      },
    },
  ] satisfies Seed[],
};

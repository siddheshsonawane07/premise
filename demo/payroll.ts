import type { DEMO } from './demo.ts';

// The second test (demo/payroll/PROTOCOL.md). Tallyroll is an invented payroll company with
// invented people; the rules are real and public. The India EPF wage ceiling of ₹15,000 is the one
// that changes: the Union Cabinet approved ₹25,000 on 2026-09-16, notification pending.

export const PAYROLL: typeof DEMO = {
  teamName: 'Tallyroll',
  repo: { id: 'tallyroll', name: 'Tallyroll' },
  members: [
    { id: 'asha', name: 'Asha', role: 'developer' },
    { id: 'ben', name: 'Ben', role: 'developer' },
    { id: 'chitra', name: 'Chitra', role: 'compliance' },
  ],
  jurisdictions: [
    { code: 'IN', name: 'India', regulator: 'EPFO and ESIC' },
    { code: 'US', name: 'United States', regulator: 'US Department of Labor' },
  ],
  serves: [
    { path: 'src/in', code: 'IN' },
    { path: 'src/us', code: 'US' },
    { path: 'src/hr', code: 'IN' },
    { path: 'src/hr', code: 'US' },
    { path: 'src/reports', code: 'IN' },
    { path: 'src/reports', code: 'US' },
  ],
  rules: [
    {
      recordedBy: 'chitra',
      rule: {
        id: 'in-epf-ceiling',
        title: 'EPF and EPS wage ceiling, per month',
        type: 'regulation',
        risk: 'high',
        jurisdiction: 'IN',
        text: 'Mandatory EPF membership and EPF/EPS contributions are based on basic wages up to ₹15,000 a month.',
        figure: 15_000_00,
        unit: 'paise',
        citation: "Employees' Provident Funds Scheme, 1952, as amended with effect from 2014-09-01",
        effectiveFrom: '2014-09-01',
        status: 'final',
        scope: ['src/in'],
      },
    },
    {
      recordedBy: 'chitra',
      rule: {
        id: 'in-esi-ceiling',
        title: 'ESI coverage wage ceiling, per month',
        type: 'regulation',
        risk: 'high',
        jurisdiction: 'IN',
        text: 'Employees earning up to ₹21,000 a month in gross wages are covered by ESI.',
        figure: 21_000_00,
        unit: 'paise',
        citation: 'Employees\' State Insurance (Central) Rules, as amended with effect from 2017-01-01',
        effectiveFrom: '2017-01-01',
        status: 'final',
        scope: ['src/in'],
      },
    },
    {
      recordedBy: 'chitra',
      rule: {
        id: 'us-flsa-salary',
        title: 'FLSA white-collar exemption salary level, per week',
        type: 'regulation',
        risk: 'high',
        jurisdiction: 'US',
        text: 'A salaried employee can be exempt from overtime only if paid at least $684 a week.',
        figure: 684_00,
        unit: 'cents',
        citation: '29 CFR 541.600 (the 2024 rule raising it was vacated, Texas v. DOL, 2024-11-15)',
        effectiveFrom: '2020-01-01',
        status: 'final',
        scope: ['src/us'],
      },
    },
  ],
};

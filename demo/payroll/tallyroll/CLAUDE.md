# Tallyroll

An invented payroll service for employers in India and the US. Synthetic demo data only.

- TypeScript, Node 22, tests with vitest (`npm test`).
- Money is an integer in the smallest unit: paise for INR, cents for USD.
- Indian payroll code lives in `src/in/`, US payroll in `src/us/`, HR tools for both countries in
  `src/hr/`, reports in `src/reports/`. Tests go in `test/`.

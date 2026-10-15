# Tilldesk

An invented prepaid wallet service operating in India and the US. Synthetic demo data only.

- TypeScript, Node 22, tests with vitest (`npm test`).
- **Money is always an integer in the smallest unit**: paise for INR, cents for USD. Write
  ₹50,000 as `50_000_00`.
- Indian wallet code lives in `src/wallet/`, admin and reporting in `src/admin/`, US-only code
  in `src/markets/us/`, code shared by both markets in `src/core/`.

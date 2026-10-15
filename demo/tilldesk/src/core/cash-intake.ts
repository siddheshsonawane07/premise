// Premise rule in-cash-load v1: RBI Master Direction on Prepaid Payment Instruments, 2021.
// Cash loaded into a full-KYC wallet is capped at ₹50,000 a month.
const IN_FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE = 50_000_00;

// Premise rule us-ctr v1: 31 CFR 1010.311 (Bank Secrecy Act).
// Cash transactions of more than $10,000 in one business day are reported to FinCEN.
const US_CTR_THRESHOLD_CENTS = 10_000_00;

export function checkCashIntake(
  market: 'IN' | 'US',
  amountMinor: number,
  alreadyThisPeriodMinor: number,
): { allowed: boolean; reportable: boolean } {
  const total = alreadyThisPeriodMinor + amountMinor;
  if (market === 'IN') {
    return { allowed: total <= IN_FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE, reportable: false };
  }
  return { allowed: true, reportable: total > US_CTR_THRESHOLD_CENTS };
}

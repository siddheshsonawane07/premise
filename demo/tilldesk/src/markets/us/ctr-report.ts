// Premise rule us-ctr v1: 31 CFR 1010.311 (Bank Secrecy Act).
// Cash transactions of more than $10,000 in one business day are reported to FinCEN.
const US_CTR_THRESHOLD_CENTS = 10_000_00;

export function needsCtr(cashInBusinessDayCents: number): boolean {
  return cashInBusinessDayCents > US_CTR_THRESHOLD_CENTS;
}

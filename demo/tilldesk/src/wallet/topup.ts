import { FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE } from './limits.ts';

export function canTopUp(loadedThisMonthPaise: number, amountPaise: number): boolean {
  return loadedThisMonthPaise + amountPaise <= FULL_KYC_MONTHLY_CASH_LOAD_LIMIT_PAISE;
}

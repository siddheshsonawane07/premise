export function shouldAlert(cashLoadedThisMonthPaise: number): boolean {
  return cashLoadedThisMonthPaise > 40_000_00;
}

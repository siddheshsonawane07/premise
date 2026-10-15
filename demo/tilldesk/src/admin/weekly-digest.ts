export function digest(customers: { id: string; cashLoadedThisMonthPaise: number }[]): string[] {
  return customers.filter((c) => c.cashLoadedThisMonthPaise > 40_000_00).map((c) => c.id);
}

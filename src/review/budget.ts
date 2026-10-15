import { type Db, one, run } from '../db/client.ts';
import { CONTROL } from '../db/queries.ts';

// The Reviewer's daily spend cap, counted in `_control` (STRICT §6: a spend cap on the key and
// in the app). Prices for claude-haiku-5-5: $0.10 per million input tokens, $0.50 per million
// output, i.e. 0.1 and 0.5 micro-dollars per token.

const IN_MICRO = 0.1;
const OUT_MICRO = 0.5;

export class Budget {
  constructor(private readonly db: Db, private readonly capUsd: number) {}

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async exhausted(): Promise<boolean> {
    const row = await one<{ spent: number }>(this.db.control(), CONTROL.budgetSpent, { day: this.day() }, { readOnly: true });
    return (row?.spent ?? 0) >= this.capUsd * 1_000_000;
  }

  async spend(inputTokens: number, outputTokens: number): Promise<void> {
    const micro = Math.ceil(inputTokens * IN_MICRO + outputTokens * OUT_MICRO);
    await run(this.db.control(), CONTROL.budgetSpend, { day: this.day(), micro });
  }
}

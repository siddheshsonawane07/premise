import { type Db, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { noReviewer, type Review, runPropagation } from '../core/change.ts';

// Propagations run in the background, one at a time, in this process. Their state lives in
// the graph (Propagation.status), so a restart re-queues anything not `done`: there is no job
// store outside FalkorDB.

export class PropagationQueue {
  private readonly pending: { teamId: string; id: string }[] = [];
  private running = false;
  private readonly waiters = new Map<string, (() => void)[]>();

  constructor(private readonly db: Db, private readonly review: Review = noReviewer) {}

  enqueue(teamId: string, id: string): void {
    this.pending.push({ teamId, id });
    void this.drain();
  }

  /** Resolves when the propagation is done, or after `ms`. */
  wait(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const list = this.waiters.get(id) ?? [];
      list.push(() => { clearTimeout(t); resolve(); });
      this.waiters.set(id, list);
    });
  }

  async resume(teamIds: string[]): Promise<void> {
    for (const teamId of teamIds) {
      const rows = await run<{ id: string }>(this.db.team(teamId), TEAM.unfinishedPropagations, {}, { readOnly: true });
      for (const r of rows) this.enqueue(teamId, r.id);
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift()!;
        try {
          await runPropagation(this.db, job.teamId, job.id, this.review);
        } catch (err) {
          console.error(`premise: propagation ${job.id} failed:`, err instanceof Error ? err.message : err);
          // Marked failed, so the receipt says so instead of "still checking" forever. Not retried at start-up.
          await run(this.db.team(job.teamId), TEAM.setPropagationStatus, { id: job.id, status: 'failed' }).catch(() => {});
        }
        for (const done of this.waiters.get(job.id) ?? []) done();
        this.waiters.delete(job.id);
      }
    } finally {
      this.running = false;
    }
  }
}

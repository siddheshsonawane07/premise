import type { Principal } from '../auth.ts';
import { type Db, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';

export interface MyTask {
  taskId: string;
  status: string;
  due: string;
  tier: string;
  path: string;
  ruleId: string;
  title: string;
  oldFigure?: number;
  newFigure?: number;
  unit?: string;
  verdict?: string;
  verdictReason?: string;
}

export async function myTasks(db: Db, who: Principal): Promise<MyTask[]> {
  return run<MyTask>(db.team(who.teamId), TEAM.myTasks, { member: who.memberId }, { readOnly: true });
}

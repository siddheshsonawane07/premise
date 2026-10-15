import { z } from 'zod';

// Every environment variable Premise reads, checked once at start-up.
// A missing required value stops the process with the variable's name.
const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  FALKORDB_URL: z.string().default('falkor://localhost:6379'),
  FALKORDB_PASSWORD: z.string().default('premise-local'),
  ANTHROPIC_API_KEY: z.string().optional(),
  REVIEW_DAILY_CAP_USD: z.coerce.number().positive().default(1),
  DEMO_TEAM_ID: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).default('tilldesk'),
  DEMO_WEB_KEY: z.string().optional(),
  PREMISE_WEB_MEMBER: z.string().optional(),
  CAPTURE_DIR: z.string().optional(),
  // Live site: rebuild the demo team from the committed capture when it is missing, and every
  // N minutes if set (visitors' changes are wiped; the page says so).
  DEMO_SEED: z.enum(['on', 'off']).default('off'),
  DEMO_RESET_MINUTES: z.coerce.number().int().min(5).optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Bad or missing environment variables: ${names}`);
  }
  return parsed.data;
}

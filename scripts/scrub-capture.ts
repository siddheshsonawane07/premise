// Turns a raw capture (git-ignored) into the committed demo seed.
//
//   npx tsx scripts/scrub-capture.ts <raw.jsonl> <real-repo-root> demo/events/tilldesk.jsonl

import fs from 'node:fs';
import { type CapturedEvent, personalLeaks, scrubEvent } from '../src/replay/scrub.ts';

const [input, realRoot, output] = process.argv.slice(2);
if (!input || !realRoot || !output) {
  console.error('usage: scrub-capture.ts <raw.jsonl> <real-repo-root> <out.jsonl>');
  process.exit(1);
}
const events = fs.readFileSync(input, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CapturedEvent);
const kept = events.map((e) => scrubEvent(e, realRoot)).filter((e): e is CapturedEvent => Boolean(e));
const text = `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`;
const leaks = personalLeaks(text);
if (leaks.length) {
  console.error(`Refusing to write: still personal after scrubbing: ${leaks.join(', ')}`);
  process.exit(1);
}
fs.writeFileSync(output, text);
console.log(`${events.length} captured → ${kept.length} kept → ${output}`);

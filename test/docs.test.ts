import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../scripts/docs-queries.ts';

// STRICT 10: a change to a query updates the README in the same commit.
describe('query docs', () => {
  it('README.md and docs/QUERIES.md match src/db/queries.ts', () => {
    const { readme, queries } = render();
    expect(fs.readFileSync('README.md', 'utf8')).toBe(readme);
    expect(fs.readFileSync('docs/QUERIES.md', 'utf8')).toBe(queries);
  });
});

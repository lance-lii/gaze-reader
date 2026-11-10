/**
 * Line-tracker scoreboard: how often the tracker is on the reader's line, end to end, in every
 * scenario of bench/endtoend/world.ts (`npm run bench -- bench/reading/lineTracker`, ≈ 5 min).
 *
 *   GR_LT_SEEDS (default 1,2,3)  seeds; the tracker was tuned on 11–14, so 1–3 are fresh
 *   GR_LT_MINUTES (default 60)    length of each session
 *   GR_LT_ONLY=name|name          a subset of scenarios
 *   GR_LT_OUT=file.json           also write the rows
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../endtoend/world';
import { lineScoreTable, scoreLineTracker, type LineScore } from './lineScore';

// The project has no Node type definitions (it's a browser app); reach Node through narrow shapes.
const env = (name: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];
async function writeText(path: string, text: string): Promise<void> {
  const specifier: string = 'node:fs';
  const fs = (await import(/* @vite-ignore */ specifier)) as { writeFileSync(path: string, data: string): void };
  fs.writeFileSync(path, text);
}
const SEEDS = (env('GR_LT_SEEDS') ?? '1,2,3').split(',').map(Number).filter(Number.isFinite);
const MINUTES = Number(env('GR_LT_MINUTES') ?? 60);
const ONLY = env('GR_LT_ONLY')?.split('|').map((s) => s.trim()).filter(Boolean) ?? null;

describe('line tracker, end to end', () => {
  it('scores the tracker against the line the reader really fixated', async () => {
    const rows: LineScore[] = [];
    for (const s of SCENARIOS) {
      if (ONLY && !ONLY.includes(s.name)) continue;
      rows.push(scoreLineTracker(s, SEEDS, { minutes: MINUTES }));
    }
    console.log(`\n${lineScoreTable(rows)}\n`);
    const out = env('GR_LT_OUT');
    if (out) await writeText(out, `${JSON.stringify(rows, null, 2)}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

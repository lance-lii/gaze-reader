/**
 * End-to-end scoreboard: simulated hours of reading, from webcam landmarks to page turns, in every
 * scenario of world.ts (`npm run eval`). Prints a table, and with GR_EVAL_OUT=file.json writes the
 * per-scenario summaries for before/after comparisons.
 *
 *   GR_EVAL_SEEDS (default 3)   runs per scenario
 *   GR_EVAL_MINUTES (default 60) length of each run
 *   GR_EVAL_ONLY=name,name       a subset of scenarios
 *
 * The regression gates on a few of these numbers are in tests/endToEnd.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { runSession, summarize, summaryTable, type Summary } from './rig';
import { SCENARIOS, scenario } from './world';

// The project has no Node type definitions (it's a browser app); reach Node through narrow shapes.
const nodeProcess = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
const env = (name: string): string | undefined => nodeProcess?.env[name];
async function writeText(path: string, text: string): Promise<void> {
  const specifier: string = 'node:fs';
  const fs = (await import(/* @vite-ignore */ specifier)) as { writeFileSync(path: string, data: string): void };
  fs.writeFileSync(path, text);
}
const SEEDS = Number(env('GR_EVAL_SEEDS') ?? 3);
const MINUTES = Number(env('GR_EVAL_MINUTES') ?? 60);
const ONLY = env('GR_EVAL_ONLY')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

describe('end-to-end: webcam landmarks → page turns', () => {
  it('scores every scenario over simulated hours of reading', async () => {
    const rows: Summary[] = [];
    for (const s of SCENARIOS) {
      if (ONLY && !ONLY.includes(s.name)) continue;
      const runs = Array.from({ length: SEEDS }, (_, i) => runSession(s, 1 + i, { minutes: MINUTES }));
      rows.push(summarize(runs));
    }
    // A long session: two hours of 'everyday' in one go (drift, memory and CPU over time).
    if (!ONLY || ONLY.includes('long')) {
      const long = summarize([runSession(scenario('everyday'), 101, { minutes: Math.max(MINUTES, 120) })]);
      rows.push({ ...long, scenario: 'everyday, 2 h in one go' });
    }
    console.log(`\n${summaryTable(rows)}\n`);
    for (const r of rows) {
      const causes = Object.entries(r.falseCauses).sort((a, b) => b[1] - a[1]);
      if (causes.length) console.log(`${r.scenario}: false turns: ${causes.map(([k, n]) => `${n}× ${k}`).join(', ')}`);
    }
    const out = env('GR_EVAL_OUT');
    if (out) await writeText(out, `${JSON.stringify(rows, null, 2)}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

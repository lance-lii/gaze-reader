import { describe, expect, it } from 'vitest';
import { formatPooled, formatScores, parseRecording, scoreRecording, type AccuracyScores } from '../../src/gaze/accuracyTest';
import { REAL_FACE_PRIOR } from '../../src/gaze/gazePrior';
import { simulatedSession } from './simSession';

/**
 * Scores accuracy-test recordings (Settings → Advanced → "Run the accuracy test" → "Save
 * recording") with the current code:
 *
 *   GR_ACCURACY=path/to/gaze-reader-accuracy-….json npm run bench:live
 *
 * (PowerShell: `$env:GR_ACCURACY='…'; npm run bench:live`.) Several files can be given separated
 * by the platform's path delimiter (`;` on Windows, `:` elsewhere); they are scored one by one
 * and then together.
 *
 * Every calibration variant is fitted again from the recorded calibration frames and scored on
 * the recorded test dots, so a change to the calibration code can be tried on real faces without
 * anyone sitting the test again. Without GR_ACCURACY it scores one simulated session, to show the
 * output; that says nothing about real faces. See docs/ACCURACY_TEST.md.
 */

// The project has no Node type definitions (it's a browser app); reach Node through narrow shapes.
interface NodeProcessLike {
  env: Record<string, string | undefined>;
  platform: string;
}
interface NodeFsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}
const nodeProcess = (globalThis as { process?: NodeProcessLike }).process;

async function readText(path: string): Promise<string> {
  const specifier: string = 'node:fs';
  const fs = (await import(/* @vite-ignore */ specifier)) as NodeFsLike;
  return fs.readFileSync(path, 'utf8');
}

const files = (nodeProcess?.env.GR_ACCURACY ?? '')
  .split(nodeProcess?.platform === 'win32' ? ';' : ':')
  .map((s: string) => s.trim())
  .filter(Boolean);

describe.skipIf(files.length === 0)('accuracy test recordings (GR_ACCURACY)', () => {
  const scored: AccuracyScores[] = [];
  for (const file of files) {
    it(file, async () => {
      const parsed = parseRecording(JSON.parse(await readText(file)) as unknown);
      expect(parsed.ok, `${file}: ${parsed.ok ? '' : parsed.problem}`).toBe(true);
      if (!parsed.ok) return;
      const scores = scoreRecording(parsed.recording, { prior: REAL_FACE_PRIOR });
      scored.push(scores);
      console.log(`\n${file}\n${formatScores(scores)}\n`);
      expect(scores.variants.length).toBeGreaterThan(0);
    });
  }
  it.skipIf(files.length < 2)('all of them together', () => {
    expect(scored.length).toBeGreaterThan(0);
    console.log(`\n${formatPooled(scored)}\n`);
  });
});

describe.skipIf(files.length > 0)('accuracy test on a simulated session (no GR_ACCURACY given)', () => {
  it('prints the scores', () => {
    const scores = scoreRecording(simulatedSession(11), { prior: REAL_FACE_PRIOR });
    console.log(`\nSIMULATED session, to show the output. It says nothing about real faces.\n${formatScores(scores)}\n`);
    expect(scores.variants.every((v) => v.ok)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveEyeNet, runEyeNet } from '../../src/gaze/eyeNet';
import { EOTT_CNN_DIR } from './eott';

type Fs = { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string };
const fs = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.('node:fs') as Fs | undefined;
const weightsPath = `${EOTT_CNN_DIR}/weights.json`;
const checkPath = `${EOTT_CNN_DIR}/check.json`;
const there = !!fs && fs.existsSync(weightsPath) && fs.existsSync(checkPath);

/**
 * The network as the app runs it against the network as it was trained: the same frames have to
 * get the same answers, or a calibration in the app is made on something the scoreboard never
 * scored. Needs `train_eye_cnn.py --final` to have been run (docs/REAL_DATA.md); skipped otherwise.
 */
describe.skipIf(!there)('the eye-picture network: the app’s arithmetic against the trainer’s', () => {
  it('answers the trainer’s check frames as the trainer did', () => {
    const net = resolveEyeNet(JSON.parse(fs!.readFileSync(weightsPath, 'utf8')));
    expect(net).not.toBeNull();
    const check = JSON.parse(fs!.readFileSync(checkPath, 'utf8')) as { eyes: number[][]; extra: number[][]; answer: number[][] };
    expect(check.eyes.length).toBeGreaterThanOrEqual(4);
    let worst = 0;
    check.eyes.forEach((eyes, i) => {
      const a = runEyeNet(net!, eyes, net!.extras > 0 ? check.extra[i] : null)!;
      worst = Math.max(worst, Math.abs(a.x - check.answer[i][0]), Math.abs(a.y - check.answer[i][1]));
    });
    console.log(`eye-picture network ${net!.id}: largest difference from the trainer over ${check.eyes.length} frames ${worst.toExponential(2)} (tangent units; 1e-3 is 0.06°)`);
    expect(worst).toBeLessThan(1e-4);
  });

  it('is fast enough to run on every frame', () => {
    const net = resolveEyeNet(JSON.parse(fs!.readFileSync(weightsPath, 'utf8')))!;
    const check = JSON.parse(fs!.readFileSync(checkPath, 'utf8')) as { eyes: number[][]; extra: number[][] };
    const eyes = Uint8Array.from(check.eyes[0]);
    const extra = net.extras > 0 ? check.extra[0] : null;
    for (let i = 0; i < 50; i++) runEyeNet(net, eyes, extra);
    const t0 = performance.now();
    const n = 300;
    for (let i = 0; i < n; i++) runEyeNet(net, eyes, extra);
    const ms = (performance.now() - t0) / n;
    console.log(`eye-picture network: ${ms.toFixed(2)} ms a frame in this runtime`);
    expect(ms).toBeLessThan(15);
  });
});

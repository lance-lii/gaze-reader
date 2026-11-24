import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { REAL_FACE_PRIOR } from '../../src/gaze/gazePrior';
import { fs } from './dataset';
import { eottAvailable, eottCase, EOTT_DIR, LIGHT_FRAME_TOLERANCE, loadEott, type EottFrame } from './eott';
import { faceScale, sharedDirection } from './shared';

/**
 * Writes what scripts/research/train_eye_cnn.py learns from: for every frame of every person, where
 * they were looking (the dot or the click, and the reference eye tracker), whether the light on
 * the face was steady, and the app's own features of the frame. The loader (eott.ts) decides all of
 * it, so the trainer and the scoreboard cannot disagree about which frame is what.
 *
 * Only runs when asked: `GR_EOTT_LABELS=1 npm run bench:eott`.
 */
const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;

/** One row per frame of the person's record file, in the same order. */
export const LABEL_COLUMNS = [
  'usable', //     1 when the app's feature extractor accepted the frame and it is on the log's clock
  'session', //    1: first dot test, 2: final dot test
  'role', //       1: a calibration frame (just before a click), 2: a test frame (on a dot), 0: neither
  'steady', //     1 when the face is within the lighting gate's tolerance of its recording's usual brightness
  'targetX', //    the dot or click, mm right of the camera (NaN when role is 0)
  'targetY', //    … and mm below it
  'referenceX', // the reference eye tracker's gaze at that moment, same units (NaN where it had lost the eyes)
  'referenceY',
  'faceSize', //   how large the face is in the picture, corrected for a turned head: the app's stand-in for 1 ÷ distance
  'blink',
  'priorX', //     the app's real-face model's answer for the frame (its direction of gaze, before personal fitting)
  'priorY',
  ...FEATURE_NAMES,
] as const;

describe.skipIf(!eottAvailable() || !proc?.env?.GR_EOTT_LABELS)('real people moving their eyes: labels for the trainer', () => {
  it('writes them', () => {
    const out = `${EOTT_DIR}/../labels`;
    fs!.mkdirSync(out, { recursive: true });
    const W = LABEL_COLUMNS.length;
    expect(new Set<string>(LABEL_COLUMNS).size).toBe(W);
    const index: Record<string, unknown>[] = [];
    for (const p of loadEott()) {
      const meta = JSON.parse(new TextDecoder().decode(fs!.readFileSync(`${EOTT_DIR}/${p.id}.json`))) as { records: number };
      const rows = new Float32Array(meta.records * W).fill(NaN);
      for (let r = 0; r < meta.records; r++) rows.set([0, 0, 0, 0], r * W);
      const open = eottCase(p, false);
      const gated = eottCase(p);
      const role = new Map<EottFrame, { role: number; x: number; y: number }>();
      for (const s of open?.cal ?? []) role.set(s.frame, { role: 1, x: s.target.x, y: s.target.y });
      for (const s of open?.test ?? []) role.set(s.frame, { role: 2, x: s.target.x, y: s.target.y });
      const usual = new Map(p.sessions.map((s) => [s.session, s.light]));
      const mm = (x: number, y: number): [number, number] => [(x - p.camera.x) * p.mmPerPx, (y - p.camera.y) * p.mmPerPx];
      for (const f of p.frames) {
        const u = usual.get(f.session);
        const steady = !!u && Math.abs(Math.log(Math.max(f.light.face, 1) / Math.max(u.face, 1))) <= LIGHT_FRAME_TOLERANCE;
        const r = role.get(f);
        const prior = sharedDirection(REAL_FACE_PRIOR, f.features.vector);
        rows.set(
          [
            1,
            f.session,
            r?.role ?? 0,
            steady ? 1 : 0,
            ...(r ? mm(r.x, r.y) : [NaN, NaN]),
            ...(f.reference ? mm(f.reference.x, f.reference.y) : [NaN, NaN]),
            faceScale(f.features.vector),
            f.features.blink,
            prior?.x ?? NaN,
            prior?.y ?? NaN,
            ...Array.from(f.features.vector),
          ],
          f.row * W,
        );
      }
      fs!.writeFileSync(`${out}/${p.id}.f32`, new Uint8Array(rows.buffer));
      index.push({
        id: p.id,
        setting: p.setting,
        distanceMm: p.distanceMm,
        records: meta.records,
        testCase: !!open,
        sameLight: gated?.light?.same ?? null,
      });
    }
    fs!.writeFileSync(`${out}/index.json`, new TextEncoder().encode(JSON.stringify({ columns: LABEL_COLUMNS, people: index }, null, 1)));
    console.log(`\nlabels for ${index.length} people → ${out}\n`);
    expect(index.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { REAL_FACE_PRIOR } from '../../src/gaze/gazePrior';
import { fs, loadParticipants, quantile, REAL_DATA_DIR, realDataAvailable } from './dataset';
import { LABEL_COLUMNS } from './eottLabels.bench.test';
import { faceScale, sharedDirection } from './shared';

/**
 * Writes MPIIFaceGaze in the form scripts/research/train_eye_cnn.py learns from: the same columns as
 * the webcam recordings' labels (eottLabels.bench.test.ts), so one trainer reads both. These are
 * single photographs over many days rather than a calibration and a test, so nobody has a "role"
 * here: `session` is the day, and the trainer splits each day itself (`protocol: 'days'`).
 *
 * Needs the eye pictures: `extract_mpiifacegaze.py --eyes`. Only runs when asked:
 * `GR_MPII_LABELS=1 npm run bench -- bench/realdata/mpiiLabels`.
 */
const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;

/** After the shared columns: what only this dataset knows about each picture. */
export const MPII_EXTRA_COLUMNS = [
  'distanceMm', //   how far the face is from the camera in this picture (the dataset's own estimate)
  'order', //        the picture's place in its day, in time
  'lightFace', //    brightness of the face, 0..255
  'lightBalance', // log(one half of the face ÷ the other)
] as const;

describe.skipIf(!realDataAvailable() || !proc?.env?.GR_MPII_LABELS)('real faces over many days: labels for the trainer', () => {
  it('writes them', () => {
    const out = `${REAL_DATA_DIR}/../labels`;
    fs!.mkdirSync(out, { recursive: true });
    const columns = [...LABEL_COLUMNS, ...MPII_EXTRA_COLUMNS];
    const W = columns.length;
    const index: Record<string, unknown>[] = [];
    for (const p of loadParticipants()) {
      const meta = JSON.parse(new TextDecoder().decode(fs!.readFileSync(`${REAL_DATA_DIR}/${p.id}.json`))) as { records: number };
      const lightBytes = fs!.readFileSync(`${REAL_DATA_DIR}/${p.id}.light.f32`);
      const light = new Float32Array(lightBytes.buffer, lightBytes.byteOffset, Math.floor(lightBytes.byteLength / 4));
      expect(light.length).toBe(meta.records * 6);
      const rows = new Float32Array(meta.records * W).fill(NaN);
      for (let r = 0; r < meta.records; r++) rows.set([0, 0, 0, 0], r * W);
      for (const s of p.samples) {
        const prior = sharedDirection(REAL_FACE_PRIOR, s.features.vector);
        const l = light.subarray(s.row * 6, s.row * 6 + 6);
        rows.set(
          [
            1,
            s.day,
            0,
            1,
            (s.target.x - p.cameraPx.x) * p.mmPerPx,
            (s.target.y - p.cameraPx.y) * p.mmPerPx,
            NaN,
            NaN,
            faceScale(s.features.vector),
            s.features.blink,
            prior?.x ?? NaN,
            prior?.y ?? NaN,
            ...Array.from(s.features.vector),
            s.faceMm[2],
            s.number,
            l[0],
            Math.log(Math.max(l[1], 1) / Math.max(l[2], 1)),
          ],
          s.row * W,
        );
      }
      fs!.writeFileSync(`${out}/${p.id}.f32`, new Uint8Array(rows.buffer));
      index.push({
        id: p.id,
        setting: 'Laptop',
        distanceMm: Math.round(quantile(p.samples.map((s) => s.faceMm[2]), 0.5)),
        records: meta.records,
        testCase: false,
        sameLight: null,
      });
    }
    fs!.writeFileSync(`${out}/index.json`, new TextEncoder().encode(JSON.stringify({ protocol: 'days', columns, people: index }, null, 1)));
    console.log(`\nlabels for ${index.length} people → ${out}\n`);
    expect(index.length).toBeGreaterThan(0);
  });
});

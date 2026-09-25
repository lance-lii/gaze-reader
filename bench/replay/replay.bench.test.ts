import { describe, expect, it } from 'vitest';
import { parseRecording } from '../../src/app/diagnostics';
import { formatReplay, replayRecording } from './replay';

/**
 * Replays a real tracking-diagnostics recording through the current reading
 * layer and prints what it did:
 *
 *   GR_REPLAY=path/to/gaze-reader-diagnostics-….json npm run bench -- bench/replay
 *
 * (PowerShell: `$env:GR_REPLAY='…'; npm run bench -- bench/replay`.) Several files can be
 * given separated by the platform's path delimiter (`;` on Windows, `:` elsewhere).
 *
 * Three rows per recording: the current modules as recorded, without the camera's
 * appearance-change reports (what the reading layer manages alone), and at the eager preset.
 * The replay is open loop (the page moved where the recorded session turned it), so a replay
 * can show a turn earlier than the recorded one but never a later one: a stricter preset than
 * the recorded one shows no turns at all. Skipped when GR_REPLAY is not set.
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

const files = (nodeProcess?.env.GR_REPLAY ?? '')
  .split(nodeProcess?.platform === 'win32' ? ';' : ':')
  .map((s: string) => s.trim())
  .filter(Boolean);

describe.skipIf(files.length === 0)('replay of recorded sessions (GR_REPLAY)', () => {
  for (const file of files) {
    it(file, async () => {
      const rec = parseRecording(JSON.parse(await readText(file)) as unknown);
      expect(rec, `${file} is not a Gaze Reader diagnostics recording`).not.toBeNull();
      if (!rec) return;
      const env = rec.environment;
      const cam = env.camera ? Object.entries(env.camera).map(([k, v]) => `${k}=${String(v)}`).join(' ') : 'unknown';
      const header = [
        `# ${file}`,
        `recorded ${rec.startedAt} · ${rec.stoppedBy ?? 'running'}${rec.truncated ? ' · TRUNCATED' : ''}`,
        `browser: ${env.userAgent}`,
        `screen ${env.screen ? `${env.screen.width}×${env.screen.height}` : '?'} @ dpr ${env.devicePixelRatio ?? '?'} · viewport ${env.viewport ? `${env.viewport.width}×${env.viewport.height}` : '?'} · lighting backend ${env.lightingBackend ?? '?'}`,
        `camera: ${cam}`,
        `sensitivity ${rec.settings.sensitivity} · font ${rec.settings.fontSizePx}px × ${rec.settings.lineHeight} · models ${rec.models.length}`,
      ].join('\n');
      const rows = [
        formatReplay(replayRecording(rec), 'current reading layer'),
        formatReplay(replayRecording(rec, { ignoreAppearanceChanges: true }), 'without appearance-change reports'),
        formatReplay(replayRecording(rec, { sensitivity: 'eager' }), 'eager sensitivity (earlier turns only; open loop)'),
      ];
      console.log(`${header}\n\n${rows.join('\n\n')}\n`);
    });
  }
});

it.skipIf(files.length > 0)('GR_REPLAY not set: nothing to replay', () => {
  expect(files).toEqual([]);
});

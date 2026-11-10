/**
 * vitest globalSetup for `npm run eval`: makes a scratch folder for the shards' results before they
 * start, and merges, prints and saves them once they have all finished (see eval.ts).
 */
import { mergeAndReport } from './eval';

interface NodeTmp {
  mkdtempSync(prefix: string): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
}

export default async function setup(): Promise<() => Promise<void>> {
  const fsSpec: string = 'node:fs';
  const osSpec: string = 'node:os';
  const fs = (await import(/* @vite-ignore */ fsSpec)) as NodeTmp;
  const os = (await import(/* @vite-ignore */ osSpec)) as { tmpdir(): string };
  const dir = fs.mkdtempSync(`${os.tmpdir()}/gaze-reader-eval-`);
  const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  if (proc) proc.env.GR_EVAL_DIR = dir; // inherited by the shard workers, which start after this
  return async () => {
    try {
      await mergeAndReport(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

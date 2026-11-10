// One of the eval's parallel shards (see eval.ts); evalSetup.ts merges and reports them.
import { expect, it } from 'vitest';
import { EVAL_SHARDS, runShard } from './eval';

it('end-to-end eval: shard 1 of 6', async () => {
  expect(await runShard(0, EVAL_SHARDS)).toBeGreaterThanOrEqual(0);
});

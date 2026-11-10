// One of the eval's parallel shards (see eval.ts); evalSetup.ts merges and reports them.
import { expect, it } from 'vitest';
import { EVAL_SHARDS, runShard } from './eval';

it('end-to-end eval: shard 5 of 6', async () => {
  expect(await runShard(4, EVAL_SHARDS)).toBeGreaterThanOrEqual(0);
});

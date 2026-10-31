import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_SCHEMA_VERSION, stableModelIdentity } from '../model-schema';

describe('Provider/model stable identity schema', () => {
  test('uses providerId and modelId for both selection and pricing identity', () => {
    const first = stableModelIdentity('provider-a', 'model-v1');
    const renamed = stableModelIdentity('provider-a', 'model-v1');
    assert.equal(MODEL_SCHEMA_VERSION, 1);
    assert.deepEqual(first, {
      providerId: 'provider-a', modelId: 'model-v1',
      modelKey: 'provider-a@model-v1', pricingId: 'provider-a@model-v1',
    });
    assert.deepEqual(renamed, first, '展示别名变化不应改变计价 ID');
  });

  test('keeps model IDs containing slashes and colons stable', () => {
    assert.equal(stableModelIdentity('ollama', 'qwen:7b/instruct').pricingId, 'ollama@qwen:7b/instruct');
  });

  test('rejects blank identity components', () => {
    assert.throws(() => stableModelIdentity('', 'model'), /providerId 不能为空/);
    assert.throws(() => stableModelIdentity('provider', ' '), /modelId 不能为空/);
  });
});

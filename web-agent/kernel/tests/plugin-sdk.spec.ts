import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_API_VERSION, SERVICE_KEYS } from '../plugin-sdk';

describe('plugin SDK public entrypoint', () => {
  test('exports the host API version and stable service keys', () => {
    assert.equal(PLUGIN_API_VERSION, '1.0.0');
    assert.equal(SERVICE_KEYS.runner, 'service:runner');
    assert.equal(SERVICE_KEYS.cache, 'service:cache');
  });
});

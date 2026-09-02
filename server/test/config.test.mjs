import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadConfig} from '../src/config.mjs';

test('configuration rejects wildcard CORS, weak or duplicate tokens, and invalid numeric limits', () => {
  assert.throws(
    () => loadConfig({FIELDNOTE_CORS_ORIGINS: '*'}),
    error => error.code === 'INVALID_CONFIGURATION' && /allowlist/.test(error.message),
  );
  assert.throws(
    () => loadConfig({FIELDNOTE_DEMO_INSPECTOR_TOKEN: 'short'}),
    error => error.code === 'INVALID_CONFIGURATION' && /16 characters/.test(error.message),
  );
  assert.throws(
    () => loadConfig({
      FIELDNOTE_DEMO_INSPECTOR_TOKEN: 'same-token-value-123',
      FIELDNOTE_DEMO_REVIEWER_TOKEN: 'same-token-value-123',
    }),
    error => error.code === 'INVALID_CONFIGURATION' && /unique/.test(error.message),
  );
  assert.throws(
    () => loadConfig({FIELDNOTE_BODY_LIMIT_BYTES: '100'}),
    error => error.code === 'INVALID_CONFIGURATION' && /FIELDNOTE_BODY_LIMIT_BYTES/.test(error.message),
  );
});

test('configuration preserves the real project membership map', () => {
  const config = loadConfig({FIELDNOTE_PORT: '0'});
  assert.deepEqual(Object.keys(config.identities[0].memberships), ['project-c3']);
  assert.deepEqual(Object.keys(config.identities[1].memberships), ['project-c3']);
  assert.deepEqual(Object.keys(config.identities[2].memberships), ['project-c3', 'project-p2', 'project-north']);
  assert.equal(config.port, 0);
});

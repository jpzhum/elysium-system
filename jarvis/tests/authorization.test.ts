import { expect, test } from 'vitest';
import { authorize, AuthorizationError, type Capability } from '../src/policy/authorization.js';

test.each(['join', 'leave', 'configure', 'shutdown'] satisfies Capability[])('%s is backend owner-only', (capability) => {
  expect(() => authorize('guest', capability, 'owner')).toThrow(AuthorizationError);
  expect(() => authorize('owner', capability, 'owner')).not.toThrow();
});
test.each(['ask', 'search_game_info'] satisfies Capability[])('consented guests can use %s', (capability) => {
  expect(() => authorize('guest', capability, 'owner')).not.toThrow();
});

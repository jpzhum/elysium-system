import { expect, test } from 'vitest';
import { ConsentStore } from '../src/policy/consent.js';

test('audio requires explicit opt-in, revocation and renewed consent invalidate pending work', () => {
  const store = new ConsentStore();
  const text = store.grant('guest', false);
  expect(store.isCurrent('guest', text.version)).toBe(true);
  expect(store.isCurrent('guest', text.version, true)).toBe(false);
  store.revoke('guest');
  const audio = store.grant('guest', true);
  expect(store.isCurrent('guest', text.version)).toBe(false);
  expect(store.isCurrent('guest', audio.version, true)).toBe(true);
  store.clear();
  expect(store.get('guest')).toBeUndefined();
  expect(new ConsentStore().get('guest')).toBeUndefined();
});

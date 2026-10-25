import { expect, test, vi } from 'vitest';
import { VoiceFeedback } from '../src/discord/voice-feedback.js';

function delivery() {
  let valid = true;
  const edit = vi.fn(async (_payload: { content: string }) => undefined);
  const privateSend = vi.fn(async (_payload: { content: string }) => ({ edit }));
  const publicSummary = vi.fn(async () => undefined);
  return { valid: () => valid, privateSend, publicSummary, edit, revoke: () => { valid = false; } };
}

test('concurrent repeated rejections share a per-speaker category cooldown without suppressing other participants', async () => {
  let now = 0;
  const feedback = new VoiceFeedback(() => now);
  const send = delivery();
  await Promise.all(Array.from({ length: 10 }, () => feedback.rejected('a', 'wake_global', 'Quota.', send, 10_000)));
  await feedback.rejected('b', 'wake_global', 'Quota.', send);
  await feedback.rejected('a', 'capture_limit', 'Captura.', send);
  expect(send.privateSend).toHaveBeenCalledTimes(3);
  now = 10_000;
  await feedback.rejected('a', 'wake_global', 'Quota.', send);
  expect(send.privateSend).toHaveBeenCalledTimes(4);
  expect(send.publicSummary).not.toHaveBeenCalled();
});

test('saturated feedback state cannot evict a live cooldown and repeatedly notify its participant', async () => {
  const feedback = new VoiceFeedback(() => 0);
  const send = delivery();
  for (let actor = 0; actor < 16; actor++) await feedback.rejected(`speaker-${actor}`, 'wake_global', 'Quota.', send);
  await feedback.rejected('new-speaker', 'wake_global', 'Quota.', send);
  await feedback.rejected('speaker-0', 'wake_global', 'Quota.', send);
  expect(send.privateSend).toHaveBeenCalledTimes(16);
  expect(send.publicSummary).toHaveBeenCalledTimes(1);
});

test('one technical turn updates its original private notice once, with no duplicate queue or terminal messages', async () => {
  const feedback = new VoiceFeedback();
  const send = delivery();
  await feedback.turn('a', 'AABBCCDD', 'queued', 'Em espera.', send);
  await feedback.turn('a', 'AABBCCDD', 'queued', 'Em espera.', send);
  await feedback.turn('a', 'AABBCCDD', 'failed', 'Falhou.', send);
  await feedback.turn('a', 'AABBCCDD', 'failed', 'Falhou.', send);
  await feedback.turn('b', 'AABBCCDD', 'cancelled', 'Outro usuário.', send);
  expect(send.privateSend).toHaveBeenCalledTimes(1);
  expect(send.edit).toHaveBeenCalledExactlyOnceWith({ content: 'Falhou.', allowedMentions: { parse: [] } });
});

test('revocation while a private send is pending cannot edit or recreate the old turn notice', async () => {
  const feedback = new VoiceFeedback();
  const send = delivery();
  let release!: (message: { edit: typeof send.edit }) => void;
  send.privateSend.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const queued = feedback.turn('a', 'AABBCCDD', 'queued', 'Em espera.', send);
  await Promise.resolve(); await Promise.resolve();
  expect(send.privateSend).toHaveBeenCalledOnce();
  send.revoke(); feedback.forget('a');
  const terminal = feedback.turn('a', 'AABBCCDD', 'failed', 'Antigo.', send);
  release({ edit: send.edit }); await queued; await terminal;
  expect(send.edit).not.toHaveBeenCalled(); expect(send.publicSummary).not.toHaveBeenCalled();
});

import { expect, test } from 'vitest';
import { jarvisCommand, privacyNotice } from '../src/discord/commands.js';

test('slash payload is valid and audio consent is opt-in rather than a default', () => {
  const command = jarvisCommand.toJSON();
  expect(command.name).toBe('jarvis');
  expect(command.options?.map((o) => o.name)).toEqual(expect.arrayContaining([
    'join', 'leave', 'status', 'consent', 'revoke', 'cancel', 'ask', 'privacy', 'tone',
  ]));
});
test('consent disclosure distinguishes local probe, text and external pre-wake audio', () => {
  expect(privacyNotice('disabled')).toContain('captura de voz está desativada');
  expect(privacyNotice('elevenlabs-stt', false, 25)).toContain('25 s');
  expect(privacyNotice('elevenlabs-stt')).toContain('inclusive antes da ativação');
  expect(privacyNotice('disabled', true)).toContain('Não é enviado à ElevenLabs');
  expect(privacyNotice('elevenlabs-stt', false, 18, true)).toContain('somente o proprietário');
  expect(privacyNotice('elevenlabs-stt', false, 18, true)).toContain('Use fones');
  expect(privacyNotice('elevenlabs-stt')).not.toContain('Durante respostas');
  expect(privacyNotice('elevenlabs-stt')).toContain('nomes de exibição e presença');
  expect(privacyNotice('elevenlabs-stt', false, 30, true).length).toBeLessThanOrEqual(2000);
});

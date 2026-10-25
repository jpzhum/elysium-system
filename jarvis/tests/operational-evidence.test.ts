import { expect, test, vi } from 'vitest';
import { Logger, type DiagnosticFields } from '../src/observability/metrics.js';
import { deploymentRevision, OperationalEvidence } from '../src/observability/operational-evidence.js';

test('status sees sanitized observations with stdout filtered and detaches on shutdown', () => {
  const write = vi.fn();
  const logger = new Logger('error', write);
  let now = 100;
  const evidence = new OperationalEvidence(logger, () => now);
  logger.event('jarvis_agent_input_sent', 'info', { input_kind: 'voice', user_turn_recognized: false });
  expect(evidence.summary()).toContain('aguardando transcript final');
  logger.event('jarvis_agent_user_turn_recognized');
  logger.event('jarvis_agent_turn_recovering', 'error', { code: 'AGENT_COMPLETION_MISSING', category: 'agent' });
  expect(evidence.summary()).toContain('fala reconhecida');
  expect(evidence.summary()).toContain('Última falha técnica: sem observação');
  expect(evidence.summary()).toContain('confirmação=sem amostras');
  const raw = { code: 'PLAYBACK_FAILED', category: 'playback', stage: 'playback', cause_code: 'PLAYBACK_ENCODER_FAILED',
    incident: 'AABBCCDD', message: 'PRIVATE', transcript: 'PRIVATE', token: 'PRIVATE' };
  logger.event('jarvis_agent_turn_failed', 'error', raw as DiagnosticFields);
  now += 3000;
  logger.event('voice_recovery_started', 'info');
  logger.event('voice_recovery_ready', 'info');
  const summary = evidence.summary();
  expect(summary).toContain('PLAYBACK_FAILED / causa=PLAYBACK_ENCODER_FAILED / playback / incidente=AABBCCDD (há 3 s)');
  expect(summary).toContain('Ready restabelecido');
  expect(summary).toContain('falhos=1');
  expect(summary).toContain('Não comprova audição');
  expect(summary).not.toContain('PRIVATE');
  expect(write).toHaveBeenCalledTimes(2);
  evidence.close();
  logger.event('jarvis_agent_turn_failed', 'error', { incident: 'FFEEDDCC' });
  expect(evidence.summary()).toBe(summary);
});

test('terminal rates separate confirmations, unconfirmed playback, failures and queued cancellations without duplicates', () => {
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger);
  logger.event('jarvis_agent_turn_started', 'info', { incident: '00000000' });
  logger.event('jarvis_agent_response_complete', 'info', { incident: '00000000' });
  logger.event('jarvis_agent_turn_recovered', 'info', { incident: '00000000' });
  expect(evidence.summary()).toContain('desde o início: n=0');
  logger.event('jarvis_agent_turn_finished', 'info', { incident: '00000000', turn_outcome: 'completed' });
  logger.event('jarvis_agent_turn_finished', 'info', { incident: '00000000', turn_outcome: 'completed' });
  logger.event('jarvis_agent_turn_finished', 'info', { incident: '00000001', turn_outcome: 'unconfirmed' });
  logger.event('jarvis_agent_turn_cancelled', 'info', { incident: '00000002', turn_outcome: 'cancelled', input_kind: 'voice' });
  logger.event('jarvis_agent_turn_failed', 'info', { incident: '00000003', turn_outcome: 'failed' });
  expect(evidence.summary()).toContain('n=4; confirmados=1; não confirmados=1; falhos=1; cancelados=1; parciais=0; expirados=0; confirmação=25.0%');
  expect(evidence.summary()).toContain('ASR=turno cancelado');
  expect(evidence.summary().length).toBeLessThanOrEqual(1500);
  evidence.close();
});

test('recent denominator is bounded while process totals survive the window', () => {
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger);
  for (let index = 0; index < 300; index++) logger.event('jarvis_agent_turn_finished', 'info', {
    incident: index.toString(16).padStart(8, '0').toUpperCase(), turn_outcome: index < 44 ? 'unconfirmed' : 'completed',
  });
  expect(evidence.summary()).toContain('desde o início: n=300; confirmados=256; não confirmados=44');
  expect(evidence.summary()).toContain('Últimos até 256 encerrados: n=256; confirmados=256; não confirmados=0');
  evidence.close();
});

test('a causal error is not terminal, partial playback is separate and only confirmed drain advances last success', () => {
  let now = 0;
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger, () => now);
  logger.event('jarvis_agent_turn_error', 'error', { incident: 'AABBCCDD', code: 'AGENT_TRANSPORT_ERROR', turn_delivery: 'partial' });
  expect(evidence.summary()).toContain('desde o início: n=0');
  logger.event('jarvis_agent_turn_failed', 'info', { incident: 'AABBCCDD', turn_outcome: 'partial', turn_delivery: 'partial' });
  logger.event('jarvis_agent_turn_cancelled', 'info', { incident: 'AABBCCDE', turn_outcome: 'expired', cancellation_reason: 'expired' });
  expect(evidence.summary()).toContain('parciais=1; expirados=1');
  expect(evidence.summary()).toContain('Último turno confirmado e drenado: sem observação');
  logger.event('jarvis_agent_turn_finished', 'info', { incident: 'AABBCCDF', turn_outcome: 'completed' });
  now = 5000;
  expect(evidence.summary()).toContain('Último turno confirmado e drenado: há 5 s');
  expect(evidence.incidentDetails('AABBCCDD')).toContain('"turn_delivery":"partial"');
  expect(evidence.incidentDetails('AABBCCDE')).toContain('"cancellation_reason":"expired"');
  expect(evidence.incidentDetails('PRIVATE')).not.toContain('PRIVATE');
  for (let index = 0; index < 64; index++) logger.event('jarvis_ready', 'info', {
    incident: index.toString(16).toUpperCase().padStart(8, '0'),
  });
  expect(evidence.incidentDetails('AABBCCDD')).toContain('não encontrado');
  evidence.close();
});

test('incident diagnostics keep causal stage separate from the last release stage', () => {
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger);
  logger.event('jarvis_agent_turn_error', 'error', { incident: 'AABBCCDD', code: 'PLAYBACK_FAILED', stage: 'playback' });
  logger.event('jarvis_agent_turn_failed', 'error', { incident: 'AABBCCDD', code: 'PLAYBACK_FAILED', stage: 'agent_connect' });
  logger.event('jarvis_agent_turn_released', 'info', { incident: 'AABBCCDD', stage: 'session_setup' });
  expect(evidence.incidentDetails('AABBCCDD')).toContain('"failure_stage":"playback"');
  expect(evidence.incidentDetails('AABBCCDD')).toContain('"stage":"session_setup"');
  expect(evidence.summary()).toContain('PLAYBACK_FAILED / playback / incidente=AABBCCDD');
  evidence.close();
});

test('a generic playback rollup preserves the specific failure for the same incident', () => {
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger);
  logger.event('jarvis_playback_failed', 'error', { incident: 'AABBCCDD', category: 'playback',
    code: 'PLAYBACK_ENCODER_FAILED', cause_code: 'UNKNOWN', stage: 'playback', playback_stage: 'opus_encode' });
  logger.event('jarvis_agent_turn_failed', 'error', { incident: 'AABBCCDD', category: 'playback',
    code: 'PLAYBACK_FAILED', cause_code: 'UNKNOWN' });
  expect(evidence.summary()).toContain('PLAYBACK_ENCODER_FAILED / causa=UNKNOWN / playback / opus_encode');
  logger.event('jarvis_agent_turn_failed', 'error', { incident: 'FFEEDDCC', category: 'agent', code: 'AGENT_REQUEST_TIMEOUT' });
  expect(evidence.summary()).toContain('AGENT_REQUEST_TIMEOUT');
  expect(evidence.summary()).not.toContain('PLAYBACK_ENCODER_FAILED');
  evidence.close();
});

test('incident details preserve encoder cause and stage through interleaved generic turn rollups', () => {
  const logger = new Logger('error', () => undefined);
  const evidence = new OperationalEvidence(logger);
  logger.event('jarvis_playback_failed', 'error', { incident: 'AABBCCDD', category: 'playback',
    code: 'PLAYBACK_ENCODER_FAILED', cause_code: 'UNKNOWN', stage: 'playback', playback_stage: 'opus_encode' });
  logger.event('jarvis_agent_turn_error', 'error', { incident: 'FFEEDDCC', category: 'agent',
    code: 'AGENT_TRANSPORT_ERROR', stage: 'agent_response_wait' });
  logger.event('jarvis_agent_turn_error', 'error', { incident: 'AABBCCDD', category: 'playback',
    code: 'PLAYBACK_FAILED', cause_code: 'PLAYBACK_ENCODER_FAILED', stage: 'agent_response_wait' });
  logger.event('jarvis_agent_turn_failed', 'error', { incident: 'AABBCCDD', category: 'playback',
    code: 'PLAYBACK_FAILED', cause_code: 'UNKNOWN', stage: 'agent_response_wait', turn_outcome: 'partial' });
  logger.event('jarvis_agent_turn_released', 'info', { incident: 'AABBCCDD', stage: 'session_setup' });
  const details = evidence.incidentDetails('AABBCCDD');
  expect(details).toContain('"code":"PLAYBACK_ENCODER_FAILED"');
  expect(details).toContain('"failure_stage":"playback"');
  expect(details).toContain('"stage":"session_setup"');
  expect(details).toContain('"turn_outcome":"partial"');
  expect(evidence.summary()).toContain('AGENT_TRANSPORT_ERROR / agent_response_wait / incidente=FFEEDDCC');
  expect(evidence.summary()).toContain('parciais=1');
  evidence.close();
});

test('an observer cannot mutate log fields, leak arbitrary content or interrupt pipeline callbacks', () => {
  const write = vi.fn();
  const logger = new Logger('info', write);
  const observed = vi.fn();
  logger.observe(event => { expect(Object.isFrozen(event)).toBe(true); throw new Error('PRIVATE'); });
  const dispose = logger.observe(observed);
  expect(() => logger.event('jarvis_ready', 'info', { deployed_revision: 'CFCdd03', token: 'PRIVATE' } as DiagnosticFields)).not.toThrow();
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ event: 'jarvis_ready', deployed_revision: 'cfcdd03' }));
  expect(JSON.stringify(observed.mock.calls)).not.toContain('PRIVATE');
  expect(write.mock.calls[0]![0]).not.toContain('PRIVATE');
  dispose();
  logger.event('jarvis_ready');
  expect(observed).toHaveBeenCalledTimes(1);
  expect(deploymentRevision('secret')).toBe('não informada');
  expect(deploymentRevision(undefined)).toBe('não informada');
  expect(deploymentRevision('CFCdd03')).toBe('cfcdd03');
});

import { expect, test, vi } from 'vitest';
import { DiagnosticError, JoinDiagnostics } from '../src/observability/diagnostics.js';
import { Logger } from '../src/observability/metrics.js';
import {
  createVoiceRuntimeInspector, inspectVoiceRuntime, type DaveyRuntimeModule,
  type VoiceRuntimeDependencies,
} from '../src/observability/voice-runtime.js';

function captureDiagnostics() {
  const records: Record<string, unknown>[] = [];
  const logger = new Logger('info', (line) => { records.push(JSON.parse(line) as Record<string, unknown>); });
  const diagnostics = new JoinDiagnostics(logger);
  diagnostics.stage('runtime_probe');
  return { records, diagnostics };
}

function fixture(overrides: Partial<VoiceRuntimeDependencies> = {}) {
  const reset = vi.fn();
  const construct = vi.fn();
  class Session {
    readonly ready = false;
    constructor(readonly protocolVersion: number, userId: string, channelId: string) {
      construct(protocolVersion, userId, channelId);
    }
    reset = reset;
  }
  const loadDavey = vi.fn(async () => ({ DAVE_PROTOCOL_VERSION: 1, DAVESession: Session }));
  const inspect = createVoiceRuntimeInspector({
    nodeVersion: '24.19.0', platform: 'linux', arch: 'x64',
    voiceVersion: '0.19.2', discordVersion: '14.27.0',
    getCiphers: () => ['aes-256-gcm'], loadDavey, ...overrides,
  });
  return { inspect, loadDavey, reset, construct, ...captureDiagnostics() };
}

test('local native probe emits capabilities, resets its synthetic session and does not require MLS readiness', async () => {
  const state = fixture();
  await state.inspect(state.diagnostics);
  expect(state.construct).toHaveBeenCalledExactlyOnceWith(1, '111111111111111111', '222222222222222222');
  expect(state.reset).toHaveBeenCalledTimes(1);
  expect(state.records.at(-1)).toMatchObject({
    event: 'jarvis_voice_runtime', stage: 'runtime_probe', level: 'info',
    node_version: '24.19.0', voice_version: '0.19.2', discord_version: '14.27.0',
    platform: 'linux', arch: 'x64', dave_enabled: true, transport_aes_gcm: true,
    dave_available: true, dave_protocol_version: 1,
  });
  expect(state.records.at(-1)).not.toHaveProperty('dave_ready');
  expect(JSON.stringify(state.records)).not.toContain('111111111111111111');
  expect(JSON.stringify(state.records)).not.toContain('222222222222222222');
});

test.each(['20.19.0', '22.11.0', '27.0.0', '99.0.0', '24.0.0-private'])('rejects unsupported Node %s before loading native code', async (nodeVersion) => {
  const state = fixture({ nodeVersion });
  await expect(state.inspect(state.diagnostics)).rejects.toMatchObject({ category: 'runtime', code: 'NODE_UNSUPPORTED' });
  expect(state.loadDavey).not.toHaveBeenCalled();
  expect(state.records.at(-1)).toMatchObject({ event: 'jarvis_voice_runtime', level: 'error', dave_available: false });
});

test.each(['22.12.0', '22.22.0', '24.19.0', '26.0.0'])('accepts the project Node engine range at %s', async (nodeVersion) => {
  const state = fixture({ nodeVersion });
  await expect(state.inspect(state.diagnostics)).resolves.toBeUndefined();
});

test.each([
  ['freebsd', 'x64'], ['linux', 'ia32'], ['PRIVATE_URL', 'PRIVATE_TOKEN'],
])('rejects unsupported runtime %s/%s without emitting arbitrary values', async (platform, arch) => {
  const state = fixture({ platform, arch });
  await expect(state.inspect(state.diagnostics)).rejects.toMatchObject({ code: 'ENVIRONMENT_UNSUPPORTED' });
  expect(state.loadDavey).not.toHaveBeenCalled();
  expect(JSON.stringify(state.records)).not.toMatch(/PRIVATE_URL|PRIVATE_TOKEN/);
});

test.each(['linux', 'darwin', 'win32'])('accepts native targets on %s arm64', async (platform) => {
  const state = fixture({ platform, arch: 'arm64' });
  await expect(state.inspect(state.diagnostics)).resolves.toBeUndefined();
  expect(state.records.at(-1)).toMatchObject({ platform, arch: 'arm64' });
});

test('missing or incompatible native bindings produce a fixed code without exposing loader payloads', async () => {
  const state = fixture({ loadDavey: async () => {
    throw new Error('Cannot load binary PRIVATE_TOKEN https://private.invalid/?signed=PRIVATE_CREDENTIAL');
  } });
  let failure: unknown;
  try { await state.inspect(state.diagnostics); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DiagnosticError);
  expect(state.diagnostics.failure(failure)).toEqual({ category: 'dependency', code: 'NATIVE_BINDING_UNAVAILABLE' });
  expect((failure as Error).message).toBe('NATIVE_BINDING_UNAVAILABLE');
  expect(state.records.find(({ event }) => event === 'jarvis_voice_runtime')).toMatchObject({ dave_available: false });
  expect(JSON.stringify(state.records)).not.toMatch(/PRIVATE_|https:/);
});

test.each([0, -1, undefined, null, NaN, 1.5, 65_536])('rejects invalid advertised DAVE protocol %s before session construction', async (protocol) => {
  const construct = vi.fn();
  const state = fixture({ loadDavey: async () => ({
    DAVE_PROTOCOL_VERSION: protocol,
    DAVESession: construct,
  }) as unknown as DaveyRuntimeModule });
  await expect(state.inspect(state.diagnostics)).rejects.toMatchObject({ category: 'dave', code: 'DAVE_UNSUPPORTED_PROTOCOL' });
  expect(construct).not.toHaveBeenCalled();
});

test.each([null, { DAVE_PROTOCOL_VERSION: 1 }])('rejects a binding without the session API', async (binding) => {
  const state = fixture({ loadDavey: async () => binding as unknown as DaveyRuntimeModule });
  await expect(state.inspect(state.diagnostics)).rejects.toMatchObject({ category: 'dave', code: 'DAVE_UNAVAILABLE' });
  expect(state.records.at(-1)).toMatchObject({ dave_available: false, level: 'error' });
});

test.each(['construction', 'reset'])('sanitizes DAVE %s failures', async (phase) => {
  class FailingSession {
    readonly protocolVersion = 1;
    readonly ready = false;
    constructor() { if (phase === 'construction') throw new Error('PRIVATE_NATIVE_CONSTRUCTION'); }
    reset() { throw new Error('PRIVATE_NATIVE_RESET'); }
  }
  const state = fixture({ loadDavey: async () => ({ DAVE_PROTOCOL_VERSION: 1, DAVESession: FailingSession }) });
  let failure: unknown;
  try { await state.inspect(state.diagnostics); } catch (error) { failure = error; }
  expect(state.diagnostics.failure(failure)).toEqual({ category: 'dave', code: 'DAVE_UNAVAILABLE' });
  expect((failure as Error).message).toBe('DAVE_UNAVAILABLE');
  expect(JSON.stringify(state.records)).not.toContain('PRIVATE_');
});

test('mismatched native session protocol is diagnosed and session storage is reset', async () => {
  const reset = vi.fn();
  class WrongSession {
    readonly protocolVersion = 0;
    readonly ready = false;
    reset = reset;
  }
  const state = fixture({ loadDavey: async () => ({ DAVE_PROTOCOL_VERSION: 1, DAVESession: WrongSession }) });
  await expect(state.inspect(state.diagnostics)).rejects.toMatchObject({ code: 'DAVE_UNSUPPORTED_PROTOCOL' });
  expect(reset).toHaveBeenCalledOnce();
});

test('AES GCM capability is reported separately from DAVE support', async () => {
  const state = fixture({ getCiphers: () => [] });
  await state.inspect(state.diagnostics);
  expect(state.records.at(-1)).toMatchObject({ transport_aes_gcm: false, dave_available: true, dave_enabled: true });
});

test('installed native binding passes a local probe without credentials, network, audio or transcriptions', async () => {
  const state = captureDiagnostics();
  await inspectVoiceRuntime(state.diagnostics);
  expect(state.records.at(-1)).toMatchObject({ event: 'jarvis_voice_runtime', dave_available: true });
  expect(state.records.at(-1)).not.toHaveProperty('dave_ready');
});

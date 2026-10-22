import { getCiphers } from 'node:crypto';
import { version as voiceVersion } from '@discordjs/voice';
import { version as discordVersion } from 'discord.js';
import { DiagnosticError, type DiagnosticFields, type JoinDiagnostics } from './diagnostics.js';

interface ProbeSession {
  readonly protocolVersion: number;
  reset(): void;
}

export interface DaveyRuntimeModule {
  readonly DAVE_PROTOCOL_VERSION: number;
  readonly DAVESession: new (protocol: number, userId: string, channelId: string) => ProbeSession;
}

/** Injectable local capabilities; this probe never opens a network connection. */
export interface VoiceRuntimeDependencies {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly voiceVersion: string;
  readonly discordVersion: string;
  readonly getCiphers: () => readonly string[];
  readonly loadDavey: () => Promise<DaveyRuntimeModule>;
}

const defaults: VoiceRuntimeDependencies = {
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  voiceVersion,
  discordVersion,
  getCiphers,
  loadDavey: async () => import('@snazzah/davey'),
};

function supportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 27 && (major > 22 || (major === 22 && minor >= 12));
}

/**
 * Validate the native DAVE binding using fixed, synthetic IDs and no media or MLS traffic.
 * A new session's `ready === false` is expected: only a real Discord MLS exchange makes it ready.
 */
export function createVoiceRuntimeInspector(overrides: Partial<VoiceRuntimeDependencies> = {}) {
  const runtime = { ...defaults, ...overrides };
  return async (diagnostics: JoinDiagnostics): Promise<void> => {
    const fields: DiagnosticFields = {
      node_version: runtime.nodeVersion,
      voice_version: runtime.voiceVersion,
      discord_version: runtime.discordVersion,
      dave_enabled: true,
      transport_aes_gcm: false,
      dave_available: false,
    };
    if (runtime.platform === 'linux' || runtime.platform === 'win32' || runtime.platform === 'darwin') {
      fields.platform = runtime.platform;
    }
    if (runtime.arch === 'x64' || runtime.arch === 'arm64') fields.arch = runtime.arch;
    let succeeded = false;
    try {
      if (!supportedNode(runtime.nodeVersion)) throw new DiagnosticError('runtime', 'NODE_UNSUPPORTED');
      if (!['linux', 'win32', 'darwin'].includes(runtime.platform) || !['x64', 'arm64'].includes(runtime.arch)) {
        throw new DiagnosticError('runtime', 'ENVIRONMENT_UNSUPPORTED');
      }
      fields.transport_aes_gcm = runtime.getCiphers().includes('aes-256-gcm');

      let davey: DaveyRuntimeModule;
      try { davey = await runtime.loadDavey(); }
      catch { throw new DiagnosticError('dependency', 'NATIVE_BINDING_UNAVAILABLE'); }
      if (!davey) throw new DiagnosticError('dave', 'DAVE_UNAVAILABLE');
      const protocol = davey.DAVE_PROTOCOL_VERSION;
      if (!Number.isInteger(protocol) || protocol <= 0 || protocol > 65_535) {
        throw new DiagnosticError('dave', 'DAVE_UNSUPPORTED_PROTOCOL');
      }
      fields.dave_protocol_version = protocol;
      if (typeof davey.DAVESession !== 'function') throw new DiagnosticError('dave', 'DAVE_UNAVAILABLE');
      let session: ProbeSession | undefined;
      let failure: DiagnosticError | undefined;
      try {
        session = new davey.DAVESession(protocol, '111111111111111111', '222222222222222222');
        if (session.protocolVersion !== protocol) throw new DiagnosticError('dave', 'DAVE_UNSUPPORTED_PROTOCOL');
      } catch (error) {
        failure = error instanceof DiagnosticError ? error : new DiagnosticError('dave', 'DAVE_UNAVAILABLE');
      } finally {
        if (session) {
          try { session.reset(); }
          catch { failure ??= new DiagnosticError('dave', 'DAVE_UNAVAILABLE'); }
        }
      }
      if (failure) throw failure;
      fields.dave_available = true;
      succeeded = true;
    } finally {
      diagnostics.event('jarvis_voice_runtime', succeeded ? 'info' : 'error', fields);
    }
  };
}

export const inspectVoiceRuntime = createVoiceRuntimeInspector();

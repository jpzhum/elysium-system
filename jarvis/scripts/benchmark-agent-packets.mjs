import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAgentConnector } from '../dist/agents/elevenlabs-client.js';

// Local protocol fixture only. No network, private audio or paid provider calls.
class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  send(_data, callback) { callback?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

const metadata = Buffer.from(JSON.stringify({
  type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
    conversation_id: 'synthetic', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
  },
}));
const source = await readFile(new URL('../src/agents/elevenlabs-client.ts', import.meta.url));
const quantile = (sorted, probability) => sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)];
const scenarios = [];
for (const pcmBytes of [4_800, 48_000, 192_000]) {
  const socket = new Socket();
  let received = 0;
  let errors = 0;
  const connect = createAgentConnector({
    fetch: async () => Response.json({
      signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=synthetic&token=fixture',
    }),
    createSocket() {
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit('open');
        socket.emit('message', metadata, false);
      });
      return socket;
    },
    random: () => 0.5,
    sleep: async () => {},
  });
  const session = await connect({ apiKey: 'synthetic', agentId: 'synthetic', dynamicVariables: {}, callbacks: {
    onAudio(pcm) { received += pcm.length; },
    onResponseComplete() {}, onInterruption() {}, onClose() {}, onError() { errors++; },
  } });
  const packet = Buffer.from(JSON.stringify({ type: 'audio', audio_event: {
    audio_base_64: Buffer.alloc(pcmBytes, 1).toString('base64'), event_id: 1,
  } }));
  const run = () => { for (let message = 0; message < 50; message++) socket.emit('message', packet, false); };
  for (let warmup = 0; warmup < 20; warmup++) run();
  received = 0;
  const samples = [];
  for (let sample = 0; sample < 100; sample++) {
    const start = performance.now();
    run();
    samples.push((performance.now() - start) / 50);
  }
  session.close();
  samples.sort((a, b) => a - b);
  scenarios.push({ pcmBytes, packetBytes: packet.length, samples: samples.length,
    packetsPerSample: 50, unit: 'ms_per_packet', p50: quantile(samples, 0.5), p90: quantile(samples, 0.9),
    p95: quantile(samples, 0.95), max: samples.at(-1),
    deliveredBytes: received, expectedBytes: 100 * 50 * pcmBytes, errors });
}
process.stdout.write(`${JSON.stringify({ mode: 'synthetic-local-cpu', node: process.version,
  sourceSha256: createHash('sha256').update(source).digest('hex'), scenarios }, null, 2)}\n`);

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { summarize } from './benchmark-summary.mjs';

const events = new Set([
  'jarvis_voice_captured', 'jarvis_wake_detected', 'jarvis_agent_turn_started',
  'jarvis_agent_session_ready', 'jarvis_agent_input_started', 'jarvis_agent_input_sent',
  'jarvis_agent_first_audio', 'jarvis_agent_response_observed', 'jarvis_agent_audio_progress',
  'jarvis_agent_playback_completed', 'jarvis_agent_response_complete',
  'jarvis_agent_turn_finished', 'jarvis_agent_turn_failed', 'jarvis_agent_turn_superseded',
]);
const fields = ['question_wait_ms', 'upload_ms', 'first_audio_ms', 'first_playback_ms'];
const terminal = new Set(['jarvis_agent_turn_finished', 'jarvis_agent_turn_failed', 'jarvis_agent_turn_superseded']);
const outcomes = new Set(['completed', 'superseded', 'unconfirmed', 'cancelled', 'failed']);
const measured = value => Number.isSafeInteger(value) && value >= 0 && value <= 3_600_000;

function distribution(rows, field) { return summarize(rows.flatMap(row => measured(row[field]) ? [row[field]] : [])); }
function stages(rows) {
  return Object.fromEntries(['capture_ms', 'wake_detection_ms', ...fields,
    'post_upload_first_audio_ms', 'audio_buffering_ms'].map(field => [field, distribution(rows, field)]));
}
function outcomeCounts(rows) {
  return Object.fromEntries(['completed', 'superseded', 'unconfirmed', 'cancelled', 'failed', 'unknown']
    .map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length]));
}

/** Offline JSONL only. Retains reviewed scalar measurements, never raw log records or content. */
export function createLatencyAnalysis({ maxIncidents = 100_000 } = {}) {
  const turns = new Map();
  let ignoredLines = 0;
  let acceptedEvents = 0;
  return {
    addLine(line) {
      if (typeof line !== 'string' || line.length > 65_536) { ignoredLines++; return; }
      let record;
      try { record = JSON.parse(line); } catch { ignoredLines++; return; }
      if (!record || Array.isArray(record) || !events.has(record.event)
        || typeof record.incident !== 'string' || !/^[A-F0-9]{8}$/.test(record.incident)) { ignoredLines++; return; }
      let turn = turns.get(record.incident);
      if (!turn) {
        if (turns.size >= maxIncidents) throw new Error('Latency analysis incident limit exceeded; split the input.');
        turn = { incident: record.incident, starts: 0, terminal: false, outcome: 'unknown' };
        turns.set(record.incident, turn);
      }
      acceptedEvents++;
      if (record.event === 'jarvis_agent_turn_started') turn.starts++;
      if (record.input_kind === 'voice' || record.input_kind === 'text') turn.input_kind = record.input_kind;
      if (terminal.has(record.event)) {
        turn.terminal = true;
        if (outcomes.has(record.turn_outcome)) turn.outcome = record.turn_outcome;
        if (record.event === 'jarvis_agent_turn_failed') turn.outcome = 'failed';
        if (record.event === 'jarvis_agent_turn_superseded') turn.outcome = 'superseded';
      }
      for (const field of fields) if (measured(record[field])) turn[field] = record[field];
      if (record.event === 'jarvis_voice_captured' && measured(record.capture_wait_ms)) {
        // capture_ms may be PCM duration; capture_wait_ms is elapsed capture + VAD.
        turn.capture_ms = record.capture_wait_ms;
      }
      if (record.event === 'jarvis_wake_detected' && record.followup === false && measured(record.duration_ms)) {
        turn.wake_detection_ms = record.duration_ms;
      }
      if (record.event === 'jarvis_agent_input_sent' && record.input_audio_finished === true
        && measured(record.duration_ms)) turn.input_finished_ms = record.duration_ms;
    },
    snapshot() {
      const rows = [...turns.values()].map(turn => {
        const row = { ...turn };
        if (measured(row.first_audio_ms) && measured(row.input_finished_ms) && row.first_audio_ms >= row.input_finished_ms) {
          row.post_upload_first_audio_ms = row.first_audio_ms - row.input_finished_ms;
        }
        if (measured(row.first_audio_ms) && measured(row.first_playback_ms) && row.first_playback_ms >= row.first_audio_ms) {
          row.audio_buffering_ms = row.first_playback_ms - row.first_audio_ms;
        }
        return row;
      });
      const unambiguous = rows.filter(row => row.starts === 1);
      const paired = unambiguous.filter(row => fields.every(field => measured(row[field]))
        && measured(row.post_upload_first_audio_ms));
      return {
        schema: 1, kind: 'offline_correlated_latency', accepted_events: acceptedEvents, ignored_lines: ignoredLines,
        incidents: rows.length, started_turns: unambiguous.length,
        missing_start: rows.filter(row => row.starts === 0).length,
        ambiguous_starts: rows.filter(row => row.starts > 1).length,
        terminal_turns: unambiguous.filter(row => row.terminal).length,
        outcomes: outcomeCounts(unambiguous),
        finished_upload_observed: unambiguous.filter(row => measured(row.upload_ms) && measured(row.input_finished_ms)).length,
        audio_before_upload_finished: unambiguous.filter(row => measured(row.first_audio_ms)
          && measured(row.input_finished_ms) && row.first_audio_ms < row.input_finished_ms).length,
        stages: stages(unambiguous),
        paired_queue_upload_audio_playback: { n: paired.length, outcomes: outcomeCounts(paired), stages: stages(paired) },
        turns: unambiguous.map(turn => {
          const row = { ...turn };
          delete row.starts; delete row.input_finished_ms;
          return row;
        })
          .sort((left, right) => left.incident.localeCompare(right.incident)),
      };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const analysis = createLatencyAnalysis();
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) analysis.addLine(line);
    process.stdout.write(`${JSON.stringify(analysis.snapshot(), null, 2)}\n`);
  } catch {
    // Input and exception details can contain secrets; print only the fixed failure code.
    process.stderr.write('LATENCY_ANALYSIS_FAILED\n');
    process.exitCode = 1;
  }
}

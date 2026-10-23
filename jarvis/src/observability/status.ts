/** Only reviewed counters and sampled durations are exposed; content never enters status. */
const counters = [
  'identity_creator_turns', 'identity_guest_turns', 'identity_text_turns', 'identity_voice_turns',
  'voice_turns_captured', 'voice_capture_start_debounced', 'voice_wake_activations', 'wake_rejections',
  'voice_capture_duplicates', 'voice_queue_rejected', 'questions_received', 'questions_queued',
  'voice_capture_silent_rejected', 'voice_capture_too_short_rejected', 'voice_capture_limit_rejected',
  'voice_wake_busy', 'voice_turn_rejected', 'voice_receive_errors', 'voice_decode_errors',
  'wake_checks', 'wake_queued', 'wake_rate_limited', 'wake_queue_full', 'wake_queue_timeout', 'wake_provider_errors',
  'questions_cancelled', 'turn_queue_depth', 'agent_sessions_started', 'agent_session_reused',
  'agent_user_turns_recognized', 'agent_responses_after_recognition', 'audio_chunks_received',
  'agent_input_audio_chunks', 'agent_initial_audio_discarded', 'agent_user_turn_missing',
  'agent_input_source_chunks', 'agent_input_silence_chunks',
  'agent_turns', 'agent_response_timeouts', 'agent_errors', 'audio_stream_started', 'audio_bytes_received',
  'agent_guardrail_rejections', 'agent_concurrency_rejections',
  'agent_response_received', 'agent_response_complete_received',
  'audio_chunks_played', 'audio_stream_buffer_bytes', 'playback_started', 'playback_completed', 'playback_failed',
  'agent_turns_superseded', 'turn_completion_missing', 'voice_participants_success', 'voice_participants_unavailable',
  'agent_turns_recovered', 'agent_completion_recovery_timeouts', 'agent_context_expired_sessions',
  'agent_audio_before_input_finished', 'short_memory_turns_stored', 'short_memory_unconfirmed_turns',
  'short_memory_context_injections', 'short_memory_context_empty',
  'turn_delivery_callback_failed',
  'client_tools_received', 'client_tools_started', 'client_tools_completed', 'client_tools_failed', 'search_calls',
  'search_success', 'search_missing_key', 'search_rate_limited', 'search_unavailable',
  'search_timeout', 'search_invalid_input', 'search_invalid_reply', 'search_no_sources', 'search_cancelled',
] as const;

const durations = [
  ['voice_first_pcm_ms', 'Speaking.start → primeiro PCM'], ['voice_activity_start_ms', 'Speaking.start → atividade vocal'],
  ['voice_capture_ms', 'Captura Discord + VAD'], ['voice_capture_active_ms', 'Captura antes do VAD final'],
  ['voice_end_detection_ms', 'Fim da fala (VAD)'],
  ['wake_queue_wait_ms', 'Fila do STT'], ['wake_recognition_ms', 'STT remoto'],
  ['wake_detection_ms', 'Wake total'], ['question_queue_wait_ms', 'Fila de perguntas'],
  ['agent_session_open_ms', 'Abertura ElevenAgents'], ['agent_audio_upload_ms', 'Upload PCM + silêncio'],
  ['agent_signed_url_ms', 'URL temporária ElevenAgents'], ['agent_websocket_handshake_ms', 'Handshake WebSocket'],
  ['agent_audio_negotiation_ms', 'Negociação de áudio'], ['agent_audio_prepare_ms', 'Preparação PCM conversacional'],
  ['wake_audio_prepare_ms', 'Preparação PCM do STT'], ['wake_stt_request_ms', 'Requisição do STT'],
  ['agent_input_silence_saved_ms', 'Silêncio digital adicional evitado'],
  ['agent_user_recognition_ms', 'Início do envio → reconhecimento ElevenAgents'],
  ['agent_post_upload_recognition_ms', 'Fim do envio → reconhecimento ElevenAgents'],
  ['agent_remote_first_audio_ms', 'Fim do envio → primeiro áudio'],
  ['agent_recognition_to_response_ms', 'Reconhecimento → sinal de resposta'],
  ['agent_recognition_to_first_audio_ms', 'Reconhecimento → primeiro áudio'],
  ['agent_audio_buffering_ms', 'Primeiro áudio → primeiro pacote local'],
  ['agent_end_to_end_first_playback_ms', 'Início da captura → primeiro pacote local'],
  ['agent_first_audio_ms', 'Pergunta → primeiro áudio'], ['pcm_conversion_ms', 'Conversão PCM por lote'],
  ['opus_encode_ms', 'Opus por frame'], ['agent_first_playback_ms', 'Pergunta → primeiro pacote local'],
  ['agent_playback_ms', 'Primeiro pacote local → drain'],
  ['next_question_ready_ms', 'Drain → próxima disponibilidade'], ['search_duration_ms', 'Pesquisa externa'],
  ['short_memory_prepare_ms', 'Preparação do contexto curto'],
] as const;

function finite(value: number | undefined): value is number { return typeof value === 'number' && Number.isFinite(value); }
function milliseconds(value: number): string { return value < 1 ? value.toFixed(3) : value.toFixed(1); }

/** Split only between complete rows; never truncate metric names or JSON mid-field. */
export function operationalStatus(snapshot: Record<string, number>): string[] {
  const sections = [
    ['Contadores operacionais (não estimam créditos):', counters.map(name => `${name}=${finite(snapshot[name]) ? snapshot[name] : 0}`)],
    ['Tempos locais em ms: última / média / mín / máx; n=total desde o início. Mediana, p90 e p95: até 256 amostras recentes por etapa (janela n). Sem amostras não significa latência zero.',
      durations.map(([name, label]) => {
        const count = snapshot[`${name}_samples`];
        const values = [snapshot[`${name}_last`], snapshot[name], snapshot[`${name}_min`], snapshot[`${name}_max`]];
        if (!finite(count) || count < 1 || !values.every(finite)) return `${label}: sem amostras`;
        const aggregate = `${label}: ${milliseconds(values[0]!)} / ${milliseconds(values[1]! / count)} / `
          + `${milliseconds(values[2]!)} / ${milliseconds(values[3]!)}; n=${count}`;
        const windowCount = snapshot[`${name}_window_samples`];
        const median = snapshot[`${name}_median`];
        const p90 = snapshot[`${name}_p90`];
        const p95 = snapshot[`${name}_p95`];
        if (!finite(windowCount) || !Number.isSafeInteger(windowCount) || windowCount < 1 || windowCount > 256
          || windowCount > count || !finite(median) || !finite(p90) || !finite(p95)) {
          return `${aggregate}; mediana/p90/p95: sem amostras`;
        }
        return `${aggregate}; mediana=${milliseconds(median)}; p90=${milliseconds(p90)}; p95=${milliseconds(p95)}; janela n=${windowCount}`;
      })],
  ] as const;
  const pages: string[] = [];
  for (const [heading, rows] of sections) {
    let page: string = heading;
    for (const row of rows) {
      if (page.length + row.length + 1 > 1500) { pages.push(page); page = heading; }
      page += `\n${row}`;
    }
    pages.push(page);
  }
  return pages;
}

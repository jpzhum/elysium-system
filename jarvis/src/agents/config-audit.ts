/** Read-only ElevenAgents deployment audit. Never return prompts, IDs, credentials or provider bodies. */
const VARIABLES = ['speaker_name', 'speaker_is_creator', 'active_game', 'room_context'] as const;
const EVENTS = ['audio', 'agent_response', 'agent_response_complete', 'user_transcript', 'interruption',
  'client_tool_call', 'agent_tool_request', 'agent_tool_response'] as const;
const MAX_REPLY_BYTES = 512 * 1024;
const MAX_TOOLS = 32;

export interface ToolConfigurationAudit {
  readonly registered: boolean;
  readonly unique: boolean;
  readonly client: boolean;
  readonly expects_response: boolean;
  readonly parameters_match: boolean;
  readonly mentioned_in_prompt: boolean;
}

/** Allowlisted configuration values only; missing/unknown values remain null, never assumed defaults. */
export interface TurnTakingConfigurationAudit {
  readonly turn_timeout: number | null;
  readonly silence_end_call_timeout: number | null;
  readonly turn_eagerness: 'patient' | 'normal' | 'eager' | null;
  readonly turn_model: 'turn_v2' | 'turn_v3' | null;
  readonly mode: 'turn' | 'silence' | null;
  readonly speculative_turn: boolean | null;
  readonly soft_timeout_config: {
    readonly timeout_seconds: number | null;
    readonly use_llm_generated_message: boolean | null;
  };
  readonly max_duration_seconds: number | null;
  readonly text_only: boolean | null;
  readonly vad_background_voice_detection: boolean | null;
}

export interface AgentConfigurationAudit {
  readonly status: 'ok' | 'missing_configuration' | 'invalid_identifier' | 'request_failed' | 'invalid_reply' | 'tool_limit';
  readonly scope: 'main_agent_only';
  readonly published_prompt_present: boolean;
  readonly local_prompt_present: boolean;
  readonly published_prompt_matches_local: boolean;
  /** Only line endings and outer whitespace are ignored; this does not compare semantic equivalence. */
  readonly published_prompt_matches_local_normalized: boolean;
  readonly prompt_variables: Record<typeof VARIABLES[number], boolean>;
  readonly tools: { readonly search_game_info: ToolConfigurationAudit; readonly get_voice_participants: ToolConfigurationAudit };
  readonly client_events: Record<typeof EVENTS[number], boolean>;
  readonly tool_definitions_resolved: boolean;
  readonly first_message_override_visible: boolean;
  readonly first_message_override_allowed: boolean;
  readonly published_first_message_empty: boolean;
  readonly workflow_present: boolean;
  readonly turn_taking: TurnTakingConfigurationAudit;
  /** Static references do not prove that the LLM follows them; live two-account tests are mandatory. */
  readonly runtime_behavior_verified: false;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function allowed<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && values.includes(value as T) ? value as T : null;
}

function numeric(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function turnTakingAudit(conversation: Record<string, unknown>): TurnTakingConfigurationAudit {
  const turn = record(conversation.turn);
  const softTimeout = record(turn.soft_timeout_config);
  const config = record(conversation.conversation);
  return {
    turn_timeout: numeric(turn.turn_timeout, 1, 30),
    silence_end_call_timeout: numeric(turn.silence_end_call_timeout, -1, 7200),
    turn_eagerness: allowed(turn.turn_eagerness, ['patient', 'normal', 'eager']),
    turn_model: allowed(turn.turn_model, ['turn_v2', 'turn_v3']),
    mode: allowed(turn.mode, ['turn', 'silence']),
    speculative_turn: boolean(turn.speculative_turn),
    soft_timeout_config: {
      timeout_seconds: softTimeout.timeout_seconds === -1 ? -1 : numeric(softTimeout.timeout_seconds, 0.5, 8),
      use_llm_generated_message: boolean(softTimeout.use_llm_generated_message),
    },
    max_duration_seconds: numeric(config.max_duration_seconds, 60, 7200),
    text_only: boolean(config.text_only),
    vad_background_voice_detection: boolean(record(conversation.vad).background_voice_detection),
  };
}

function toolAudit(name: string, prompt: string, tools: readonly unknown[], expected: readonly string[]): ToolConfigurationAudit {
  const matches = tools.map(record).filter((tool) => tool.name === name);
  const tool = matches[0] ?? {};
  const parameters = record(tool.parameters);
  const properties = record(parameters.properties);
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  return {
    registered: matches.length > 0,
    unique: matches.length === 1,
    client: tool.type === 'client',
    expects_response: tool.expects_response === true,
    parameters_match: parameters.type === 'object' && Object.keys(properties).length === expected.length
      && required.length === expected.length && new Set(required).size === expected.length
      && expected.every((key) => record(properties[key]).type === 'string' && required.includes(key)),
    mentioned_in_prompt: prompt.includes(name),
  };
}

/** Pure inspector: fixed field names, booleans and allowlisted settings; never returns provider text. */
export function inspectAgentConfiguration(
  payload: unknown, resolvedTools: readonly unknown[] = [], toolDefinitionsResolved = true, localPrompt?: string,
): AgentConfigurationAudit {
  const agent = record(payload);
  const conversation = record(agent.conversation_config);
  const promptConfig = record(record(conversation.agent).prompt);
  const prompt = typeof promptConfig.prompt === 'string' ? promptConfig.prompt : '';
  const localPromptPresent = typeof localPrompt === 'string' && localPrompt.trim().length > 0;
  const normalize = (value: string): string => value.replace(/\r\n?/g, '\n').trim();
  const inline = Array.isArray(promptConfig.tools) ? promptConfig.tools : [];
  const tools = [...inline, ...resolvedTools.map((tool) => record(tool).tool_config ?? tool)];
  const events = Array.isArray(record(conversation.conversation).client_events)
    ? record(conversation.conversation).client_events as unknown[] : [];
  const firstMessage = record(record(record(record(agent.platform_settings).overrides)
    .conversation_config_override).agent).first_message;
  return {
    status: Object.keys(conversation).length > 0 ? 'ok' : 'invalid_reply',
    scope: 'main_agent_only',
    published_prompt_present: prompt.length > 0,
    local_prompt_present: localPromptPresent,
    published_prompt_matches_local: prompt.length > 0 && localPromptPresent && prompt === localPrompt,
    published_prompt_matches_local_normalized: prompt.length > 0 && localPromptPresent
      && normalize(prompt) === normalize(localPrompt),
    prompt_variables: Object.fromEntries(VARIABLES.map((name) => [name,
      new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(prompt)])) as AgentConfigurationAudit['prompt_variables'],
    tools: {
      search_game_info: toolAudit('search_game_info', prompt, tools, ['game', 'query']),
      get_voice_participants: toolAudit('get_voice_participants', prompt, tools, []),
    },
    client_events: Object.fromEntries(EVENTS.map((name) => [name, events.includes(name)])) as AgentConfigurationAudit['client_events'],
    tool_definitions_resolved: toolDefinitionsResolved,
    first_message_override_visible: typeof firstMessage === 'boolean',
    first_message_override_allowed: firstMessage === true,
    published_first_message_empty: record(conversation.agent).first_message === '',
    workflow_present: Object.keys(record(record(agent.workflow).nodes)).length > 0,
    turn_taking: turnTakingAudit(conversation),
    runtime_behavior_verified: false,
  };
}

/** Static checks only. Workflows still require manual review and live acceptance. */
export function agentConfigurationChecksPassed(audit: AgentConfigurationAudit, suppressFirstMessage: boolean): boolean {
  return audit.status === 'ok' && audit.published_prompt_present && audit.tool_definitions_resolved
    && Object.values(audit.prompt_variables).every(Boolean)
    && Object.values(audit.tools).every((tool) => Object.values(tool).every(Boolean))
    && Object.values(audit.client_events).every(Boolean)
    && (suppressFirstMessage
      ? audit.first_message_override_visible && audit.first_message_override_allowed
      : audit.published_first_message_empty);
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_REPLY_BYTES || !response.body) {
    void response.body?.cancel().catch(() => { /* Provider bodies are discarded, never logged. */ });
    throw new Error('audit_request_failed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAborted: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = (): void => {
    rejectAborted?.(new Error('audit_cancelled'));
    void reader.cancel().catch(() => { /* A remote body cannot extend the local deadline. */ });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error('audit_cancelled');
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REPLY_BYTES) {
        void reader.cancel().catch(() => { /* Do not retain unbounded upstream configuration. */ });
        throw new Error('audit_reply_too_large');
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function auditAgentConfiguration(
  options: { apiKey?: string; agentId?: string; signal?: AbortSignal; localPrompt?: string }, request: typeof fetch = fetch,
): Promise<AgentConfigurationAudit> {
  const failure = (status: AgentConfigurationAudit['status']): AgentConfigurationAudit => ({
    ...inspectAgentConfiguration({}, [], false, options.localPrompt), status,
  });
  if (!options.apiKey || !options.agentId) return failure('missing_configuration');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)) return failure('invalid_identifier');
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const get = async (path: string): Promise<unknown> => readBounded(await request(`https://api.elevenlabs.io/v1/convai/${path}`, {
    method: 'GET', headers: { Accept: 'application/json', 'xi-api-key': options.apiKey! }, redirect: 'error', signal,
  }), signal);
  try {
    const agent = await get(`agents/${options.agentId}`);
    const prompt = record(record(record(record(agent).conversation_config).agent).prompt);
    const rawIds = Array.isArray(prompt.tool_ids) ? prompt.tool_ids : [];
    if (rawIds.length > MAX_TOOLS) return failure('tool_limit');
    if (rawIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) return failure('invalid_reply');
    const ids = [...new Set(rawIds as string[])];
    const tools: unknown[] = [];
    for (const id of ids) tools.push(await get(`tools/${id}`));
    return inspectAgentConfiguration(agent, tools, true, options.localPrompt);
  } catch { return failure('request_failed'); }
}

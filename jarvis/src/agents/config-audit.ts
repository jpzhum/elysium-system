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

export interface AgentConfigurationAudit {
  readonly status: 'ok' | 'missing_configuration' | 'invalid_identifier' | 'request_failed' | 'invalid_reply' | 'tool_limit';
  readonly scope: 'main_agent_only';
  readonly published_prompt_present: boolean;
  readonly prompt_variables: Record<typeof VARIABLES[number], boolean>;
  readonly tools: { readonly search_game_info: ToolConfigurationAudit; readonly get_voice_participants: ToolConfigurationAudit };
  readonly client_events: Record<typeof EVENTS[number], boolean>;
  readonly tool_definitions_resolved: boolean;
  readonly first_message_override_visible: boolean;
  readonly first_message_override_allowed: boolean;
  readonly published_first_message_empty: boolean;
  readonly workflow_present: boolean;
  /** Static references do not prove that the LLM follows them; live two-account tests are mandatory. */
  readonly runtime_behavior_verified: false;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
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

/** Pure inspector: outputs fixed field names and booleans even when upstream includes private fields. */
export function inspectAgentConfiguration(
  payload: unknown, resolvedTools: readonly unknown[] = [], toolDefinitionsResolved = true,
): AgentConfigurationAudit {
  const agent = record(payload);
  const conversation = record(agent.conversation_config);
  const promptConfig = record(record(conversation.agent).prompt);
  const prompt = typeof promptConfig.prompt === 'string' ? promptConfig.prompt : '';
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
  options: { apiKey?: string; agentId?: string; signal?: AbortSignal }, request: typeof fetch = fetch,
): Promise<AgentConfigurationAudit> {
  const failure = (status: AgentConfigurationAudit['status']): AgentConfigurationAudit => ({
    ...inspectAgentConfiguration({}), status, tool_definitions_resolved: false,
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
    return inspectAgentConfiguration(agent, tools, true);
  } catch { return failure('request_failed'); }
}

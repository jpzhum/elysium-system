import { describe, expect, test, vi } from 'vitest';
import { agentConfigurationChecksPassed, auditAgentConfiguration, inspectAgentConfiguration } from '../src/agents/config-audit.js';

const search = { type: 'client', name: 'search_game_info', expects_response: true,
  parameters: { type: 'object', required: ['game', 'query'], properties: { game: { type: 'string' }, query: { type: 'string' } } } };
const participants = { type: 'client', name: 'get_voice_participants', expects_response: true,
  parameters: { type: 'object', required: [], properties: {} } };
const agent = () => ({
  agent_id: 'private-agent', name: 'private-name', conversation_config: {
    agent: { prompt: { prompt: '{{speaker_name}} {{ speaker_is_creator }} {{active_game}} {{room_context}} '
      + 'Use search_game_info and get_voice_participants. private-prompt', tools: [search, participants] } },
    conversation: { client_events: ['audio', 'user_transcript', 'agent_response', 'agent_response_complete', 'interruption',
      'client_tool_call', 'agent_tool_request', 'agent_tool_response'] },
  }, platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true } } },
    auth: { shareable_token: 'private-secret' } },
});
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('read-only published ElevenAgents configuration audit', () => {
  test('reports references, precise tool contracts and permitted first-message suppression as booleans only', () => {
    const audit = inspectAgentConfiguration(agent());
    expect(audit.status).toBe('ok');
    expect(Object.values(audit.prompt_variables).every(Boolean)).toBe(true);
    expect(audit.tools.search_game_info).toEqual({ registered: true, unique: true, client: true, expects_response: true,
      parameters_match: true, mentioned_in_prompt: true });
    expect(audit.tools.get_voice_participants.parameters_match).toBe(true);
    expect(audit.first_message_override_allowed).toBe(true);
    expect(audit.runtime_behavior_verified).toBe(false);
    expect(agentConfigurationChecksPassed(audit, true)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/private-|shareable_token/);
  });
  test('successful GET cannot pass static readiness when prompt, tools, events or authorized greeting configuration are missing', () => {
    const audit = inspectAgentConfiguration(agent());
    const missingPrompt = inspectAgentConfiguration({ conversation_config: { agent: { prompt: { prompt: 'Hello' } } } });
    expect(missingPrompt.status).toBe('ok');
    expect(agentConfigurationChecksPassed(missingPrompt, true)).toBe(false);
    expect(agentConfigurationChecksPassed({ ...audit, tool_definitions_resolved: false }, true)).toBe(false);
    expect(agentConfigurationChecksPassed({ ...audit, first_message_override_allowed: false }, true)).toBe(false);
    expect(agentConfigurationChecksPassed({ ...audit, client_events: { ...audit.client_events, client_tool_call: false } }, true)).toBe(false);
    expect(agentConfigurationChecksPassed(audit, false)).toBe(false);
    expect(agentConfigurationChecksPassed({ ...audit, first_message_override_allowed: false,
      published_first_message_empty: true }, false)).toBe(true);
  });
  test('distinguishes variable references in system prompt from unused defaults or first message', () => {
    const payload = { conversation_config: { agent: { first_message: '{{speaker_name}}',
      dynamic_variables: { dynamic_variable_placeholders: { speaker_name: 'unused' } }, prompt: { prompt: 'Hello' } } } };
    const audit = inspectAgentConfiguration(payload);
    expect(audit.prompt_variables.speaker_name).toBe(false);
    expect(audit.first_message_override_visible).toBe(false);
    expect(audit.tools.search_game_info.registered).toBe(false);
  });
  test.each([
    { ...search, type: 'webhook' }, { ...search, expects_response: false },
    { ...search, parameters: { ...search.parameters, required: ['game'] } },
    { ...search, parameters: { ...search.parameters, properties: { game: { type: 'number' }, query: { type: 'string' } } } },
    { ...search, name: 'Search_Game_Info' },
  ])('detects provider contract mismatch without echoing configuration: %j', (tool) => {
    const payload = agent();
    payload.conversation_config.agent.prompt.tools = [tool, participants] as typeof payload.conversation_config.agent.prompt.tools;
    expect(Object.values(inspectAgentConfiguration(payload).tools.search_game_info).every(Boolean)).toBe(false);
  });
  test('duplicate tool names and workflow scope cannot imply an end-to-end verified deployment', () => {
    const payload = { ...agent(), workflow: { nodes: { private_node: { additional_prompt: 'private-content' } } } };
    payload.conversation_config.agent.prompt.tools.push(search);
    const audit = inspectAgentConfiguration(payload);
    expect(audit.tools.search_game_info.unique).toBe(false);
    expect(audit.workflow_present).toBe(true);
    expect(audit.scope).toBe('main_agent_only');
    expect(audit.runtime_behavior_verified).toBe(false);
  });
  test('fetches only fixed-origin GET configuration and referenced tool definitions, never mutates agent', async () => {
    const payload = agent();
    const prompt = payload.conversation_config.agent.prompt as Record<string, unknown>;
    delete prompt.tools;
    prompt.tool_ids = ['search_id', 'participants_id'];
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(payload))
      .mockResolvedValueOnce(reply({ id: 'search_id', tool_config: search }))
      .mockResolvedValueOnce(reply({ id: 'participants_id', tool_config: participants }));
    const audit = await auditAgentConfiguration({ apiKey: 'private-api-key', agentId: 'agent_valid' }, request);
    expect(audit.tools.search_game_info.parameters_match).toBe(true);
    expect(audit.tools.get_voice_participants.expects_response).toBe(true);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.elevenlabs.io/v1/convai/agents/agent_valid',
      'https://api.elevenlabs.io/v1/convai/tools/search_id',
      'https://api.elevenlabs.io/v1/convai/tools/participants_id',
    ]);
    expect(request.mock.calls.every(([, options]) => options?.method === 'GET' && options.redirect === 'error')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('private-api-key');
  });
  test('missing credentials or invalid identifiers never perform network access', async () => {
    const request = vi.fn<typeof fetch>();
    expect((await auditAgentConfiguration({}, request)).status).toBe('missing_configuration');
    expect((await auditAgentConfiguration({ apiKey: 'key', agentId: '../other?secret' }, request)).status).toBe('invalid_identifier');
    expect(request).not.toHaveBeenCalled();
  });
  test.each(['error', 'oversize_header', 'oversize_stream', 'invalid_json', 'unsafe_tool_id', 'too_many_tools'])(
    'upstream %s remains bounded and cannot leak private errors', async (scenario) => {
      const payload = agent();
      const prompt = payload.conversation_config.agent.prompt as Record<string, unknown>;
      if (scenario === 'unsafe_tool_id') prompt.tool_ids = ['../credentials'];
      if (scenario === 'too_many_tools') prompt.tool_ids = Array.from({ length: 33 }, (_, i) => `tool_${i}`);
      const request = vi.fn<typeof fetch>();
      if (scenario === 'error') request.mockRejectedValue(new Error('private-key signed-url private-profile'));
      else if (scenario === 'oversize_header') request.mockResolvedValue(new Response('private-body', { headers: { 'content-length': '9999999' } }));
      else if (scenario === 'oversize_stream') request.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
      else if (scenario === 'invalid_json') request.mockResolvedValue(new Response('private-bad-json'));
      else request.mockResolvedValue(reply(payload));
      const audit = await auditAgentConfiguration({ apiKey: 'private-key', agentId: 'agent_valid' }, request);
      expect(audit.status).not.toBe('ok');
      expect(audit.tool_definitions_resolved).toBe(false);
      expect(JSON.stringify(audit)).not.toMatch(/private-|credentials/);
      expect(request).toHaveBeenCalledOnce();
    },
  );
  test('aborting a stalled response ends the audit without retaining provider body', async () => {
    const abort = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() { /* No provider bytes. */ } })));
    const pending = auditAgentConfiguration({ apiKey: 'key', agentId: 'agent_valid', signal: abort.signal }, request);
    await Promise.resolve();
    abort.abort();
    expect((await pending).status).toBe('request_failed');
  });
});

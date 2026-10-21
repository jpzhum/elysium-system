import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchGameInfo } from '../src/tools/game-search.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('game search', () => {
  it('admits missing credentials without making any request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const result = await searchGameInfo('Arc Raiders', 'onde fica a missão?');
    expect(result.sources).toEqual([]);
    expect(result.uncertainty).toContain('não configurada');
    expect(request).not.toHaveBeenCalled();
  });

  it('queries only the fixed Brave endpoint and labels source snippets as unverified', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ web: { results: [
      { title: '<b>Mission</b>', url: 'https://example.com/game', description: 'Um trecho de pesquisa.' },
      { title: 'Duplicate', url: 'https://example.com/game', description: 'Outro trecho.' },
      { title: 'Bad URL', url: 'javascript:alert(1)', description: 'Ignore.' },
    ] } })));
    vi.stubGlobal('fetch', request);
    const result = await searchGameInfo('Arc Raiders', 'missão da sala', 'key-secret');
    const endpoint = new URL(String(request.mock.calls[0]?.[0]));
    expect(endpoint.origin + endpoint.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(endpoint.searchParams.get('q')).toBe('Arc Raiders missão da sala');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { 'X-Subscription-Token': 'key-secret' }, redirect: 'error' });
    expect(result.sources).toEqual([{ title: 'Mission', url: 'https://example.com/game', snippet: 'Um trecho de pesquisa.' }]);
    expect(result.answer).toBe('[1] Um trecho de pesquisa.');
    expect(result.uncertainty).toContain('não foram abertas');
    expect(new Date(result.checked_at).toISOString()).toBe(result.checked_at);
  });

  it('bounds queries and refuses invalid input before external requests', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const result = await searchGameInfo('Game', 'x'.repeat(501), 'secret');
    expect(result.sources).toEqual([]);
    expect(result.query.length).toBe(500);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])('sanitizes HTTP %s errors and does not invent sources', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private provider body and key-secret', { status })));
    const result = await searchGameInfo('Game', 'quest', 'key-secret');
    expect(result.sources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('key-secret');
    expect(JSON.stringify(result)).not.toContain('private provider body');
    expect(result.answer).toContain('Não foi possível verificar');
  });

  it('cancels before fetch and bounds oversized reply bodies', async () => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', request);
    const controller = new AbortController();
    controller.abort();
    expect((await searchGameInfo('Game', 'quest', 'secret', controller.signal)).sources).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response('x'.repeat(300_000)));
    const result = await searchGameInfo('Game', 'quest', 'secret');
    expect(result.sources).toEqual([]);
    expect(result.uncertainty).toContain('falhou');
  });

  it('cancels a pending streamed body promptly even if upstream cancellation stalls', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn(() => new Promise<void>(() => { /* Upstream never finishes cancellation. */ }));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const pending = searchGameInfo('Game', 'quest', 'secret', controller.signal);
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort();
    const result = await pending;
    expect(result.sources).toEqual([]);
    expect(result.uncertainty).toContain('cancelada');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('does not wait for an error body or copy provider error messages into its result', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => { /* Untrusted cancellation cannot block the result. */ }),
    }), { status: 429 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await searchGameInfo('Game', 'quest', 'secret');
    expect(result.sources).toEqual([]);
    expect(result.uncertainty).toContain('limite');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

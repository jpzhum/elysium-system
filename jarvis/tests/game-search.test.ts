import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameSearch, searchGameInfo } from '../src/tools/game-search.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('game search', () => {
  it('admits missing credentials without making any request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const result = await searchGameInfo('Arc Raiders', 'onde fica a missão?');
    expect(result.status).toBe('missing_key');
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
    expect(result.status).toBe('success');
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
    expect(result.answer).toBe('Não consegui concluir a pesquisa desta vez, senhor. Posso tentar novamente.');
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

  it('cancels the body when caller abort lands between headers and body-reader setup', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn(() => new Promise<void>(() => { /* Remote cancellation never settles. */ }));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    vi.stubGlobal('fetch', vi.fn(() => {
      const request = Promise.resolve(response);
      void request.then(() => queueMicrotask(() => controller.abort()));
      return request;
    }));
    const result = await searchGameInfo('Game', 'quest', 'secret', controller.signal);
    expect(result.status).toBe('cancelled');
    expect(result.sources).toEqual([]);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
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

  it('strips signed queries and fragments, rejects URL credentials and redacts reflected credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ web: { results: [
      { title: 'Page', url: 'https://example.com/game?token=private-token#credential', description: 'Read key-secret.' },
      { title: 'Dup', url: 'https://example.com/game?signature=other', description: 'Read duplicate.' },
      { title: 'Userinfo', url: 'https://user:password@example.com/x', description: 'Read.' },
      { title: 'Reflected key', url: 'https://example.com/key-secret', description: 'Read.' },
    ] } })));
    vi.stubGlobal('fetch', request);
    const result = await searchGameInfo('Game', 'quest', 'key-secret');
    expect(result.status).toBe('success');
    expect(result.sources).toEqual([{ title: 'Page', url: 'https://example.com/game', snippet: 'Read [redacted].' }]);
    expect(JSON.stringify(result)).not.toMatch(/private-token|credential|password|key-secret/);
    expect(request).toHaveBeenCalledOnce(); // Source pages are never opened.
  });

  it('bounds worker concurrency and start rate without retaining queued queries', async () => {
    vi.useFakeTimers();
    let resolve: ((response: Response) => void) | undefined;
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', request);
    const diagnostics = vi.fn();
    const search = createGameSearch({ apiKey: 'key-secret', onDiagnostic: diagnostics });
    const first = search('Game', 'private-query');
    expect((await search('Other game', 'other private query')).status).toBe('rate_limited');
    await vi.advanceTimersByTimeAsync(1100);
    expect((await search('Other game', 'still busy')).status).toBe('rate_limited');
    resolve?.(new Response(JSON.stringify({ web: { results: [
      { title: 'Guide', url: 'https://example.com/a', description: 'Evidence.' },
    ] } })));
    expect((await first).status).toBe('success');
    request.mockResolvedValue(new Response('{}'));
    expect((await search('Game', 'next')).status).toBe('no_sources');
    expect((await search('Game', 'too soon')).status).toBe('rate_limited');
    expect(request).toHaveBeenCalledTimes(2);
    expect(diagnostics.mock.calls[2]?.[0]).toEqual({ status: 'success', durationMs: 1100, sourceCount: 1 });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/key-secret|private-query|example.com|Evidence/);
  });

  it('honors Brave quota windows and bounded 429 cooldown without automatic retries', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream body', {
      status: 429, headers: { 'x-ratelimit-remaining': '0, 0', 'x-ratelimit-reset': '1, 99999999', 'retry-after': '10' },
    }));
    vi.stubGlobal('fetch', request);
    const search = createGameSearch({ apiKey: 'secret' });
    expect((await search('Game', 'quest')).status).toBe('rate_limited');
    await vi.advanceTimersByTimeAsync(119_999);
    expect((await search('Game', 'quest')).status).toBe('rate_limited');
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    request.mockResolvedValue(new Response('{}'));
    expect((await search('Game', 'quest')).status).toBe('no_sources');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not spend a worker slot on cancellation, invalid input or missing credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', request);
    const abort = new AbortController();
    abort.abort();
    const search = createGameSearch({ apiKey: 'secret' });
    expect((await search('Game', 'quest', abort.signal)).status).toBe('cancelled');
    expect((await search('', 'quest')).status).toBe('invalid_input');
    expect((await createGameSearch({})('Game', 'quest')).status).toBe('missing_key');
    expect((await search('Game', 'quest')).status).toBe('no_sources');
    expect(request).toHaveBeenCalledOnce();
  });

  it('classifies invalid replies and network exceptions without provider text', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('not json key-secret'));
    vi.stubGlobal('fetch', request);
    expect((await searchGameInfo('Game', 'quest', 'key-secret')).status).toBe('invalid_reply');
    request.mockRejectedValue(new Error('key-secret private network details'));
    const result = await searchGameInfo('Game', 'quest', 'key-secret');
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('key-secret');
  });

  it('bounds the serialized UTF-8 result below the client-tool transport budget', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ web: { results:
      Array.from({ length: 5 }, (_value, index) => ({ title: '漢'.repeat(160),
        url: `https://example.com/${index}/${'a'.repeat(1900)}`, description: '漢'.repeat(600) })),
    } }))));
    const result = await searchGameInfo('Game', 'quest', 'key-secret');
    expect(result.status).toBe('success');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThan(5);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(14 * 1024);
  });

  it('uses a five-second total deadline across delayed headers and a stalled body, then releases the slot', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn(() => new Promise<void>(() => { /* Remote cancel never settles. */ }));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(response), 3500);
    }));
    vi.stubGlobal('fetch', request);
    const diagnostics = vi.fn();
    const search = createGameSearch({ apiKey: 'secret', onDiagnostic: diagnostics });
    const pending = search('Game', 'quest');
    const signal = request.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(3500);
    expect(response.body?.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('timeout');
    expect(result.sources).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith({ status: 'timeout', durationMs: 5000, sourceCount: 0 });
    expect(request).toHaveBeenCalledOnce(); // No retries consume another deadline.
    request.mockResolvedValue(new Response('{}'));
    expect((await search('Game', 'next')).status).toBe('no_sources');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts stalled headers within the configured deadline and discards late responses', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', request);
    const search = createGameSearch({ apiKey: 'secret', timeoutMs: 2500 });
    const pending = search('Game', 'quest');
    const signal = request.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(2499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    complete(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    request.mockResolvedValue(new Response('{}'));
    expect((await search('Game', 'next')).status).toBe('no_sources');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending headers immediately on caller abort and frees the slot without a retry', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => { /* Transport stalls. */ }));
    vi.stubGlobal('fetch', request);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const search = createGameSearch({ apiKey: 'secret' });
    const pending = search('Game', 'quest', controller.signal);
    const signal = request.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValue(new Response('{}'));
    expect((await search('Game', 'next')).status).toBe('no_sources');
    expect(vi.getTimerCount()).toBe(0);
  });
});

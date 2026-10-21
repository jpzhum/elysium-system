/** Bound bytes and read time even for chunked responses and noncooperative peers. */
export async function limitedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > limit || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('provider_reply_limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    rejectAbort(new Error('provider_cancelled'));
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error('provider_cancelled');
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new Error('provider_reply_limit');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export const abortError = (message = '本次查询已取消。') =>
  new DOMException(message, 'AbortError');
export const isAbort = (error) => error?.name === 'AbortError';

// A completion can update the editor only while it owns the current token.
export class SessionGate {
  generation = 0;
  controller = null;
  begin() {
    this.cancel();
    this.controller = new AbortController();
    return { generation: this.generation, signal: this.controller.signal };
  }
  current(token) {
    return token?.generation === this.generation && !token.signal.aborted;
  }
  cancel() {
    this.controller?.abort(abortError());
    this.controller = null;
    this.generation++;
  }
}
export const editorSession = new SessionGate();

export function requestBudget(signal, timeoutMs, now = Date.now) {
  const controller = new AbortController(),
    deadline = now() + timeoutMs;
  const relay = () => controller.abort(signal.reason || abortError());
  if (signal?.aborted) relay();
  else signal?.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(
    () => controller.abort(abortError('查询时间已用完，已保留当前结果。')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - now()),
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    },
  };
}

// Draft writes are serialized so an earlier debounce cannot overwrite a newer edit.
export class DraftJournal {
  constructor(save, initial = {}, onError = () => {}) {
    this.save = save;
    this.meta = {
      id: initial.id || crypto.randomUUID(),
      revision: initial.revision || 0,
    };
    this.onError = onError;
    this.pending = null;
    this.serial = 0;
    this.chain = Promise.resolve();
    this.closed = false;
  }
  schedule(payload, delay = 400) {
    if (this.closed) return;
    this.pending = { payload: structuredClone(payload), serial: ++this.serial };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(this.onError), delay);
  }
  async flush() {
    clearTimeout(this.timer);
    const entry = this.pending;
    this.pending = null;
    if (entry && !this.closed) {
      this.chain = this.chain
        .catch(() => {})
        .then(async () => {
          try {
            const result = await this.save({ ...entry.payload, ...this.meta });
            this.meta = { id: result.id, revision: result.revision };
          } catch (error) {
            if (entry.serial === this.serial) this.pending ||= entry;
            throw error;
          }
        });
    }
    await this.chain;
    return { ...this.meta };
  }
  finish() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending = null;
  }
}

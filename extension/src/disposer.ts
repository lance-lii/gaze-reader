/**
 * Collects teardown work so a session can release every listener, timer and
 * animation frame it created with one `dispose()` call.
 */
export class Disposer {
  private readonly fns: (() => void)[] = [];
  private disposedFlag = false;

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** Registers cleanup work. Runs immediately if already disposed. */
  add(fn: () => void): void {
    if (this.disposedFlag) {
      safely(fn);
      return;
    }
    this.fns.push(fn);
  }

  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  listen(target: EventTarget, type: string, handler: (e: Event) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, handler: (e: never) => void, opts?: AddEventListenerOptions): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, opts);
    this.add(() => target.removeEventListener(type, h, opts));
  }

  timeout(fn: () => void, ms: number): () => void {
    const id = setTimeout(fn, ms);
    const cancel = () => clearTimeout(id);
    this.add(cancel);
    return cancel;
  }

  interval(fn: () => void, ms: number): () => void {
    const id = setInterval(fn, ms);
    const cancel = () => clearInterval(id);
    this.add(cancel);
    return cancel;
  }

  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    // Reverse order: things created last are torn down first.
    for (const fn of this.fns.splice(0).reverse()) safely(fn);
  }
}

/** A trailing-edge debounce whose pending call is cancelled by the disposer. */
export function debounce(disposer: Disposer, fn: () => void, ms: number): { (): void; cancel(): void } {
  let id: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (id !== null) clearTimeout(id);
    id = null;
  };
  disposer.add(cancel);
  const run = () => {
    cancel();
    id = setTimeout(() => {
      id = null;
      if (!disposer.disposed) fn();
    }, ms);
  };
  return Object.assign(run, { cancel });
}

/**
 * Runs `fn` at most once per `ms`, on the trailing edge, however often it is
 * called (a MutationObserver on a page with a live ticker fires constantly;
 * a debounce would starve).
 */
export function throttle(disposer: Disposer, fn: () => void, ms: number): () => void {
  let id: ReturnType<typeof setTimeout> | null = null;
  disposer.add(() => {
    if (id !== null) clearTimeout(id);
    id = null;
  });
  return () => {
    if (id !== null || disposer.disposed) return;
    id = setTimeout(() => {
      id = null;
      if (!disposer.disposed) fn();
    }, ms);
  };
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[gaze-reader] cleanup failed', err);
  }
}

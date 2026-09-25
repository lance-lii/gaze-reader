import type { AppEvents, EventBus, EventName, Unsubscribe } from '../types';

type Handler = (payload: never) => void;

/**
 * Tiny typed pub/sub. A throwing listener is logged and isolated so one bad
 * subscriber can never stall the gaze pipeline.
 */
export function createEventBus(): EventBus {
  const handlers = new Map<EventName, Set<Handler>>();

  function on<K extends EventName>(type: K, cb: (payload: AppEvents[K]) => void): Unsubscribe {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(cb as Handler);
    return () => {
      handlers.get(type)?.delete(cb as Handler);
    };
  }

  function once<K extends EventName>(type: K, cb: (payload: AppEvents[K]) => void): Unsubscribe {
    const off = on(type, (payload) => {
      off();
      cb(payload);
    });
    return off;
  }

  function emit<K extends EventName>(type: K, payload: AppEvents[K]): void {
    const set = handlers.get(type);
    if (!set || set.size === 0) return;
    // Copy so listeners may unsubscribe during dispatch.
    for (const h of [...set]) {
      try {
        (h as (p: AppEvents[K]) => void)(payload);
      } catch (err) {
        console.error(`[events] listener for "${type}" threw`, err);
      }
    }
  }

  function clear(): void {
    handlers.clear();
  }

  return { on, once, emit, clear };
}

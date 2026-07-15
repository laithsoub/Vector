// ─── Global cancellable-task registry ───────────────────────────────────────
// A tiny app-wide store of in-flight async operations. Any component can wrap a
// long op with `runTask(label, signal => …)`; the returned AbortSignal cancels
// the real HTTP/stream when the user hits Cancel in the floating dock. Framework
// -agnostic (module singleton) so it's reachable from anywhere without prop
// drilling — the dock subscribes via useSyncExternalStore.

export interface ActiveTask {
  id:        string;
  label:     string;
  controller: AbortController;
  startedAt: number;
}

let tasks: ActiveTask[] = [];
const listeners = new Set<() => void>();

function emit() {
  // New array identity each change so useSyncExternalStore sees the update.
  listeners.forEach(l => l());
}

export function subscribeTasks(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getTasks(): ActiveTask[] {
  return tasks;
}

/** True when the thrown error is an abort/cancel (fetch AbortError or axios cancel). */
export function isCancel(e: any): boolean {
  return !!e && (
    e.name === 'AbortError' ||
    e.name === 'CanceledError' ||
    e.code === 'ERR_CANCELED' ||
    e.message === 'canceled'
  );
}

/**
 * Register a cancellable task, run `fn` with its AbortSignal, and always
 * deregister when it settles. Aborting removes it from the dock and rejects
 * `fn` with a cancel error (swallow it with `isCancel`).
 */
export async function runTask<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  tasks = [...tasks, { id, label, controller, startedAt: Date.now() }];
  emit();
  try {
    return await fn(controller.signal);
  } finally {
    tasks = tasks.filter(t => t.id !== id);
    emit();
  }
}

export function cancelTask(id: string) {
  const t = tasks.find(x => x.id === id);
  if (t) { try { t.controller.abort(); } catch {} }
}

export function cancelAll() {
  tasks.forEach(t => { try { t.controller.abort(); } catch {} });
}

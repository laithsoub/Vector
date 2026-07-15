// ─── Floating global Cancel dock ────────────────────────────────────────────
// Shows every in-flight cancellable task (registered via runTask) with a per-
// task Cancel and a Cancel-all when several run at once. Mounted once at the app
// root; subscribes to the task registry so it appears/disappears automatically.
import React, { useSyncExternalStore } from 'react';
import { Loader2, X } from 'lucide-react';
import { subscribeTasks, getTasks, cancelTask, cancelAll } from '../lib/tasks';

export function CancelDock() {
  const tasks = useSyncExternalStore(subscribeTasks, getTasks, getTasks);
  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9996] flex flex-col items-stretch gap-1.5 w-[300px] max-w-[90vw]">
      {tasks.map(t => (
        <div
          key={t.id}
          className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/95 dark:bg-ink-900/95 backdrop-blur ring-1 ring-inset ring-ink-200 dark:ring-ink-700 shadow-lg animate-fade-up">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500 shrink-0" />
          <span className="text-[12px] text-ink-700 dark:text-ink-200 truncate flex-1">{t.label}</span>
          <button
            onClick={() => cancelTask(t.id)}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-medium text-ink-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <X className="w-3 h-3" /> Cancel
          </button>
        </div>
      ))}
      {tasks.length > 1 && (
        <button
          onClick={cancelAll}
          className="self-center mt-0.5 px-3 py-1 rounded-lg text-[11px] font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
          Cancel all ({tasks.length})
        </button>
      )}
    </div>
  );
}

// ─── Floating global Cancel dock ────────────────────────────────────────────
// Shows every in-flight cancellable task (registered via runTask) with a per-
// task Cancel and a Cancel-all when several run at once. Mounted once at the app
// root; subscribes to the task registry so it appears/disappears automatically.
import React, { useSyncExternalStore } from 'react';
import { Loader2, X } from 'lucide-react';
import { subscribeTasks, getTasks, cancelTask, cancelAll } from '../lib/tasks';
import { Button as UiButton } from '../ui';

export function CancelDock() {
  const tasks = useSyncExternalStore(subscribeTasks, getTasks, getTasks);
  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-modal flex flex-col items-stretch gap-1.5 w-72 max-w-[90vw]">
      {tasks.map(t => (
        <div
          key={t.id}
          className="flex items-center gap-2.5 px-3 py-2 rounded-panel bg-raised ring-1 ring-inset ring-line-2 shadow-float animate-fade-up">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-ai shrink-0" />
          <span className="text-sm text-fg-2 truncate flex-1">{t.label}</span>
          <UiButton tone="quiet-danger" className="shrink-0" onClick={() => cancelTask(t.id)}>
            <X className="w-3 h-3" /> Cancel
          </UiButton>
        </div>
      ))}
      {tasks.length > 1 && (
        <UiButton tone="quiet-danger" className="self-center mt-0.5" onClick={cancelAll}>
          Cancel all ({tasks.length})
        </UiButton>
      )}
    </div>
  );
}

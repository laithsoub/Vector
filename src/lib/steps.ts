// The job log still stores 'Step 1' / 'Step 2' (older rows and the analytics
// buckets are keyed on them); these are the names the UI shows instead.
export const STEP_LABEL: Record<string, string> = {
  'Step 1': 'SharePoint List',
  'Step 2': 'D&Q Store',
};

export const stepLabel = (step: string) => STEP_LABEL[step] ?? step;

/** Tally a Python upload script prints as `__SUMMARY__:{...}`. */
export type UploadSummary = { uploaded: number; skipped?: number; failed: number };

/** Collect the lines of a streamed run that the toast needs. */
export function runLog() {
  let firstErr = '';
  let summary: UploadSummary | null = null;
  return {
    onLine(l: string) {
      if (l.startsWith('__SUMMARY__:')) {
        try { summary = JSON.parse(l.slice('__SUMMARY__:'.length)); } catch {}
      } else if (!firstErr && l.includes('[ERR]')) {
        // The first error is the cause; later ones are "nothing uploaded" echoes.
        firstErr = l.replace(/^\s*\[ERR\]\s*(\[\d+\/\d+\]\s*)?/, '').trim();
      }
    },
    get firstErr() { return firstErr; },
    get summary() { return summary; },
  };
}

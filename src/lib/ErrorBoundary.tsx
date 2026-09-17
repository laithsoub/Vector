// ─── Tab error boundary ──────────────────────────────────────────────────────
// Vector runs as a single WebView2 window, so an uncaught render error does not
// cost a reload the way it would in a browser tab — it blanks the whole app and
// the only way out is closing it. One boundary per tab keeps the damage to the
// screen that broke: the rail, the header and every other tab stay usable.
import React from 'react';

interface Props {
  /** The tab this wraps, named as the user sees it. Used in the message. */
  label: string;
  children: React.ReactNode;
}
interface State { error: Error | null }

export class TabErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The stack is the only record of this — nothing else logs it.
    console.error(`[${this.props.label}] render failed:`, error, info.componentStack);
  }

  // Remounting the subtree is usually enough: most crashes here come from one bad
  // piece of state, and the tab rebuilds from what the server still has.
  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return <>{this.props.children}</>;

    return (
      <div className="p-6 w-full">
        <div className="max-w-xl rounded-xl bg-surface ring-1 ring-inset ring-err-line p-5 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-err ">
              The {this.props.label} tab stopped
            </p>
            <p className="text-sm text-fg-2">
              The rest of Vector is still running — switch tabs, or try this one again.
            </p>
          </div>

          <pre className="text-xs mono text-fg-3 bg-subtle rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-40">
            {error.message || String(error)}
          </pre>

          <div className="flex gap-2">
            <button
              onClick={this.retry}
              className="h-8 px-3 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-hover text-on-accent transition-colors">
              Try this tab again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="h-8 px-3 rounded-lg text-sm font-medium ring-1 ring-inset ring-line-2 hover:bg-subtle transition-colors">
              Reload Vector
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// ─── PMO page — wired to /api/run/pmo and /api/pmo/download ──────────────────
import React, { useState, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  FileUp, CheckCircle2, X, Loader2, Upload, FolderOpen,
  ClipboardList, Download, Copy, ChevronRight,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, Pill, Button } from '../lib/ui';
import { confirmAsync } from '../lib/notify';
import { failed } from '../lib/errors';
import type { ToastFn } from '../App';

export function PmoPage({ toast }: { toast: ToastFn }) {
  return (
    <ErrorBoundary toast={toast}>
      <PmoForm toast={toast} />
    </ErrorBoundary>
  );
}

// ─── PMO Form ────────────────────────────────────────────────────────────────
function PmoForm({ toast }: { toast: ToastFn }) {
  const [quotePdf, setQuotePdf] = useState<File | null>(null);
  const [poPdf,    setPoPdf]    = useState<File | null>(null);
  const [docuPdfs, setDocuPdfs] = useState<(File | null)[]>([null]);
  const [seqOverride, setSeqOverride] = useState('CBU');

  const [running, setRunning] = useState(false);
  const [lines,   setLines]   = useState<string[]>([]);
  const [done,    setDone]    = useState<boolean | null>(null);
  const [dlId,    setDlId]    = useState('');
  const [dlName,  setDlName]  = useState('');
  const [emailData, setEmailData] = useState<Record<string,string>>({});
  const [copied,    setCopied]    = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [folder,    setFolder]    = useState('');
  const [folderAvailable, setFolderAvailable] = useState<boolean | null>(null);

  // Where a checked PMO gets filed, and whether that drive is up right now.
  useEffect(() => {
    fetch('/api/pmo/folder').then(r => r.json())
      .then(d => { setFolder(d.folder || ''); setFolderAvailable(!!d.available); })
      .catch(() => setFolderAvailable(null));
  }, []);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const allReady = !!quotePdf && !!poPdf && docuPdfs.some(f => !!f);

  async function run() {
    if (!allReady || running) return;
    setRunning(true); setLines([]); setDone(null);
    setDlId(''); setDlName(''); setEmailData({}); setCopied(false);
    setSaved(false); setSavedPath('');

    const fd = new FormData();
    fd.append('quote_pdf', quotePdf!);
    fd.append('po_pdf',    poPdf!);
    docuPdfs.forEach((f, i) => { if (f) fd.append(`docu_pdf_${i}`, f); });
    if (seqOverride.trim() && seqOverride.trim() !== 'CBU') fd.append('seq_override', seqOverride.trim());

    const allLines: string[] = [];
    try {
      const resp = await fetch('/api/run/pmo', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop()!;
        for (const p of parts) {
          const txt = p.startsWith('data: ') ? p.slice(6) : p.trim();
          if (!txt) continue;
          if (txt.startsWith('__DOCX_ID__:')) {
            const rest = txt.slice('__DOCX_ID__:'.length);
            const colon = rest.indexOf(':');
            setDlId(rest.slice(0, colon));
            setDlName(rest.slice(colon + 1));
          } else if (txt === '__DONE_OK__') {
            setDone(true);
            toast('ok', 'PMO document ready — check it before filing');
            // Parse email fields from log lines
            const fields: Record<string,string> = {};
            for (const line of allLines) {
              const m = line.match(/^\[OK\]\s+(\w+):\s+(.+)$/);
              if (m) fields[m[1]] = m[2].trim();
            }
            setEmailData(fields);
          } else if (txt === '__DONE_ERR__') {
            setDone(false); toast('err', failed('build the PMO document', 'see the log below for the failing step'));
          } else {
            allLines.push(txt);
            setLines(prev => [...prev, txt]);
          }
        }
      }
    } catch (e: any) {
      setLines(prev => [...prev, `[ERR] ${e.message}`]);
      setDone(false);
      toast('err', failed('build the PMO document', e));
    }
    setRunning(false);
  }

  // Copy the finished document into the shared PMO folder. Never automatic —
  // the whole point is that you check it first, then file it.
  async function saveToFolder(overwrite: boolean) {
    setSaving(true);
    try {
      const resp = await fetch(`/api/pmo/save/${dlId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 409 && data.exists) {
        if (await confirmAsync({
          title: 'File already exists',
          message: `A file with that name is already in the PMO folder:\n\n${data.path}\n\nReplace it?`,
          confirmLabel: 'Replace file', danger: true,
        })) {
          setSaving(false);
          return saveToFolder(true);
        }
      } else if (!resp.ok) {
        throw new Error(data.error || `${resp.status}`);
      } else {
        setSaved(true);
        setSavedPath(data.path);
        toast('ok', `Saved to the PMO folder as ${dlName || 'PMO.docx'}`);
      }
    } catch (e: any) {
      toast('err', failed('save the document to the PMO folder', e));
    }
    setSaving(false);
  }

  async function downloadDocx() {
    try {
      const resp = await fetch(`/api/pmo/download/${dlId}`);
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url; a.download = dlName || 'PMO.docx';
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
    } catch (e: any) {
      toast('err', failed(`download ${dlName || 'the PMO document'}`, e));
    }
  }

  // Extracted rows for results table
  const rowKeys = Object.keys(emailData)
    .filter(k => k === 'CatRef' || /^CatRef\d+$/.test(k))
    .sort((a, b) => {
      const na = a === 'CatRef' ? 0 : parseInt(a.replace('CatRef',''));
      const nb = b === 'CatRef' ? 0 : parseInt(b.replace('CatRef',''));
      return na - nb;
    });

  const bodyText = `Hi All,

PMO checked, please see attached document.

If you have any questions, please let me know.

Best,`;

  return (
    <div className="grid grid-cols-12 gap-[22px]">
      {/* Left — inputs */}
      <div className="col-span-12 lg:col-span-5 space-y-[22px]">
        <Card>
          <div className="mb-4">
            <h2 className="text-[13px] font-semibold tracking-tight">Raise PMO</h2>
            <p className="text-[11.5px] text-[var(--t3)] mt-1">Upload quote, DOCU and PO. Returns filled Word document.</p>
          </div>

          <div className="space-y-2">
            <PdfSlot label="Quote PDF" sub="SR… / QB… / EU… — main source of data"
                     file={quotePdf} onFile={setQuotePdf} />

            {docuPdfs.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <PdfSlot
                    label={`DOCU_ID PDF${docuPdfs.length > 1 ? ` #${i + 1}` : ''}`}
                    sub="DOCU_id — for NTP, ACP and Cat Ref"
                    file={f}
                    onFile={file => setDocuPdfs(prev => prev.map((x, j) => j === i ? file : x))}
                  />
                </div>
                {docuPdfs.length > 1 && (
                  <button aria-label="Remove this document" onClick={() => setDocuPdfs(prev => prev.filter((_, j) => j !== i))}
                    className="p-1.5 rounded-md text-[var(--t3)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}

            <div className="flex items-center gap-3 mt-1 pt-1">
              <button onClick={() => setDocuPdfs(prev => [...prev, null])}
                className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent-text)] hover:text-[var(--accent-text)]">
                <Upload className="w-3 h-3" /> Add one
              </button>
              <span className="text-[var(--t4)]">|</span>
              <label className="flex items-center gap-1 text-[11px] font-medium text-[var(--accent-text)] hover:text-[var(--accent-text)] cursor-pointer">
                <FolderOpen className="w-3 h-3" />
                Bulk upload ({docuPdfs.filter(Boolean).length} loaded)
                <input type="file" accept=".pdf" multiple className="hidden"
                  onChange={e => {
                    const files = Array.from(e.target.files || []);
                    if (!files.length) return;
                    setDocuPdfs(prev => {
                      const filled: (File | null)[] = [...prev];
                      const empties = filled.map((f, i) => f === null ? i : -1).filter(i => i >= 0);
                      const toAdd: (File | null)[] = [];
                      files.forEach((file, fi) => {
                        if (fi < empties.length) filled[empties[fi]] = file;
                        else toAdd.push(file);
                      });
                      return [...filled, ...toAdd];
                    });
                    e.target.value = '';
                  }} />
              </label>
              {docuPdfs.some(Boolean) && (
                <>
                  <span className="text-[var(--t4)]">|</span>
                  <button onClick={() => setDocuPdfs([null])}
                    className="text-[11px] font-medium text-red-400 hover:text-red-500 flex items-center gap-1">
                    <X className="w-3 h-3" /> Clear all
                  </button>
                </>
              )}
            </div>

            <PdfSlot label="PO PDF" sub="Purchase order — for price cross-check"
                     file={poPdf} onFile={setPoPdf} />
          </div>

          <div className="mt-4">
            <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-1.5">Sequence number <span className="normal-case font-normal">(optional)</span></label>
            <input value={seqOverride} onChange={e => setSeqOverride(e.target.value)}
              placeholder="CBU…"
              className="w-full h-8 px-2.5 rounded-md text-[12px] mono ring-1 ring-inset ring-[var(--line-2)] bg-[var(--s3)] focus:ring-[var(--accent-line)] focus:outline-none" />
          </div>

          {!allReady && (
            <p className="text-[11px] text-[var(--t3)] mt-3">
              {[!quotePdf && 'Quote PDF', !docuPdfs.some(f=>!!f) && 'DOCU_ID PDF', !poPdf && 'PO PDF'].filter(Boolean).join(', ')} still needed
            </p>
          )}

          <button onClick={run} disabled={!allReady || running}
            className={cn(
              'w-full mt-4 h-10 rounded-lg text-[12.5px] font-semibold flex items-center justify-center gap-2 transition-all',
              allReady && !running
                ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white v3-glow'
                : 'bg-[var(--s3)] text-[var(--t3)] cursor-not-allowed',
            )}>
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
              : <><ClipboardList className="w-4 h-4" /> Raise PMO</>}
          </button>
        </Card>

        {/* Log */}
        {lines.length > 0 && (
          <Card padded={false}>
            <div className="px-4 py-2 border-b border-[var(--line)] text-[10px] font-semibold uppercase tracking-widest text-[var(--t3)]">Log</div>
            <div ref={logRef} className="px-4 py-2 max-h-52 overflow-y-auto mono text-[11px] space-y-0.5">
              {lines.map((l, i) => (
                <p key={i} className={cn(
                  l.startsWith('[ERR]')  ? 'text-red-500' :
                  l.startsWith('[OK]')   ? 'text-emerald-600 dark:text-emerald-400' :
                  l.startsWith('[WARN]') ? 'text-amber-500' :
                  'text-[var(--t3)]',
                )}>{l}</p>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Right — output */}
      <div className="col-span-12 lg:col-span-7 space-y-[22px]">
        {done && dlId && (
          <Card>
            <button onClick={downloadDocx}
              className="w-full flex items-center gap-3 px-4 py-3 bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent-line)] rounded-lg hover:bg-[var(--accent-soft)] transition-all group">
              <div className="w-9 h-9 rounded-md bg-brand-100 dark:bg-[var(--accent)]/20 flex items-center justify-center shrink-0">
                <Download className="w-4 h-4 text-[var(--accent-text)]" />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-[12.5px] font-semibold text-[var(--accent-text)]">Download PMO Offer</p>
                <p className="text-[11px] text-[var(--accent-text)] truncate mt-0.5">{dlName}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--accent-text)] group-hover:translate-x-0.5 transition-transform" />
            </button>

            {/* Filing it in the shared PMO folder is a separate, deliberate step:
                check the document first, then put it where the PMO team looks. */}
            <div className="mt-2.5 flex items-center gap-2.5">
              <button onClick={() => saveToFolder(false)} disabled={saving || saved}
                className={cn(
                  'flex-1 flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors',
                  saved
                    ? 'ring-1 ring-inset'
                    : 'border border-[var(--line-2)] bg-[var(--s2)] hover:bg-[var(--s-hover)] disabled:opacity-60',
                )}
                style={saved ? { background: 'var(--ok-soft)', borderColor: 'transparent' } : undefined}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin shrink-0 text-[var(--t3)]" />
                        : saved ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--ok)' }} />
                        : <FolderOpen className="w-4 h-4 shrink-0 text-[var(--t3)]" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold"
                        style={{ color: saved ? 'var(--ok)' : 'var(--t1)' }}>
                    {saved ? 'Filed in the PMO folder' : 'Checked it — save to PMO folder'}
                  </span>
                  <span className="block text-[10.5px] text-[var(--t3)] truncate mt-0.5">
                    {saved ? savedPath : (folder || 'the shared PMO pending folder')}
                  </span>
                </span>
              </button>
            </div>
            {folderAvailable === false && !saved && (
              <p className="mt-1.5 text-[10.5px]" style={{ color: 'var(--warn)' }}>
                Folder not reachable right now — check the Z: drive is connected.
              </p>
            )}
          </Card>
        )}

        {done && rowKeys.length > 0 && (
          <Card padded={false}>
            <div className="px-5 py-3 border-b border-[var(--line)] flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold tracking-tight">Extracted items</h3>
                <p className="text-[11.5px] text-[var(--t3)] mt-0.5">{rowKeys.length} line item{rowKeys.length !== 1 ? 's' : ''}</p>
              </div>
              <Pill tone="ok" dot>Ready to send</Pill>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-[var(--s1)]">
                    {['#', 'Cat Ref', 'Description', 'Qty', 'NTP', 'Sell Out', 'ACP'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--t3)] whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rowKeys.map((crKey, i) => {
                    const idx2 = crKey === 'CatRef' ? '' : crKey.replace('CatRef','');
                    return (
                      <tr key={crKey} className="border-t border-[var(--line)]">
                        <td className="px-3 py-2 mono text-[var(--t3)] num">{i + 1}</td>
                        <td className="px-3 py-2 mono font-semibold text-violet-700 dark:text-violet-300 whitespace-nowrap">{emailData[crKey] || '—'}</td>
                        <td className="px-3 py-2 truncate max-w-[180px]">{emailData['Desc' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono num">{emailData['Qty' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-[var(--accent-text)] whitespace-nowrap">{emailData['NTP' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{emailData['SellOut' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-amber-600 dark:text-amber-400 whitespace-nowrap">{emailData['ACP' + idx2] || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {done && dlId && (
          <Card padded={false} className="overflow-hidden">
            <div className="bg-[var(--s1)] px-4 py-2.5 border-b border-[var(--line)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--t3)]">New message</span>
              </div>
              <button
                onClick={() => { navigator.clipboard.writeText(bodyText); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                  copied ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                         : 'bg-[var(--s2)] text-[var(--t2)] hover:bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)]',
                )}>
                <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy body'}
              </button>
            </div>
            <div className="text-[11px] divide-y divide-[var(--line)]">
              <EmailField label="To" value="MasterDataEGCS@Eaton.com" />
              <EmailField label="CC" value={`"Fenton, Mark A" <MarkAFenton@eaton.com>; ${emailData['Salesman'] ? `${emailData['Salesman'].replace(' ','').replace(',','')}@Eaton.com` : 'JoeBayley@Eaton.com'}`} />
              <EmailField label="Re" value={`PMO – ${emailData['DWO'] || ''} – ${emailData['Project'] || ''}`} />
            </div>
            <pre className="px-4 py-4 text-[11.5px] text-[var(--t2)] whitespace-pre-wrap mono leading-relaxed bg-[var(--s1)] max-h-72 overflow-y-auto">{bodyText}</pre>
          </Card>
        )}

        {!done && lines.length === 0 && (
          <Card className="text-center py-12">
            <div className="w-12 h-12 rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)] flex items-center justify-center mx-auto mb-3">
              <ClipboardList className="w-5 h-5" />
            </div>
            <p className="text-[13px] font-semibold">Waiting for inputs</p>
            <p className="text-[11.5px] text-[var(--t3)] mt-1 max-w-md mx-auto">
              Drop the quote, DOCU and PO on the left, then click Raise PMO.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── PDF dropzone slot ──────────────────────────────────────────────────────
function PdfSlot({
  label, sub, file, onFile,
}: {
  label: string;
  sub: string;
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/pdf': ['.pdf', '.PDF'] },
    multiple: false,
    onDrop: files => onFile(files[0] || null),
  });
  const loaded = !!file;
  return (
    <div {...getRootProps()} className={cn(
      'rounded-md ring-1 ring-inset px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer',
      isDragActive
        ? 'ring-[var(--accent-line)] bg-[var(--accent-soft)]'
        : loaded
          ? 'ring-emerald-300/70 bg-emerald-50/50 dark:bg-emerald-900/15 dark:ring-emerald-700/40'
          : 'ring-[var(--line-2)] hover:bg-[var(--s3)]',
    )}>
      <input {...getInputProps()} />
      <div className={cn(
        'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
        loaded ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
               : 'bg-[var(--s3)] text-[var(--t3)]',
      )}>
        {loaded ? <CheckCircle2 className="w-3.5 h-3.5" /> : <FileUp className="w-3.5 h-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold">{label}</p>
        <p className="text-[10.5px] text-[var(--t3)] truncate">{loaded ? file!.name : sub}</p>
      </div>
      {loaded && (
        <button aria-label="Remove this file" onClick={e => { e.stopPropagation(); onFile(null); }}
          className="text-[var(--t3)] hover:text-red-500 shrink-0"><X className="w-3.5 h-3.5" /></button>
      )}
    </div>
  );
}

function EmailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2 flex gap-3">
      <span className="text-[var(--t3)] uppercase tracking-wider w-8 shrink-0 text-[10px] font-semibold pt-0.5">{label}</span>
      <span className="mono break-all">{value}</span>
    </div>
  );
}

// ─── Simple error boundary ──────────────────────────────────────────────────
class ErrorBoundary extends React.Component<
  { toast: ToastFn; children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { toast: ToastFn; children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) return (
      <Card className="text-red-700 dark:text-red-400">
        <p className="font-bold text-[13px]">PMO panel error</p>
        <p className="mono text-[11px] mt-2 whitespace-pre-wrap">{this.state.error}</p>
        <button onClick={() => this.setState({ error: null })} className="text-[11px] underline mt-2">Retry</button>
      </Card>
    );
    return <>{this.props.children}</>;
  }
}

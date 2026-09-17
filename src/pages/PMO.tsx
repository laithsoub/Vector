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
import { Button as UiButton, IconButton as UiIconButton } from '../ui';

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
    <div className="grid grid-cols-12 gap-5">
      {/* Left — inputs */}
      <div className="col-span-12 lg:col-span-5 space-y-5">
        <Card>
          <div className="mb-4">
            <h2 className="text-base font-semibold tracking-tight">Raise PMO</h2>
            <p className="text-xs text-fg-3 mt-1">Upload quote, DOCU and PO. Returns filled Word document.</p>
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
                  <UiIconButton icon={X} label="Remove this document" tone="danger" className="shrink-0" onClick={() => setDocuPdfs(prev => prev.filter((_, j) => j !== i))} />
                )}
              </div>
            ))}

            <div className="flex items-center gap-3 mt-1 pt-1">
              <button onClick={() => setDocuPdfs(prev => [...prev, null])}
                className="flex items-center gap-1 text-xs font-medium text-accent-text hover:text-accent-text">
                <Upload className="w-3 h-3" /> Add one
              </button>
              <span className="text-fg-4">|</span>
              <label className="flex items-center gap-1 text-xs font-medium text-accent-text hover:text-accent-text cursor-pointer">
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
                  <span className="text-fg-4">|</span>
                  <button onClick={() => setDocuPdfs([null])}
                    className="text-xs font-medium text-err hover:text-err flex items-center gap-1">
                    <X className="w-3 h-3" /> Clear all
                  </button>
                </>
              )}
            </div>

            <PdfSlot label="PO PDF" sub="Purchase order — for price cross-check"
                     file={poPdf} onFile={setPoPdf} />
          </div>

          <div className="mt-4">
            <label className="block text-2xs font-semibold uppercase tracking-wider text-fg-3 mb-1.5">Sequence number <span className="normal-case font-normal">(optional)</span></label>
            <input value={seqOverride} onChange={e => setSeqOverride(e.target.value)}
              placeholder="CBU…"
              className="w-full h-8 px-2.5 rounded-md text-sm mono ring-1 ring-inset ring-line-2 bg-subtle focus:ring-accent-line focus:outline-none" />
          </div>

          {!allReady && (
            <p className="text-xs text-fg-3 mt-3">
              {[!quotePdf && 'Quote PDF', !docuPdfs.some(f=>!!f) && 'DOCU_ID PDF', !poPdf && 'PO PDF'].filter(Boolean).join(', ')} still needed
            </p>
          )}

          <button onClick={run} disabled={!allReady || running}
            className={cn(
              'w-full mt-4 h-10 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all',
              allReady && !running
                ? 'bg-accent hover:bg-accent-hover text-on-accent v3-glow'
                : 'bg-subtle text-fg-3 cursor-not-allowed',
            )}>
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
              : <><ClipboardList className="w-4 h-4" /> Raise PMO</>}
          </button>
        </Card>

        {/* Log */}
        {lines.length > 0 && (
          <Card padded={false}>
            <div className="px-4 py-2 border-b border-line text-2xs font-semibold uppercase tracking-widest text-fg-3">Log</div>
            <div ref={logRef} className="px-4 py-2 max-h-52 overflow-y-auto mono text-xs space-y-0.5">
              {lines.map((l, i) => (
                <p key={i} className={cn(
                  l.startsWith('[ERR]')  ? 'text-err' :
                  l.startsWith('[OK]')   ? 'text-ok ' :
                  l.startsWith('[WARN]') ? 'text-warn' :
                  'text-fg-3',
                )}>{l}</p>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Right — output */}
      <div className="col-span-12 lg:col-span-7 space-y-5">
        {done && dlId && (
          <Card>
            <button onClick={downloadDocx}
              className="w-full flex items-center gap-3 px-4 py-3 bg-accent-soft ring-1 ring-inset ring-accent-line rounded-lg hover:bg-accent-soft transition-all group">
              <div className="w-9 h-9 flex items-center justify-center shrink-0 text-accent-text">
                <Download className="w-4 h-4 text-accent-text" />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-semibold text-accent-text">Download PMO Offer</p>
                <p className="text-xs text-accent-text truncate mt-0.5">{dlName}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-accent-text group-hover:translate-x-0.5 transition-transform" />
            </button>

            {/* Filing it in the shared PMO folder is a separate, deliberate step:
                check the document first, then put it where the PMO team looks. */}
            <div className="mt-2.5 flex items-center gap-2.5">
              <button onClick={() => saveToFolder(false)} disabled={saving || saved}
                className={cn(
                  'flex-1 flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors',
                  saved
                    ? 'ring-1 ring-inset'
                    : 'border border-line-2 bg-raised hover:bg-hover disabled:opacity-60',
                )}
                style={saved ? { background: 'var(--ok-soft)', borderColor: 'transparent' } : undefined}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin shrink-0 text-fg-3" />
                        : saved ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--ok)' }} />
                        : <FolderOpen className="w-4 h-4 shrink-0 text-fg-3" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold"
                        style={{ color: saved ? 'var(--ok)' : 'var(--t1)' }}>
                    {saved ? 'Filed in the PMO folder' : 'Checked it — save to PMO folder'}
                  </span>
                  <span className="block text-2xs text-fg-3 truncate mt-0.5">
                    {saved ? savedPath : (folder || 'the shared PMO pending folder')}
                  </span>
                </span>
              </button>
            </div>
            {folderAvailable === false && !saved && (
              <p className="mt-1.5 text-2xs" style={{ color: 'var(--warn)' }}>
                Folder not reachable right now — check the Z: drive is connected.
              </p>
            )}
          </Card>
        )}

        {done && rowKeys.length > 0 && (
          <Card padded={false}>
            <div className="px-5 py-3 border-b border-line flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold tracking-tight">Extracted items</h3>
                <p className="text-xs text-fg-3 mt-0.5">{rowKeys.length} line item{rowKeys.length !== 1 ? 's' : ''}</p>
              </div>
              <Pill tone="ok" dot>Ready to send</Pill>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface">
                    {['#', 'Cat Ref', 'Description', 'Qty', 'NTP', 'Sell Out', 'ACP'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-fg-3 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rowKeys.map((crKey, i) => {
                    const idx2 = crKey === 'CatRef' ? '' : crKey.replace('CatRef','');
                    return (
                      <tr key={crKey} className="border-t border-line">
                        <td className="px-3 py-2 mono text-fg-3 num">{i + 1}</td>
                        <td className="px-3 py-2 mono font-semibold text-ai whitespace-nowrap">{emailData[crKey] || '—'}</td>
                        <td className="px-3 py-2 truncate max-w-44">{emailData['Desc' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono num">{emailData['Qty' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-accent-text whitespace-nowrap">{emailData['NTP' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-ok whitespace-nowrap">{emailData['SellOut' + idx2] || '—'}</td>
                        <td className="px-3 py-2 mono text-warn whitespace-nowrap">{emailData['ACP' + idx2] || '—'}</td>
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
            <div className="bg-surface px-4 py-2.5 border-b border-line flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-err-soft" />
                  <span className="w-2.5 h-2.5 rounded-full bg-warn-soft" />
                  <span className="w-2.5 h-2.5 rounded-full bg-ok-soft" />
                </div>
                <span className="text-2xs font-semibold uppercase tracking-widest text-fg-3">New message</span>
              </div>
              <button
                onClick={() => { navigator.clipboard.writeText(bodyText); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors',
                  copied ? 'bg-ok-soft text-ok '
                         : 'bg-raised text-fg-2 hover:bg-subtle ring-1 ring-inset ring-line-2',
                )}>
                <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy body'}
              </button>
            </div>
            <div className="text-xs divide-y divide-line">
              <EmailField label="To" value="MasterDataEGCS@Eaton.com" />
              <EmailField label="CC" value={`"Fenton, Mark A" <MarkAFenton@eaton.com>; ${emailData['Salesman'] ? `${emailData['Salesman'].replace(' ','').replace(',','')}@Eaton.com` : 'JoeBayley@Eaton.com'}`} />
              <EmailField label="Re" value={`PMO – ${emailData['DWO'] || ''} – ${emailData['Project'] || ''}`} />
            </div>
            <pre className="px-4 py-4 text-xs text-fg-2 whitespace-pre-wrap mono leading-relaxed bg-surface max-h-72 overflow-y-auto">{bodyText}</pre>
          </Card>
        )}

        {!done && lines.length === 0 && (
          <Card className="text-center py-12">
            <div className="w-12 h-12 rounded-full bg-accent-soft text-accent-text flex items-center justify-center mx-auto mb-3">
              <ClipboardList className="w-5 h-5" />
            </div>
            <p className="text-base font-semibold">Waiting for inputs</p>
            <p className="text-xs text-fg-3 mt-1 max-w-md mx-auto">
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
        ? 'ring-accent-line bg-accent-soft'
        : loaded
          ? 'ring-ok-line bg-ok-soft '
          : 'ring-line-2 hover:bg-subtle',
    )}>
      <input {...getInputProps()} />
      <div className={cn(
        'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
        loaded ? 'bg-ok-soft text-ok '
               : 'bg-subtle text-fg-3',
      )}>
        {loaded ? <CheckCircle2 className="w-3.5 h-3.5" /> : <FileUp className="w-3.5 h-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-2xs text-fg-3 truncate">{loaded ? file!.name : sub}</p>
      </div>
      {loaded && (
        <button aria-label="Remove this file" onClick={e => { e.stopPropagation(); onFile(null); }}
          className="text-fg-3 hover:text-err shrink-0"><X className="w-3.5 h-3.5" /></button>
      )}
    </div>
  );
}

function EmailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2 flex gap-3">
      <span className="text-fg-3 uppercase tracking-wider w-8 shrink-0 text-2xs font-semibold pt-0.5">{label}</span>
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
      <Card className="text-err ">
        <p className="font-semibold text-base">PMO panel error</p>
        <p className="mono text-xs mt-2 whitespace-pre-wrap">{this.state.error}</p>
        <button onClick={() => this.setState({ error: null })} className="text-xs underline mt-2">Retry</button>
      </Card>
    );
    return <>{this.props.children}</>;
  }
}

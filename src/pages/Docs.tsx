// ─── Doc Packs ───────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BookOpen, FileText, Download, Plus, X, Loader2, Trash2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { Card, Pill, Button } from '../lib/ui';
import { api, type UserDoc } from '../lib/api';
import { failed } from '../lib/errors';
import type { ToastFn } from '../App';

// ── Built-in document packs (served from server docs/) ────────────────────────
const DOCS = [
  {
    id: 'bidman_urls', type: 'pdf' as const,
    title: 'BidMan URLs — DualGuard Configurator',
    desc:  'Production, QA and anonymous configurator URLs for BidManager DualGuard-S. Internal use — registered user and public access links.',
    pages: '6 pages', date: 'Feb 2025', color: 'bg-[var(--accent)]',
  },
  {
    id: 'commissioning', type: 'pdf' as const,
    title: 'Service & Commissioning Information',
    desc:  'Delivery, commissioning procedure, pre-commission checklist, service terms and important installation notes.',
    pages: '2 pages', date: 'Current', color: 'bg-[var(--accent)]',
  },
  {
    id: 'terms_and_conditions', type: 'pdf' as const,
    title: 'UK Terms & Conditions',
    desc:  'Standard Terms and Conditions of Sale for Eaton Electrical Sector UK. SP090392EN.',
    pages: '5 pages', date: 'Mar 2022', color: 'bg-[var(--t3)]',
  },
  {
    id: 'commission_calculators', type: 'xlsx' as const,
    title: 'Commission Calculators',
    desc:  'Sales commission calculation workbook — rate tables, targets and payout schedules. Open in Excel to use formulas.',
    pages: 'Excel workbook', date: 'Jan 2025', color: 'bg-emerald-700',
  },
];

const VIEW_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
const EXT_COLOR: Record<string, string> = {
  pdf: 'bg-[var(--accent)]', xlsx: 'bg-emerald-700', xls: 'bg-emerald-700',
  docx: 'bg-sky-700', doc: 'bg-sky-700',
  png: 'bg-violet-700', jpg: 'bg-violet-700', jpeg: 'bg-violet-700', gif: 'bg-violet-700', webp: 'bg-violet-700',
};

export function DocsPage({ toast }: { toast: ToastFn }) {
  const [viewing, setViewing]   = useState<string | null>(null);
  const [userDocs, setUserDocs] = useState<UserDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setUserDocs(await api.docsUser()); } catch { /* silent */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onPick(files: FileList | null) {
    if (!files || !files.length) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      try {
        const ext = (f.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
        const category = VIEW_EXTS.has(ext) && ext !== 'pdf' ? 'Image'
                       : ext === 'pdf' ? 'PDF'
                       : ['xlsx', 'xls'].includes(ext) ? 'Spreadsheet'
                       : ['doc', 'docx'].includes(ext) ? 'Document' : 'Custom';
        const r = await api.docsUserUpload(f, f.name.replace(/\.[^.]+$/, ''), category);
        if (!r.ok) toast('err', failed(`upload ${f.name}`, r.error));
        else toast('ok', `${f.name} added to your documents`);
      } catch (e: any) { toast('err', failed(`upload ${f.name}`, e)); }
    }
    setUploading(false);
    load();
  }

  async function del(d: UserDoc) {
    if (!confirm(`Remove "${d.title}"?`)) return;
    if (viewing === `user:${d.id}`) setViewing(null);
    try { await api.docsUserDelete(d.id); toast('info', `"${d.title}" removed from your documents`); load(); }
    catch (e: any) { toast('err', failed(`remove "${d.title}"`, e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-[var(--t3)]">Standard Eaton documents — open inline or download. Add your own with the button.</p>
        <input ref={fileRef} type="file" multiple accept=".pdf,.xlsx,.xls,.doc,.docx,image/*"
          className="hidden" onChange={e => { onPick(e.target.files); e.target.value = ''; }} />
        <Button tone="primary" size="sm" Icon={uploading ? Loader2 : Plus}
          onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Add Document'}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Built-in packs */}
        {DOCS.map(d => {
          const key = d.id;
          const open = viewing === key;
          return (
            <Card key={key} padded={false} className="overflow-hidden flex flex-col">
              <div className={cn(d.color, 'px-4 py-3 flex items-center gap-2')}>
                <BookOpen className="w-4 h-4 text-white shrink-0" />
                <span className="text-white text-[12px] font-semibold flex-1 leading-tight">{d.title}</span>
                <Pill tone="neutral" className="!bg-white/15 !text-white !ring-white/20">{d.type.toUpperCase()}</Pill>
              </div>
              <div className="p-4 flex-1 flex flex-col gap-3">
                <p className="text-[11.5px] text-[var(--t3)] leading-relaxed">{d.desc}</p>
                <div className="flex items-center gap-2 text-[10px] text-[var(--t3)] mt-auto">
                  <Pill tone="neutral">{d.pages}</Pill>
                  <Pill tone="neutral">{d.date}</Pill>
                </div>
                <div className="flex gap-2 pt-2">
                  {d.type === 'pdf' && (
                    <button onClick={() => setViewing(v => v === key ? null : key)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-[var(--s3)] hover:bg-[var(--s-hover)] text-[var(--t2)] transition-colors">
                      <FileText className="w-3.5 h-3.5" />
                      {open ? 'Close' : 'View'}
                    </button>
                  )}
                  <a href={d.type === 'xlsx' ? `/api/docs-xlsx/${d.id}` : `/api/docs/${d.id}`} download
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors">
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                </div>
              </div>
              {open && (
                <div className="border-t border-[var(--line)]">
                  <iframe src={`/api/docs/${d.id}`} className="w-full" style={{ height: '70vh' }} title={d.title} />
                </div>
              )}
            </Card>
          );
        })}

        {/* User-added packs — same card style */}
        {userDocs.map(d => {
          const key = `user:${d.id}`;
          const open = viewing === key;
          const canView = VIEW_EXTS.has(d.ext);
          return (
            <Card key={key} padded={false} className="overflow-hidden flex flex-col">
              <div className={cn(EXT_COLOR[d.ext] || 'bg-[var(--t3)]', 'px-4 py-3 flex items-center gap-2')}>
                <BookOpen className="w-4 h-4 text-white shrink-0" />
                <span className="text-white text-[12px] font-semibold flex-1 leading-tight truncate" title={d.title}>{d.title}</span>
                <Pill tone="neutral" className="!bg-white/15 !text-white !ring-white/20">{d.ext.toUpperCase()}</Pill>
                <button aria-label="Remove" onClick={() => del(d)} title="Remove"
                  className="text-white/70 hover:text-white transition-colors shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-4 flex-1 flex flex-col gap-3">
                <p className="text-[11.5px] text-[var(--t3)] leading-relaxed truncate" title={d.origName}>{d.origName}</p>
                <div className="flex items-center gap-2 text-[10px] text-[var(--t3)] mt-auto">
                  <Pill tone="neutral">{d.category}</Pill>
                  <Pill tone="neutral">{fmtSize(d.size)}</Pill>
                  <Pill tone="neutral">{new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</Pill>
                </div>
                <div className="flex gap-2 pt-2">
                  {canView && (
                    <button onClick={() => setViewing(v => v === key ? null : key)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-[var(--s3)] hover:bg-[var(--s-hover)] text-[var(--t2)] transition-colors">
                      <FileText className="w-3.5 h-3.5" />
                      {open ? 'Close' : 'View'}
                    </button>
                  )}
                  <a href={`/api/docs/user/${d.id}`} download={d.origName}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors">
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                </div>
              </div>
              {open && canView && (
                <div className="border-t border-[var(--line)]">
                  {d.ext === 'pdf'
                    ? <iframe src={`/api/docs/user/${d.id}`} className="w-full" style={{ height: '70vh' }} title={d.title} />
                    : <img src={`/api/docs/user/${d.id}`} alt={d.title} className="w-full max-h-[70vh] object-contain bg-[var(--s1)]" />}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {userDocs.length === 0 && (
        <p className="text-[11px] text-[var(--t3)] text-center pt-2">
          No custom documents yet — click <span className="font-medium">Add Document</span> to upload PDFs, images, Word or Excel files.
        </p>
      )}
    </div>
  );
}

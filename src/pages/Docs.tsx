// ─── Doc Packs ───────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Download, Plus, X, Trash2, Eye } from 'lucide-react';
import { Badge, Button, IconButton, IconLink, type StatusTone } from '../ui';
import { api, type UserDoc } from '../lib/api';
import { confirmAsync } from '../lib/notify';
import { failed } from '../lib/errors';
import type { ToastFn } from '../App';

// ── Built-in document packs (served from server docs/) ────────────────────────
const DOCS = [
  {
    id: 'bidman_urls', type: 'pdf' as const,
    title: 'BidMan URLs — DualGuard Configurator',
    desc:  'Production, QA and anonymous configurator URLs for BidManager DualGuard-S. Internal use — registered user and public access links.',
    pages: '6 pages', date: 'Feb 2025',
  },
  {
    id: 'commissioning', type: 'pdf' as const,
    title: 'Service & Commissioning Information',
    desc:  'Delivery, commissioning procedure, pre-commission checklist, service terms and important installation notes.',
    pages: '2 pages', date: 'Current',
  },
  {
    id: 'terms_and_conditions', type: 'pdf' as const,
    title: 'UK Terms & Conditions',
    desc:  'Standard Terms and Conditions of Sale for Eaton Electrical Sector UK. SP090392EN.',
    pages: '5 pages', date: 'Mar 2022',
  },
  {
    id: 'commission_calculators', type: 'xlsx' as const,
    title: 'Commission Calculators',
    desc:  'Sales commission calculation workbook — rate tables, targets and payout schedules. Open in Excel to use formulas.',
    pages: 'Excel workbook', date: 'Jan 2025',
  },
];

const VIEW_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
const EXT_TONE: Record<string, StatusTone> = {
  pdf: 'accent', xlsx: 'ok', xls: 'ok', docx: 'accent', doc: 'accent',
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
    if (!await confirmAsync({
      title: 'Remove document',
      message: `Remove "${d.title}" from your documents?`,
      confirmLabel: 'Remove', danger: true,
    })) return;
    if (viewing === `user:${d.id}`) setViewing(null);
    try { await api.docsUserDelete(d.id); toast('info', `"${d.title}" removed from your documents`); load(); }
    catch (e: any) { toast('err', failed(`remove "${d.title}"`, e)); }
  }

  type Row = {
    key: string; title: string; detail: string; ext: string; meta: string; date: string;
    href: string; download: string | true; view?: string; image?: boolean; onDelete?: () => void;
  };
  const rows: Row[] = [
    ...DOCS.map(d => ({
      key: d.id, title: d.title, detail: d.desc, ext: d.type, meta: d.pages, date: d.date,
      href: d.type === 'xlsx' ? `/api/docs-xlsx/${d.id}` : `/api/docs/${d.id}`,
      download: true as const,
      view: d.type === 'pdf' ? `/api/docs/${d.id}` : undefined,
    })),
    ...userDocs.map(d => ({
      key: `user:${d.id}`, title: d.title, detail: `${d.category} · ${d.origName}`, ext: d.ext,
      meta: fmtSize(d.size),
      date: new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      href: `/api/docs/user/${d.id}`, download: d.origName,
      view: VIEW_EXTS.has(d.ext) ? `/api/docs/user/${d.id}` : undefined,
      image: d.ext !== 'pdf',
      onDelete: () => del(d),
    })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-3">Standard Eaton documents — open inline or download. Add your own with the button.</p>
        <input ref={fileRef} type="file" multiple accept=".pdf,.xlsx,.xls,.doc,.docx,image/*"
          className="hidden" onChange={e => { onPick(e.target.files); e.target.value = ''; }} />
        <Button tone="primary" icon={Plus} loading={uploading} onClick={() => fileRef.current?.click()}>
          Add document
        </Button>
      </div>

      <div className="border-t border-line">
        {rows.map(r => {
          const open = viewing === r.key;
          return (
            <div key={r.key} className="border-b border-line">
              <div className="grid grid-cols-[var(--sp-6)_1fr_var(--sp-12)_auto_calc(var(--sp-4)*9)] items-center gap-x-4 py-3">
                <FileText className="w-4 h-4 text-fg-3" strokeWidth={1.75} />
                <div className="min-w-0">
                  <p className="text-md font-medium text-fg truncate">{r.title}</p>
                  <p className="text-xs text-fg-3 truncate" title={r.detail}>{r.detail}</p>
                </div>
                <Badge mono tone={EXT_TONE[r.ext] ?? 'neutral'}>{r.ext.toUpperCase()}</Badge>
                <div className="hidden md:block text-right w-32">
                  <p className="mono text-xs text-fg-2">{r.meta}</p>
                  <p className="mono text-2xs text-fg-4">{r.date}</p>
                </div>
                <div className="flex items-center justify-end gap-1">
                  {r.view && (
                    <Button tone={open ? 'secondary' : 'ghost'} icon={open ? X : Eye}
                      onClick={() => setViewing(v => v === r.key ? null : r.key)}>
                      {open ? 'Close' : 'View'}
                    </Button>
                  )}
                  <IconLink icon={Download} label={`Download ${r.title}`} href={r.href} download={r.download} />
                  {r.onDelete && <IconButton icon={Trash2} label="Remove" tone="danger" onClick={r.onDelete} />}
                </div>
              </div>
              {open && r.view && (
                <div className="pb-4">
                  {r.image
                    ? <img src={r.view} alt={r.title} className="w-full max-h-[70vh] object-contain rounded-panel border border-line" />
                    : <iframe src={r.view} className="w-full h-[70vh] rounded-panel border border-line" title={r.title} />}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {userDocs.length === 0 && (
        <p className="text-xs text-fg-3">
          No custom documents yet — use <span className="font-medium text-fg-2">Add document</span> to upload PDFs, images, Word or Excel files.
        </p>
      )}
    </div>
  );
}

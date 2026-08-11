// ─── Export an Ask Vector answer/conversation to many formats ──────────────────
// Text formats (txt, md, csv, html, json) are built here in the browser — instant, no
// round-trip. Binary formats (pdf, docx, xlsx) POST to /api/export where reportlab /
// openpyxl / an OOXML writer produce the real file. One entry point: exportAnswer().

export type ExportFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'md' | 'html' | 'json';

export const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; ext: string }> = [
  { id: 'pdf',  label: 'PDF',       ext: 'pdf'  },
  { id: 'docx', label: 'Word',      ext: 'docx' },
  { id: 'xlsx', label: 'Excel',     ext: 'xlsx' },
  { id: 'csv',  label: 'CSV',       ext: 'csv'  },
  { id: 'txt',  label: 'Text',      ext: 'txt'  },
  { id: 'md',   label: 'Markdown',  ext: 'md'   },
  { id: 'html', label: 'HTML',      ext: 'html' },
  { id: 'json', label: 'JSON',      ext: 'json' },
];

const SERVER_FORMATS: ExportFormat[] = ['pdf', 'docx', 'xlsx'];

// ── Small helpers ───────────────────────────────────────────────────────────────
function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string): string {
  return (name || 'vector-export').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'vector-export';
}

// Strip light markdown down to readable plain text.
export function stripMarkdown(md: string): string {
  return (md || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')            // images
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')  // links → text (url)
    .replace(/^#{1,6}\s+/gm, '')                     // heading marks
    .replace(/\*\*(.+?)\*\*/g, '$1')                 // bold
    .replace(/`([^`]+)`/g, '$1')                     // inline code
    .replace(/^\s*[-*•]\s+/gm, '• ')                 // bullets
    .replace(/^\s*\|/gm, '')                         // leading table pipe
    .replace(/\|\s*$/gm, '')                         // trailing table pipe
    .replace(/^\s*[-:|\s]+\s*$/gm, '')               // table separator rows
    .trim();
}

// Extract every GFM pipe table in the markdown.
export function extractTables(md: string): Array<{ headers: string[]; rows: string[][] }> {
  const lines = (md || '').split('\n');
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sep = lines[i + 1];
    if (l.includes('|') && sep && sep.includes('-') && /^[\s|:-]+$/.test(sep.trim())) {
      const headers = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      tables.push({ headers, rows });
      i--;
    }
  }
  return tables;
}

function csvCell(v: string): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(md: string): string {
  const tables = extractTables(md);
  if (tables.length) {
    return tables.map(t =>
      [t.headers, ...t.rows].map(r => r.map(csvCell).join(',')).join('\r\n'),
    ).join('\r\n\r\n');
  }
  // No table → one line per non-empty stripped line.
  return stripMarkdown(md).split('\n').filter(Boolean).map(csvCell).join('\r\n');
}

// Minimal markdown → HTML (headings, bold, lists, tables, links, paragraphs).
function toHTML(md: string, title: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = (md || '').split('\n');
  const out: string[] = [];
  let ul: string[] = [];
  const flushUl = () => { if (ul.length) { out.push('<ul>' + ul.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>'); ul = []; } };
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    const sep = lines[i + 1];
    if (s.includes('|') && sep && sep.includes('-') && /^[\s|:-]+$/.test(sep.trim())) {
      flushUl();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = cells(s);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      i--;
      out.push('<table><thead><tr>' + headers.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (!s) { flushUl(); continue; }
    const h = s.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushUl(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^[-*•]\s+/.test(s)) { ul.push(s.replace(/^[-*•]\s+/, '')); continue; }
    flushUl();
    out.push(`<p>${inline(s)}</p>`);
  }
  flushUl();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1c1e24}
h1,h2,h3{line-height:1.25}table{border-collapse:collapse;width:100%;margin:14px 0}
th,td{border:1px solid #c8cdd6;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#eef0f4}a{color:#6d28d9}</style></head><body>
${title ? `<h1>${esc(title)}</h1>` : ''}${out.join('\n')}</body></html>`;
}

// ── The one entry point ─────────────────────────────────────────────────────────
export async function exportAnswer(
  format: ExportFormat,
  opts: { content: string; title?: string; filename?: string },
): Promise<void> {
  const { content, title = '' } = opts;
  const file = safeName(opts.filename || title || 'vector-export');

  if (SERVER_FORMATS.includes(format)) {
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, content, title, filename: file }),
    });
    if (!resp.ok) {
      let msg = `Export failed (${resp.status})`;
      try { msg = (await resp.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    triggerDownload(`${file}.${format}`, await resp.blob());
    return;
  }

  let data: string;
  let mime: string;
  let ext: string = format;
  switch (format) {
    case 'txt':  data = (title ? title + '\n\n' : '') + stripMarkdown(content); mime = 'text/plain;charset=utf-8'; break;
    case 'md':   data = (title ? `# ${title}\n\n` : '') + (content || ''); mime = 'text/markdown;charset=utf-8'; break;
    case 'csv':  data = toCSV(content); mime = 'text/csv;charset=utf-8'; break;
    case 'html': data = toHTML(content, title); mime = 'text/html;charset=utf-8'; break;
    case 'json': data = JSON.stringify({ title, exportedAt: new Date().toISOString(), content }, null, 2); mime = 'application/json'; break;
    default:     data = stripMarkdown(content); mime = 'text/plain;charset=utf-8'; ext = 'txt';
  }
  triggerDownload(`${file}.${ext}`, new Blob([data], { type: mime }));
}

// ── Job report → a designed PDF / Word document ────────────────────────────────
// The server holds the report itself, so we only send which jobs are on screen (in
// display order) and the colours the page drew them in. export_report.py does the
// layout: KPI tiles, category bars, an activity chart and a clickable contents.
export type ReportFormat = 'pdf' | 'docx';

export const REPORT_FORMATS: Array<{ id: ReportFormat; label: string; ext: string; hint: string }> = [
  { id: 'pdf',  label: 'PDF',  ext: 'pdf',  hint: 'designed, clickable contents' },
  { id: 'docx', label: 'Word', ext: 'docx', hint: 'editable, with navigation' },
];

export async function exportJobReport(
  format: ReportFormat,
  opts: {
    convs: string[];
    catColors?: Record<string, string>;
    filter?: { category?: string | null; query?: string };
    owner?: string;
    filename?: string;
  },
): Promise<void> {
  const file = safeName(opts.filename || 'vector-job-report');
  const resp = await fetch('/api/export/job-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts, format, filename: file }),
  });
  if (!resp.ok) {
    let msg = `Export failed (${resp.status})`;
    try { msg = (await resp.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  triggerDownload(`${file}.${format}`, await resp.blob());
}

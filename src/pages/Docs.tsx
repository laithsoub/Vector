// ─── Doc Packs ───────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { BookOpen, FileText, Download } from 'lucide-react';
import { cn } from '../lib/cn';
import { Card, Pill, Button } from '../lib/ui';

const DOCS = [
  {
    id: 'bidman_urls', type: 'pdf' as const,
    title: 'BidMan URLs — DualGuard Configurator',
    desc:  'Production, QA and anonymous configurator URLs for BidManager DualGuard-S. Internal use — registered user and public access links.',
    pages: '6 pages', date: 'Feb 2025', color: 'bg-brand-800',
  },
  {
    id: 'commissioning', type: 'pdf' as const,
    title: 'Service & Commissioning Information',
    desc:  'Delivery, commissioning procedure, pre-commission checklist, service terms and important installation notes.',
    pages: '2 pages', date: 'Current', color: 'bg-brand-600',
  },
  {
    id: 'terms_and_conditions', type: 'pdf' as const,
    title: 'UK Terms & Conditions',
    desc:  'Standard Terms and Conditions of Sale for Eaton Electrical Sector UK. SP090392EN.',
    pages: '5 pages', date: 'Mar 2022', color: 'bg-ink-700',
  },
  {
    id: 'commission_calculators', type: 'xlsx' as const,
    title: 'Commission Calculators',
    desc:  'Sales commission calculation workbook — rate tables, targets and payout schedules. Open in Excel to use formulas.',
    pages: 'Excel workbook', date: 'Jan 2025', color: 'bg-emerald-700',
  },
];

export function DocsPage() {
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-[12px] text-ink-500 dark:text-ink-400">Standard Eaton documents — open inline or download.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {DOCS.map(d => (
          <Card key={d.id} padded={false} className="overflow-hidden flex flex-col">
            <div className={cn(d.color, 'px-4 py-3 flex items-center gap-2')}>
              <BookOpen className="w-4 h-4 text-white shrink-0" />
              <span className="text-white text-[12px] font-semibold flex-1 leading-tight">{d.title}</span>
              <Pill tone="neutral" className="!bg-white/15 !text-white !ring-white/20">{d.type.toUpperCase()}</Pill>
            </div>
            <div className="p-4 flex-1 flex flex-col gap-3">
              <p className="text-[11.5px] text-ink-500 dark:text-ink-400 leading-relaxed">{d.desc}</p>
              <div className="flex items-center gap-2 text-[10px] text-ink-400 mt-auto">
                <Pill tone="neutral">{d.pages}</Pill>
                <Pill tone="neutral">{d.date}</Pill>
              </div>
              <div className="flex gap-2 pt-2">
                {d.type === 'pdf' && (
                  <button onClick={() => setViewing(v => v === d.id ? null : d.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-ink-100 dark:bg-ink-800 hover:bg-ink-200 dark:hover:bg-ink-700 text-ink-700 dark:text-ink-200 transition-colors">
                    <FileText className="w-3.5 h-3.5" />
                    {viewing === d.id ? 'Close' : 'View'}
                  </button>
                )}
                <a href={d.type === 'xlsx' ? `/api/docs-xlsx/${d.id}` : `/api/docs/${d.id}`} download
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white transition-colors">
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
              </div>
            </div>
            {viewing === d.id && (
              <div className="border-t border-ink-200/70 dark:border-ink-800">
                <iframe src={`/api/docs/${d.id}`} className="w-full" style={{ height: '70vh' }} title={d.title} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── CBU page — three views over one system selection ────────────────────────
// Sizer:       configure a system, read the BoM, export the Tech Brief.
// Past quotes: which quote was done last at this size, to copy in Bidman.
// Modules:     the LoadStar inverter modules that ship as-is, priced by part
//              code with nothing to configure.
//
// They are separate views because they are separate jobs: the lookup was
// originally a panel inside the sizer, which put a second system selector on
// the same page as the sizer's own and buried the lookup under the data sheet.
// The chosen system is still shared, so switching views keeps the size and
// "Open in sizer" lands on the right one.
import React, { useEffect, useState } from 'react';
import { Sliders, History, Boxes } from 'lucide-react';

import CBUCalculator from '../CBUCalculator';
import CbuRefQuotes from '../components/CbuRefQuotes';
import CbuModules from '../components/CbuModules';

type View = 'sizer' | 'refs' | 'modules';
const VIEW_KEY = 'cbu_view';

export function CbuPage() {
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      return saved === 'refs' || saved === 'modules' ? saved : 'sizer';
    } catch { return 'sizer'; }
  });
  const [size, setSize] = useState('');

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private window */ }
  }, [view]);

  const tab = (id: View, label: string, Icon: typeof Sliders) => (
    <button key={id} onClick={() => setView(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all${
        view === id
          ? ' bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm'
          : ' text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
      <Icon className="w-3.5 h-3.5"/>
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="inline-flex items-center gap-1 p-[3px] rounded-[var(--r-md)] bg-[var(--s3)]">
        {tab('sizer',   'Sizer', Sliders)}
        {tab('refs',    'Past quotes', History)}
        {tab('modules', 'Modules', Boxes)}
      </div>

      {view === 'sizer'   && <CBUCalculator size={size} onSize={setSize}/>}
      {view === 'refs'    && <CbuRefQuotes size={size} onPickSize={setSize} onOpenSizer={() => setView('sizer')}/>}
      {view === 'modules' && <CbuModules/>}
    </div>
  );
}

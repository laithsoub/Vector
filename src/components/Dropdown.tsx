// ─── Portal dropdown ─────────────────────────────────────────────────────────
// Lifted out of CBUCalculator.tsx so the CBU sizer and the past-quotes lookup
// use the same control rather than two that drift apart.
//
// It renders its menu through a portal on the body: inside the sizer the menu
// would otherwise be clipped by the card's `overflow-hidden`, and the position
// is measured at open time instead of being CSS-anchored so the menu survives a
// scrolled page.
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

const DropdownClose = React.createContext<() => void>(() => {});

export function Dropdown({
  label, value, placeholder, children, required, wide,
}: {
  label: string;
  value: string;
  placeholder: string;
  children: React.ReactNode;
  required?: boolean;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref     = useRef<HTMLDivElement>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const close = () => setOpen(false);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        top:   r.bottom + window.scrollY + 4,
        left:  r.left + window.scrollX,
        width: Math.max(r.width, wide ? 320 : 220),
      });
    }
    setOpen(v => !v);
  };

  return (
    <DropdownClose.Provider value={close}>
      <div ref={ref} className="relative">
        {label && (
          <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-wide mb-1">
            {label}{required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
        )}
        <button ref={btnRef} onClick={handleOpen}
          className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:border-blue-400 transition-all text-left${open ? ' border-blue-400 ring-2 ring-blue-100 dark:ring-blue-900/30' : ''}`}>
          <span className={value ? 'font-semibold text-zinc-900 dark:text-white' : 'text-zinc-400'}>{value || placeholder}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform shrink-0 ml-1${open ? ' rotate-180' : ''}`}/>
        </button>
        {open && createPortal(
          <div ref={dropRef} style={{ position: 'absolute', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-auto max-h-80">
            {children}
          </div>,
          document.body,
        )}
      </div>
    </DropdownClose.Provider>
  );
}

// Item inside a Dropdown — closes the menu via context, then runs onClick.
export function DItem({
  onClick, active, children, dim,
}: {
  onClick: () => void;
  active: boolean;
  children: React.ReactNode;
  dim?: boolean;
}) {
  const close = React.useContext(DropdownClose);
  return (
    <button onClick={() => { onClick(); close(); }}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors${
        active ? ' bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 font-semibold' : ''}${
        dim && !active ? ' text-zinc-400 dark:text-zinc-500' : ''}`}>
      {children}
    </button>
  );
}

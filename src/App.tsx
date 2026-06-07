// ─── App shell: sidebar, header, page routing ────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LayoutDashboard, History as HistoryIcon, BarChart3,
  ClipboardList, Calculator, BookOpen, Settings as SettingsIcon,
  Sparkles, Zap, Sun, Moon, Bell, Clock, CheckCircle2, AlertCircle, Info, X,
  Loader2, RefreshCw, Mail, Send, Keyboard, Users, Gauge,
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue } from 'motion/react';

import { cn } from './lib/cn';
import { api } from './lib/api';
import { LangCtx, useLang, T, type Lang } from './lib/i18n';
import type { Config } from './types';

import { DashboardPage }   from './pages/Dashboard';
import { AnalyticsPage }   from './pages/Analytics';
import { AssistantPage }   from './pages/Assistant';
import { HistoryPage }     from './pages/History';
import { InboxPage }       from './pages/Inbox';
import { PmoPage }         from './pages/PMO';
import { CbuPage }         from './pages/CBU';
import { CommissionPage }  from './pages/Commission';
import { DocsPage }        from './pages/Docs';
import { SettingsPage }    from './pages/Settings';
import { SchematicsPage }  from './pages/Schematics';
import { OverlayPage }     from './pages/Overlay';
import { CrmPage }         from './pages/Crm';

// ─── Tab definitions ─────────────────────────────────────────────────────────
type TabId =
  | 'Dashboard' | 'Assistant' | 'History' | 'Analytics' | 'Inbox' | 'CRM'
  | 'PMO' | 'CBU' | 'Commission' | 'Schematics' | 'Docs' | 'Settings';

// Static nav structure — labels resolved at render time via useLang()
const NAV_STRUCTURE = {
  workflow: {
    labelKey: 'workflow' as const,
    items: [
      { id: 'Dashboard' as TabId, Icon: LayoutDashboard, labelKey: 'dashboard' as const },
      { id: 'Assistant' as TabId, Icon: Sparkles,         labelKey: 'assistant' as const },
      { id: 'Inbox'     as TabId, Icon: Mail,            labelKey: 'inbox'     as const },
      { id: 'CRM'       as TabId, Icon: Users,           labelKey: 'crm'       as const },
      { id: 'History'   as TabId, Icon: HistoryIcon,     labelKey: 'history'   as const },
      { id: 'Analytics' as TabId, Icon: BarChart3,       labelKey: 'analytics' as const },
    ],
  },
  tools: {
    labelKey: 'tools' as const,
    items: [
      { id: 'PMO'        as TabId, Icon: ClipboardList, labelKey: 'pmo'        as const },
      { id: 'CBU'        as TabId, Icon: Calculator,    labelKey: 'cbuSizer'    as const },
      { id: 'Commission' as TabId, Icon: Gauge,          labelKey: 'commission'  as const },
      { id: 'Schematics' as TabId, Icon: Zap,           labelKey: 'schematics'  as const },
      { id: 'Docs'       as TabId, Icon: BookOpen,      labelKey: 'docPacks'   as const },
    ],
  },
};

// Title keys per tab — resolved at render time
const TITLE_KEYS: Record<TabId, { t: keyof typeof T.en; s: keyof typeof T.en }> = {
  Dashboard: { t: 'dashboard',  s: 'sub_dashboard'  },
  Assistant: { t: 'assistant',  s: 'sub_assistant'  },
  Inbox:     { t: 'inbox',      s: 'sub_inbox'      },
  CRM:       { t: 'crm',        s: 'sub_crm'       },
  History:   { t: 'history',    s: 'sub_history'   },
  Analytics: { t: 'analytics',  s: 'sub_analytics' },
  PMO:       { t: 'pmo',        s: 'sub_pmo'       },
  CBU:        { t: 'cbuSizer',    s: 'sub_cbu'        },
  Commission: { t: 'commission',  s: 'sub_commission' },
  Schematics:{ t: 'schematics', s: 'sub_schematics' },
  Docs:      { t: 'docPacks',   s: 'sub_docs'      },
  Settings:  { t: 'settings',   s: 'sub_settings'  },
};

// ─── Toast types ─────────────────────────────────────────────────────────────
export type ToastFn = (type: 'ok' | 'err' | 'info' | 'warn', msg: string) => void;
interface Toast { id: number; type: 'ok' | 'err' | 'info' | 'warn'; msg: string; }
let _tid = 0;

// ─── Toast list ──────────────────────────────────────────────────────────────
function ToastList({ toasts, remove }: { toasts: Toast[]; remove: (id: number) => void }) {
  return (
    <div className="fixed bottom-5 right-5 space-y-2 z-50 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div key={t.id}
            initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
            className={cn(
              'pointer-events-auto flex items-center gap-2.5 px-3.5 py-2 rounded-lg shadow-lg ring-1 ring-inset text-[12px] max-w-xs',
              t.type === 'ok'   ? 'bg-white dark:bg-ink-800 ring-emerald-200 dark:ring-emerald-700/40 text-emerald-700 dark:text-emerald-300' :
              t.type === 'err'  ? 'bg-white dark:bg-ink-800 ring-red-200 dark:ring-red-700/40 text-red-700 dark:text-red-300' :
                                  'bg-white dark:bg-ink-800 ring-ink-200 dark:ring-ink-700 text-ink-700 dark:text-ink-200',
            )}>
            {t.type === 'ok'  ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> :
             t.type === 'err' ? <AlertCircle  className="w-3.5 h-3.5 shrink-0" /> :
                                <Info         className="w-3.5 h-3.5 shrink-0" />}
            <span className="flex-1">{t.msg}</span>
            <button onClick={() => remove(t.id)} className="opacity-40 hover:opacity-100"><X className="w-3 h-3" /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({
  tab, setTab, queueCount, inboxUnread, userInitials, userEmail,
}: {
  tab: TabId;
  setTab: (t: TabId) => void;
  queueCount: number;
  inboxUnread: number;
  userInitials: string;
  userEmail: string | null;
}) {
  const { t } = useLang();
  return (
    <aside className="w-[220px] shrink-0 h-full flex flex-col border-r border-ink-200/70 dark:border-ink-800 bg-white dark:bg-ink-900">
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-ink-200/70 dark:border-ink-800">
        <div className="relative">
          <div className="w-7 h-7 rounded-md bg-brand-600 flex items-center justify-center">
            <span className="text-white text-[14px] font-black leading-none tracking-tighter select-none">V</span>
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-ink-900" />
        </div>
        <div className="leading-none min-w-0">
          <p className="text-[12.5px] font-semibold tracking-tight truncate">Vector</p>
          <p className="text-[9.5px] text-ink-400 dark:text-ink-500 mt-0.5 truncate">Quote Automation · v2.0</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-5">
        {Object.entries(NAV_STRUCTURE).map(([key, sec]) => (
          <div key={key} className="space-y-0.5">
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase text-ink-400 dark:text-ink-500">
              {t[sec.labelKey]}
            </div>
            {sec.items.map(it => {
              const active = it.id === tab;
              const badge = it.id === 'Dashboard' ? queueCount : it.id === 'Inbox' ? inboxUnread : 0;
              return (
                <button key={it.id} onClick={() => setTab(it.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
                    active
                      ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-900'
                      : 'text-ink-600 dark:text-ink-300 hover:bg-ink-100/70 dark:hover:bg-ink-800/60',
                  )}>
                  <it.Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={active ? 2.2 : 1.75} />
                  <span className="flex-1 text-left truncate">{t[it.labelKey]}</span>
                  {badge > 0 && (
                    <span className={cn(
                      'min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold flex items-center justify-center shrink-0',
                      active ? 'bg-white/15 text-white dark:bg-ink-900/10 dark:text-ink-900'
                             : 'bg-brand-600 text-white',
                    )}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="px-2 pb-3 pt-2 border-t border-ink-200/70 dark:border-ink-800 space-y-0.5">
        <button onClick={() => setTab('Settings')}
          className={cn(
            'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
            tab === 'Settings'
              ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-900'
              : 'text-ink-600 dark:text-ink-300 hover:bg-ink-100/70 dark:hover:bg-ink-800/60',
          )}>
          <SettingsIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left">{t.settings}</span>
        </button>
        <div className="flex items-center gap-2 px-2 py-2 mt-1.5 min-w-0">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-[10px] font-bold text-white shrink-0">{userInitials}</div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium truncate leading-none">{userEmail ? userEmail.split('@')[0] : 'Not connected'}</p>
            <p className="text-[9.5px] text-ink-400 dark:text-ink-500 leading-none mt-1 truncate">{userEmail || '—'}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({
  tab, setTab, dark, setDark, connected, userName, sessionElapsed,
  onConnect, connecting, notifs, hasNew, clearNew,
}: {
  tab: TabId;
  setTab: (t: TabId) => void;
  dark: boolean;
  setDark: (fn: (d: boolean) => boolean) => void;
  connected: boolean | null;
  userName: string | null;
  sessionElapsed: string;
  onConnect: () => void;
  connecting: boolean;
  notifs: Toast[];
  hasNew: boolean;
  clearNew: () => void;
}) {
  const keys = TITLE_KEYS[tab];
  const { t: tr } = useLang();
  const cur = { t: tr[keys.t] as string, s: tr[keys.s] as string };
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <header className="h-14 shrink-0 flex items-center gap-4 px-6 bg-white dark:bg-ink-900 border-b border-ink-200/70 dark:border-ink-800">
      <div className="min-w-0">
        <h1 className="text-[14px] font-semibold leading-none tracking-tight">{cur.t}</h1>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1.5 leading-none truncate">{cur.s}</p>
      </div>

      <div className="flex-1" />

      {sessionElapsed && (
        <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-ink-400 num">
          <Clock className="w-3 h-3" />
          {sessionElapsed}
        </div>
      )}

      <button onClick={onConnect} disabled={connecting}
        className={cn(
          'h-8 px-2.5 rounded-lg text-[11.5px] font-semibold flex items-center gap-1.5 ring-1 ring-inset transition-colors',
          connecting
            ? 'bg-ink-100 dark:bg-ink-800 ring-ink-200 dark:ring-ink-700 text-ink-400 cursor-not-allowed'
            : connected
              ? 'bg-emerald-50 dark:bg-emerald-900/30 ring-emerald-200/70 dark:ring-emerald-700/40 text-emerald-700 dark:text-emerald-300'
              : 'bg-ink-100 dark:bg-ink-800 ring-ink-200 dark:ring-ink-700 text-ink-700 dark:text-ink-200',
        )}
        title={connecting ? tr.connecting : (userName || 'Click to connect to JOE')}>
        {connecting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-ink-400')} />}
        {connecting ? tr.connecting : connected ? (userName ? userName.split(' ')[0] : tr.connected) : tr.connectJoe}
        {connected && !connecting && <RefreshCw className="w-3 h-3 opacity-50" />}
      </button>

      <button onClick={() => setDark((d: boolean) => !d)}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800">
        {dark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
      </button>

      <div ref={notifRef} className="relative">
        <button onClick={() => { setNotifOpen(o => !o); clearNew(); }}
          className="relative w-8 h-8 rounded-lg flex items-center justify-center text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800">
          <Bell className="w-3.5 h-3.5" />
          {hasNew && <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-ink-900" />}
        </button>
        <AnimatePresence>
          {notifOpen && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="absolute right-0 top-10 w-72 bg-white dark:bg-ink-900 ring-1 ring-ink-200 dark:ring-ink-700 rounded-xl shadow-xl z-50 overflow-hidden">
              <p className="px-4 py-2.5 text-[10px] font-semibold text-ink-400 uppercase tracking-widest border-b border-ink-100 dark:border-ink-800">Activity</p>
              <div className="max-h-60 overflow-y-auto">
                {notifs.length === 0
                  ? <p className="px-4 py-5 text-[11.5px] text-ink-400 text-center">No recent activity</p>
                  : notifs.map(t => (
                    <div key={t.id} className="flex items-start gap-2 px-4 py-2 border-b border-ink-50 dark:border-ink-800/50 last:border-0">
                      {t.type === 'ok'  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" /> :
                       t.type === 'err' ? <AlertCircle  className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" /> :
                                          <Info         className="w-3.5 h-3.5 text-brand-500 mt-0.5 shrink-0" />}
                      <p className="text-[11.5px] text-ink-700 dark:text-ink-200">{t.msg}</p>
                    </div>
                  ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

// ─── Splash / Connect screen ─────────────────────────────────────────────────
function SplashScreen({
  onConnect, onSkip, connecting,
}: {
  onConnect: () => void;
  onSkip:    () => void;
  connecting: boolean;
}) {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-white dark:bg-ink-950 relative select-none">
      <ToastList toasts={[]} remove={() => {}} />
      {/* Logo */}
      <div className="w-20 h-20 rounded-3xl bg-brand-600 flex items-center justify-center mb-5 shadow-xl ring-4 ring-brand-500/20">
        <span className="text-white text-[40px] font-black leading-none tracking-tighter">V</span>
      </div>
      <h1 className="text-[26px] font-bold tracking-tight text-ink-900 dark:text-ink-50">Vector</h1>
      <p className="text-[12.5px] text-ink-400 dark:text-ink-500 mt-1 mb-10">Quote Automation · v2.0</p>

      <button
        onClick={onConnect}
        disabled={connecting}
        className="h-11 px-8 rounded-xl text-[13.5px] font-semibold bg-ink-900 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-700 dark:hover:bg-ink-100 disabled:opacity-60 flex items-center gap-2.5 transition-colors shadow-sm">
        {connecting
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
        {connecting ? 'Connecting…' : 'Connect to JOE'}
      </button>

      <button
        onClick={onSkip}
        className="mt-4 text-[11.5px] text-ink-400 hover:text-ink-600 dark:hover:text-ink-300 transition-colors underline-offset-2 hover:underline">
        Skip — enter without connection
      </button>

      <p className="absolute bottom-8 left-0 right-0 text-center text-[11px] text-ink-300 dark:text-ink-600 px-8">
        Connects to the Eaton JOE SharePoint environment.
        Make sure you're on the Eaton network or VPN.
      </p>
    </div>
  );
}

// ─── Keyboard shortcuts modal ────────────────────────────────────────────────
const SHORTCUTS = [
  { key: 'Ctrl + K',  desc: 'Open AI Assistant' },
  { key: 'Alt + 1',   desc: 'Dashboard' },
  { key: 'Alt + 2',   desc: 'Assistant' },
  { key: 'Alt + 3',   desc: 'Inbox' },
  { key: 'Alt + 4',   desc: 'History' },
  { key: 'Alt + 5',   desc: 'Analytics' },
  { key: '?',         desc: 'Toggle this panel' },
  { key: 'Esc',       desc: 'Close any modal / panel' },
];

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-ink-900 rounded-2xl shadow-2xl ring-1 ring-ink-200 dark:ring-ink-700 p-5 w-80">
        <div className="flex items-center gap-2 mb-4">
          <Keyboard className="w-4 h-4 text-ink-400" />
          <span className="text-[13px] font-semibold flex-1">Keyboard Shortcuts</span>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center text-ink-400 hover:text-ink-700 dark:hover:text-ink-200">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-1.5">
          {SHORTCUTS.map(s => (
            <div key={s.key} className="flex items-center justify-between py-1 border-b border-ink-50 dark:border-ink-800/50 last:border-0">
              <span className="text-[12px] text-ink-600 dark:text-ink-300">{s.desc}</span>
              <kbd className="px-2 py-0.5 rounded-md bg-ink-100 dark:bg-ink-800 text-[10.5px] font-mono text-ink-700 dark:text-ink-200 border border-ink-200 dark:border-ink-700">{s.key}</kbd>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10.5px] text-ink-400 text-center">Press <kbd className="px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-[10px] font-mono border border-ink-200 dark:border-ink-700">?</kbd> anytime to toggle</p>
      </motion.div>
    </div>
  );
}

// ─── Floating Assistant (FAB mini-chat) ─────────────────────────────────────
interface FAMsg { role: 'user' | 'ai'; text: string; }

function FloatingAssistant({ onOpenFull }: { onOpenFull: () => void }) {
  const [open,        setOpen]        = useState(false);
  const [msgs,        setMsgs]        = useState<FAMsg[]>([]);
  const [input,       setInput]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [isDragging,  setIsDragging]  = useState(false);
  const [overDismiss, setOverDismiss] = useState(false);
  const [dismissed,   setDismissed]   = useState(false);
  const bodyRef   = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const dragMoved = useRef(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const shouldEscalate = msgs.length >= 8 || msgs.some(m => m.role === 'ai' && m.text.length > 400);
  const hasUnread      = msgs.length > 0 && !open;

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 120); }, [open]);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, loading]);

  function nearDismiss(px: number, py: number) {
    return Math.hypot(px - window.innerWidth / 2, py - (window.innerHeight - 56)) < 52;
  }

  function handleDragStart() {
    setIsDragging(true);
    setOpen(false);
    dragMoved.current = false;
  }

  function handleDrag(_: any, info: any) {
    dragMoved.current = true;
    setOverDismiss(nearDismiss(info.point.x, info.point.y));
  }

  function handleDragEnd(_: any, info: any) {
    setIsDragging(false);
    setOverDismiss(false);
    if (nearDismiss(info.point.x, info.point.y)) setDismissed(true);
  }

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');
    setMsgs(p => [...p, { role: 'user', text: q }]);
    setLoading(true);
    try {
      const history = msgs.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', text: m.text }));
      const r = await api.ai(q, history);
      setMsgs(p => [...p, { role: 'ai', text: r.answer || r.error || 'No response.' }]);
    } catch {
      setMsgs(p => [...p, { role: 'ai', text: 'Error — check server connection.' }]);
    }
    setLoading(false);
  }

  if (dismissed) return null;

  return (
    <>
      {/* ── Chat panel ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.93, y: 12 }}
            animate={{ opacity: 1, scale: 1,    y: 0  }}
            exit={{   opacity: 0, scale: 0.93, y: 12  }}
            transition={{ duration: 0.15 }}
            className="fixed bottom-16 right-5 w-[340px] h-[420px] z-[9998] flex flex-col
                       bg-white dark:bg-ink-900 rounded-2xl shadow-2xl
                       ring-1 ring-ink-200 dark:ring-ink-700 overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-2 px-3.5 py-2 border-b border-ink-100 dark:border-ink-800 shrink-0">
              <div className="w-5 h-5 rounded-md bg-brand-600 flex items-center justify-center shrink-0">
                <span className="text-white text-[11px] font-black leading-none">V</span>
              </div>
              <span className="flex-1 text-[12px] font-semibold">Vector AI</span>
              <button onClick={() => { onOpenFull(); setOpen(false); }}
                className="text-[10.5px] text-brand-600 hover:text-brand-700 dark:text-brand-400 font-medium mr-1">
                Full view →
              </button>
              <button onClick={() => setMsgs([])} title="Clear chat"
                className="w-5 h-5 flex items-center justify-center text-ink-400 hover:text-ink-600 dark:hover:text-ink-200">
                <RefreshCw className="w-3 h-3" />
              </button>
              <button onClick={() => setOpen(false)}
                className="w-5 h-5 flex items-center justify-center text-ink-400 hover:text-ink-600 dark:hover:text-ink-200">
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Messages */}
            <div ref={bodyRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {msgs.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
                  <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-brand-500" />
                  </div>
                  <p className="text-[11.5px] font-medium text-ink-700 dark:text-ink-200">How can I help?</p>
                  <p className="text-[10.5px] text-ink-400 leading-snug">Ask anything about quotes, specs, or projects.</p>
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[85%] px-2.5 py-1.5 rounded-xl text-[11.5px] leading-relaxed whitespace-pre-wrap break-words',
                    m.role === 'user'
                      ? 'bg-brand-600 text-white rounded-br-sm'
                      : 'bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-100 rounded-bl-sm',
                  )}>{m.text}</div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-ink-100 dark:bg-ink-800 px-2.5 py-2 rounded-xl rounded-bl-sm">
                    <Loader2 className="w-3 h-3 text-ink-400 animate-spin" />
                  </div>
                </div>
              )}
            </div>

            {/* Escalation banner */}
            {shouldEscalate && (
              <div className="px-3 py-1.5 bg-brand-50 dark:bg-brand-900/20 border-t border-brand-100 dark:border-brand-800/40 flex items-center gap-2 shrink-0">
                <Sparkles className="w-3 h-3 text-brand-500 shrink-0" />
                <p className="text-[10.5px] text-brand-700 dark:text-brand-300 flex-1">Getting complex — try full view.</p>
                <button onClick={() => { onOpenFull(); setOpen(false); }}
                  className="text-[10.5px] font-semibold text-brand-600 hover:text-brand-700 whitespace-nowrap">Open →</button>
              </div>
            )}

            {/* Input */}
            <div className="px-3 py-2 border-t border-ink-100 dark:border-ink-800 shrink-0 flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask anything… (Enter to send)"
                className="flex-1 resize-none text-[11.5px] bg-transparent outline-none text-ink-800 dark:text-ink-100 placeholder:text-ink-400 leading-relaxed py-0.5"
              />
              <button onClick={send} disabled={!input.trim() || loading}
                className={cn(
                  'w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors mb-0.5',
                  input.trim() && !loading
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'bg-ink-100 dark:bg-ink-800 text-ink-400 cursor-not-allowed',
                )}>
                <Send className="w-3 h-3" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Dismiss zone — appears when dragging ── */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.8 }}
            animate={{ opacity: 1, y: 0,  scale: overDismiss ? 1.18 : 1 }}
            exit={{   opacity: 0, y: 16, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'fixed bottom-8 left-1/2 -translate-x-1/2 z-[9997] pointer-events-none',
              'w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-100',
              overDismiss
                ? 'bg-red-500 text-white shadow-lg shadow-red-500/30'
                : 'bg-white/90 dark:bg-ink-800/90 backdrop-blur text-ink-400 ring-1 ring-ink-200 dark:ring-ink-600',
            )}>
            <X className="w-5 h-5" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── FAB button ── */}
      <motion.button
        drag
        dragMomentum={false}
        style={{ x, y, position: 'fixed', bottom: 20, right: 20 }}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        whileHover={!isDragging ? { scale: 1.08 } : {}}
        whileTap={!isDragging ? { scale: 0.9 } : {}}
        onClick={() => { if (dragMoved.current) { dragMoved.current = false; return; } setOpen(o => !o); }}
        className={cn(
          'w-9 h-9 rounded-xl bg-brand-600 text-white shadow-lg z-[9999]',
          'flex items-center justify-center hover:bg-brand-700 transition-colors',
          isDragging ? 'cursor-grabbing opacity-80' : 'cursor-grab',
        )}>
        {open
          ? <X className="w-4 h-4" />
          : <span className="text-[15px] font-black leading-none tracking-tighter select-none">V</span>}
        {hasUnread && !open && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-ink-900" />
        )}
      </motion.button>
    </>
  );
}

// ─── Session timer helper ───────────────────────────────────────────────────
function fmtElapsed(iso: string | null) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - +new Date(iso)) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ────────────────────────────────────────────────────────────────────────────
const VALID_TABS: TabId[] = ['Dashboard', 'Assistant', 'Inbox', 'CRM', 'History', 'Analytics', 'PMO', 'CBU', 'Commission', 'Schematics', 'Docs', 'Settings'];

export default function App() {
  const [tab, setTabState] = useState<TabId>(() => {
    const saved = localStorage.getItem('vector_tab') as TabId;
    return VALID_TABS.includes(saved) ? saved : 'Dashboard';
  });
  // Track which tabs have ever been opened — only mount those, never unmount
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([
    (localStorage.getItem('vector_tab') as TabId) || 'Dashboard',
  ]));
  const setTab = useCallback((t: TabId) => {
    setTabState(t);
    setVisited(v => v.has(t) ? v : new Set([...v, t]));
    localStorage.setItem('vector_tab', t);
  }, []);

  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Dark mode schedule
  useEffect(() => {
    function checkSchedule() {
      const sched = (() => { try { return JSON.parse(localStorage.getItem('vector_dark_sched') || 'null'); } catch { return null; } })();
      if (!sched?.enabled) return;
      const now  = new Date();
      const cur  = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const isDark = cur >= (sched.darkFrom || '18:00') || cur < (sched.lightFrom || '07:00');
      setDark(isDark);
    }
    checkSchedule();
    const id = setInterval(checkSchedule, 60_000);
    return () => clearInterval(id);
  }, []);

  // Keyboard shortcuts modal
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Language
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('mu_lang') as Lang) || 'en');
  const saveLang = (l: Lang) => { setLangState(l); localStorage.setItem('mu_lang', l); };
  const tCurrent = T[lang];

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recentNotifs, setRecentNotifs] = useState<Toast[]>([]);
  const [hasNew, setHasNew] = useState(false);
  const toast: ToastFn = useCallback((type, msg) => {
    const t: Toast = { id: ++_tid, type, msg };
    setToasts(p => [...p, t]);
    setRecentNotifs(p => [t, ...p].slice(0, 20));
    setHasNew(true);
    setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), 5000);
  }, []);

  // Embed mode — used by outlook_overlay.py (PyWebView companion). Renders
  // only the Overlay page (no sidebar, no header, no splash). Toasts still
  // bubble up to the standard toast layer at the bottom of the window.
  const embedMode = typeof window !== 'undefined' && /(^|[?&])embed=1(&|$)/.test(window.location.search);
  if (embedMode) {
    return (
      <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
        <OverlayPage toast={toast} />
        {/* Toast layer */}
        <div className="fixed bottom-2 left-2 right-2 z-50 flex flex-col gap-1 pointer-events-none">
          <AnimatePresence>
            {toasts.map(t => (
              <motion.div key={t.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className={cn(
                  'pointer-events-auto px-3 py-1.5 rounded-lg text-[11px] font-medium shadow ring-1 ring-inset',
                  t.type === 'ok'   ? 'bg-emerald-500 text-white ring-emerald-600' :
                  t.type === 'err'  ? 'bg-red-500 text-white ring-red-600' :
                                      'bg-amber-500 text-white ring-amber-600',
                )}>
                {t.msg}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </LangCtx.Provider>
    );
  }

  // Server-backed state
  const [config, setConfig] = useState<Config | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [sessionStart, setSessionStart] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [inboxUnread, setInboxUnread] = useState(0);

  // Auto-dismiss splash once a session is confirmed
  useEffect(() => { if (connected === true) setSplashDone(true); }, [connected]);

  // Tick session
  useEffect(() => {
    if (!sessionStart) return;
    setElapsed(fmtElapsed(sessionStart));
    const id = setInterval(() => setElapsed(fmtElapsed(sessionStart)), 1000);
    return () => clearInterval(id);
  }, [sessionStart]);

  // Periodic refresh of connection / config / pdfs count
  const refreshHeader = useCallback(async () => {
    try {
      const [cfg, conn, sess, pdfs] = await Promise.all([
        api.config(), api.connection(), api.session(), api.pdfs(),
      ]);
      setConfig(cfg);
      setConnected(conn.connected);
      setUserName(conn.name);
      setUserEmail(conn.email ?? null);
      setSessionStart(sess.startedAt);
      setQueueCount(pdfs.length);
    } catch { /* offline, retry on tick */ }
  }, []);

  useEffect(() => {
    refreshHeader();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshHeader();
    }, 15_000);
    return () => clearInterval(id);
  }, [refreshHeader]);

  // Connect action
  async function onConnect() {
    if (connecting) return;
    setConnecting(true);
    try {
      const r = await api.connect();
      if (r.ok) {
        toast('ok', 'Connected to JOE');
        setSplashDone(true);
      } else {
        const detail = r.lines?.filter((l: string) => l.includes('[ERR]') || l.includes('[WARN]')).slice(-3).join(' | ');
        toast('err', detail || r.error || 'Connection failed — check vector.log');
      }
      await refreshHeader();
    } catch (e: any) {
      toast('err', e.message || 'Connection failed');
    }
    setConnecting(false);
  }

  // Keyboard shortcuts
  useEffect(() => {
    const workflowTabs: TabId[] = ['Dashboard', 'Assistant', 'Inbox', 'History', 'Analytics'];
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA'].includes(tag)) return;
      // ? → shortcuts modal
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setShortcutsOpen(o => !o); return;
      }
      // ⌘K / Ctrl+K → Assistant
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setTab('Assistant');
        return;
      }
      // Alt+1..5 → workflow tabs
      if (e.altKey && e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key) - 1;
        if (workflowTabs[idx]) { e.preventDefault(); setTab(workflowTabs[idx]); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setTab]);

  const userInitials = userName
    ? userName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
    : '—';

  return (
    <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
      <ToastList toasts={toasts} remove={id => setToasts(p => p.filter(t => t.id !== id))} />

      {/* ── Splash screen — shown until first successful connection or skipped ── */}
      {!splashDone ? (
        <SplashScreen onConnect={onConnect} onSkip={() => setSplashDone(true)} connecting={connecting} />
      ) : (

      <>
      <div className="flex h-screen min-h-0">
        <Sidebar tab={tab} setTab={setTab} queueCount={queueCount} inboxUnread={inboxUnread} userInitials={userInitials} userEmail={userEmail} />

        <div className="flex-1 flex flex-col min-w-0">
          <Header
            tab={tab} setTab={setTab} dark={dark} setDark={setDark}
            connected={connected} userName={userName} sessionElapsed={elapsed}
            onConnect={onConnect}
            connecting={connecting}
            notifs={recentNotifs} hasNew={hasNew} clearNew={() => setHasNew(false)}
          />
          {/* All visited pages stay mounted — outer div always in DOM, hidden via inline style */}
          <main className="flex-1 min-h-0 bg-ink-50 dark:bg-ink-950 flex flex-col overflow-hidden">
            {VALID_TABS.map(t => {
              const active  = t === tab;
              const isInbox = t === 'Inbox';
              return (
                <div key={t}
                  className={cn('flex-1 min-h-0', !isInbox && 'overflow-y-auto')}
                  style={active ? undefined : { display: 'none' }}>
                  {/* Render page content only after first visit — once mounted it never unmounts */}
                  {visited.has(t) && (isInbox ? (
                    <InboxPage toast={toast} setTab={t2 => setTab(t2 as TabId)} onUnreadCount={setInboxUnread} />
                  ) : (
                    <div className="p-6 mx-auto" style={{ maxWidth: 1320 }}>
                      {t === 'Dashboard'  && <DashboardPage  connected={!!connected} toast={toast} onTab={setTab} />}
                      {t === 'Analytics'  && <AnalyticsPage />}
                      {t === 'Assistant'  && <AssistantPage   connected={!!connected} toast={toast} />}
                      {t === 'History'    && <HistoryPage      toast={toast} />}
                      {t === 'CRM'        && <CrmPage          toast={toast} />}
                      {t === 'PMO'        && <PmoPage          toast={toast} />}
                      {t === 'CBU'        && <CbuPage />}
                      {t === 'Commission' && <CommissionPage />}
                      {t === 'Schematics' && <SchematicsPage   toast={toast} />}
                      {t === 'Docs'       && <DocsPage />}
                      {t === 'Settings'   && <SettingsPage config={config} onSave={async c => {
                        await api.saveConfig(c); setConfig(c); toast('ok', tCurrent.settings_saved);
                      }} />}
                    </div>
                  ))}
                </div>
              );
            })}
          </main>
        </div>
      </div>

      <FloatingAssistant onOpenFull={() => setTab('Assistant')} />
      <AnimatePresence>
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      </AnimatePresence>
      </>

      )}
    </LangCtx.Provider>
  );
}

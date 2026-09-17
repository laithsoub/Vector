// ─── App shell: sidebar, header, page routing ────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LayoutDashboard, History as HistoryIcon, BarChart3,
  ClipboardList, Calculator, BookOpen, Settings as SettingsIcon,
  Sparkles, Zap, Sun, Moon, Bell, Clock, CheckCircle2, AlertCircle, Info, X, Search,
  Loader2, RefreshCw, Mail, Send, Keyboard, Users, Gauge, Pin, PinOff,
  Lock, MessageSquarePlus, Rocket, Megaphone, ListTodo, Lightbulb, Tags, FolderTree,
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue } from 'motion/react';

import { useHotkeys } from '@mantine/hooks';
import { Spotlight, spotlight } from '@mantine/spotlight';

import { cn } from './lib/cn';
import { api } from './lib/api';
import { VectorMantine } from './lib/mantine';
import { notify } from './lib/notify';
import { failed } from './lib/errors';
import { openExternal, isTauri } from './lib/shell';
import { CancelDock } from './components/CancelDock';
import { LangCtx, useLang, T, type Lang } from './lib/i18n';
import { TabErrorBoundary } from './lib/ErrorBoundary';
import type { Config } from './types';

import { OverlayPage }     from './pages/Overlay';

// Every tab is code-split: the shell boots with the rail and the header, and a
// page's code arrives the first time it is opened. `visited` already delayed
// MOUNTING; this delays downloading and parsing too.
const DashboardPage  = React.lazy(() => import('./pages/Dashboard').then(m => ({ default: m.DashboardPage })));
const AnalyticsPage  = React.lazy(() => import('./pages/Analytics').then(m => ({ default: m.AnalyticsPage })));
const ReportPage     = React.lazy(() => import('./pages/Report').then(m => ({ default: m.ReportPage })));
const HistoryPage    = React.lazy(() => import('./pages/History').then(m => ({ default: m.HistoryPage })));
// InboxRoot picks the Outlook-style layout or the classic one (View → Classic layout).
const InboxPage      = React.lazy(() => import('./pages/InboxOutlook').then(m => ({ default: m.InboxRoot })));
const SettingsPage   = React.lazy(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));
const CrmPage        = React.lazy(() => import('./pages/Crm').then(m => ({ default: m.CrmPage })));
const ELInfoPage     = React.lazy(() => import('./pages/ELInfo').then(m => ({ default: m.ELInfoPage })));
const FentonKBPage   = React.lazy(() => import('./pages/FentonKB').then(m => ({ default: m.FentonKBPage })));
const TodoPage       = React.lazy(() => import('./pages/Todo').then(m => ({ default: m.TodoPage })));
// AI Assistant + Tools pages are lazy-imported below, gated on STRIPPED. In the
// stripped ship build that gate is a compile-time `true`, so Rollup dead-code-
// eliminates their code from the bundle; locally (full app) they load normally.

// ─── Tab definitions ─────────────────────────────────────────────────────────
type TabId =
  | 'Dashboard' | 'Assistant' | 'History' | 'Analytics' | 'Report' | 'Inbox' | 'Todo' | 'CRM' | 'ELInfo' | 'Fenton'
  | 'PMO' | 'CBU' | 'Commission' | 'Schematics' | 'Filing' | 'Docs' | 'LSD' | 'Settings';

// Stripped ship build vs full local app. The desktop ship is produced with
// `vite build` (import.meta.env.PROD === true). The full app runs ONLY via the
// dev server (localhost:3000, Vite middleware → PROD === false). Gating on PROD
// keeps localhost fully featured while the shipped bundle stays stripped — and
// lets Rollup drop the AI/Tools page code from the ship (lazy imports below).
const STRIPPED = import.meta.env.PROD;

// AI Assistant + the entire Tools section: locked behind a "Coming Soon" wall in
// the stripped ship (personal API keys / tooling not ready for rollout), full
// locally.
const LOCKED_TABS = new Set<TabId>(
  // Filing is locked in the ship build too: it writes to the shared D&Q Store,
  // which is not something a rolled-out copy should be able to do unattended.
  STRIPPED ? ['Assistant', 'ELInfo', 'Fenton', 'Todo', 'PMO', 'CBU', 'Commission', 'Schematics', 'Filing', 'Docs', 'LSD'] : [],
);
const isLocked = (t: TabId) => LOCKED_TABS.has(t);

// Lazy pages for the locked tabs. `STRIPPED ? null : lazy(...)` — in the ship
// build STRIPPED is literally `true`, so the dynamic import()s are dead-code-
// eliminated and never bundled. Locally they load on first visit.
const AssistantPage  = STRIPPED ? null : React.lazy(() => import('./pages/Assistant').then(m => ({ default: m.AssistantPage })));
const SchematicsPage = STRIPPED ? null : React.lazy(() => import('./pages/Schematics').then(m => ({ default: m.SchematicsPage })));
const FilingPage     = STRIPPED ? null : React.lazy(() => import('./pages/Filing').then(m => ({ default: m.FilingPage })));
const PmoPage        = STRIPPED ? null : React.lazy(() => import('./pages/PMO').then(m => ({ default: m.PmoPage })));
const CommissionPage = STRIPPED ? null : React.lazy(() => import('./pages/Commission').then(m => ({ default: m.CommissionPage })));
const DocsPage       = STRIPPED ? null : React.lazy(() => import('./pages/Docs').then(m => ({ default: m.DocsPage })));
const LsdPage        = STRIPPED ? null : React.lazy(() => import('./pages/LSD').then(m => ({ default: m.LsdPage })));
const CbuPage        = STRIPPED ? null : React.lazy(() => import('./pages/CBU').then(m => ({ default: m.CbuPage })));

// Title/description shown on each locked tab's Coming Soon wall.
const COMING_SOON: Partial<Record<TabId, { title: string; desc: string }>> = {
  Assistant:  { title: 'Ask Vector',        desc: 'Your in-app AI copilot for quotes, specs, and projects is being prepared for the whole team. Stay tuned.' },
  ELInfo:     { title: 'EL Internal Info',  desc: 'Your EL division internal-updates hub — digest, files and AI chat — is coming soon to your workspace.' },
  Fenton:     { title: 'Ask Fenton',        desc: "Our lighting application expert's answers, distilled into a searchable knowledge base. Coming soon to your workspace." },
  Todo:       { title: 'To-Do',             desc: 'AI triage of the shared mailbox into what you can finish, what is blocked, and what the team must pick up. Coming soon.' },
  Schematics: { title: 'Schematics Reader', desc: 'Automated schematic analysis is coming soon to your workspace.' },
  PMO:        { title: 'PMO',               desc: 'PMO automation is being readied for the team and will land here soon.' },
  CBU:        { title: 'CBU Sizer',         desc: 'The CBU sizing tool is coming soon to your workspace.' },
  Commission: { title: 'Commission',        desc: 'Commission tooling is coming soon to your workspace.' },
  Filing:     { title: 'D&Q Filing',        desc: 'Audit the quotes you have sent against the D&Q Store and file what is missing. Coming soon to your workspace.' },
  Docs:       { title: 'Doc Packs',         desc: 'Document pack generation is coming soon to your workspace.' },
  LSD:        { title: 'LSD Pricing',       desc: 'Drop a CPQ transaction, get the priced feedback sheet and its working file. Coming soon to your workspace.' },
};

// Static nav structure — labels resolved at render time via useLang()
const NAV_STRUCTURE = {
  waiting: {
    labelKey: 'navWaiting' as const,
    items: [
      { id: 'Todo'      as TabId, Icon: ListTodo,        labelKey: 'todo'      as const },
      { id: 'Inbox'     as TabId, Icon: Mail,            labelKey: 'inbox'     as const },
      { id: 'Assistant' as TabId, Icon: Sparkles,        labelKey: 'assistant' as const },
    ],
  },
  quote: {
    labelKey: 'navQuote' as const,
    items: [
      { id: 'Dashboard'  as TabId, Icon: LayoutDashboard, labelKey: 'dashboard'  as const },
      { id: 'LSD'        as TabId, Icon: Tags,            labelKey: 'lsd'        as const },
      { id: 'Schematics' as TabId, Icon: Zap,             labelKey: 'schematics' as const },
      { id: 'CBU'        as TabId, Icon: Calculator,      labelKey: 'cbuSizer'   as const },
      { id: 'Commission' as TabId, Icon: Gauge,           labelKey: 'commission' as const },
      { id: 'PMO'        as TabId, Icon: ClipboardList,   labelKey: 'pmo'        as const },
    ],
  },
  look: {
    labelKey: 'navLook' as const,
    items: [
      { id: 'CRM'    as TabId, Icon: Users,     labelKey: 'crm'      as const },
      { id: 'Fenton' as TabId, Icon: Lightbulb, labelKey: 'fenton'   as const },
      { id: 'ELInfo' as TabId, Icon: Megaphone, labelKey: 'elInfo'   as const },
      { id: 'Docs'   as TabId, Icon: BookOpen,  labelKey: 'docPacks' as const },
    ],
  },
  check: {
    labelKey: 'navCheck' as const,
    items: [
      { id: 'Filing'    as TabId, Icon: FolderTree,    labelKey: 'filing'    as const },
      { id: 'Report'    as TabId, Icon: ClipboardList, labelKey: 'report'    as const },
      { id: 'Analytics' as TabId, Icon: BarChart3,     labelKey: 'analytics' as const },
      { id: 'History'   as TabId, Icon: HistoryIcon,   labelKey: 'history'   as const },
    ],
  },
};

// Title keys per tab — resolved at render time
const TITLE_KEYS: Record<TabId, { t: keyof typeof T.en; s: keyof typeof T.en }> = {
  Dashboard: { t: 'dashboard',  s: 'sub_dashboard'  },
  Assistant: { t: 'assistant',  s: 'sub_assistant'  },
  Inbox:     { t: 'inbox',      s: 'sub_inbox'      },
  Todo:      { t: 'todo',       s: 'sub_todo'       },
  CRM:       { t: 'crm',        s: 'sub_crm'       },
  ELInfo:    { t: 'title_elInfo', s: 'sub_elInfo'  },
  Fenton:    { t: 'fenton',     s: 'sub_fenton'    },
  History:   { t: 'history',    s: 'sub_history'   },
  Analytics: { t: 'analytics',  s: 'sub_analytics' },
  Report:    { t: 'report',     s: 'sub_report'    },
  PMO:       { t: 'pmo',        s: 'sub_pmo'       },
  CBU:        { t: 'cbuSizer',    s: 'sub_cbu'        },
  Commission: { t: 'commission',  s: 'sub_commission' },
  Schematics:{ t: 'title_schematics', s: 'sub_schematics' },
  Filing:    { t: 'filing',     s: 'sub_filing'    },
  Docs:      { t: 'docPacks',   s: 'sub_docs'      },
  LSD:       { t: 'lsd',        s: 'sub_lsd'       },
  Settings:  { t: 'settings',   s: 'sub_settings'  },
};

// ─── Toast types ─────────────────────────────────────────────────────────────
export type ToastFn = (type: 'ok' | 'err' | 'info' | 'warn', msg: string) => void;
interface Toast { id: number; type: 'ok' | 'err' | 'info' | 'warn'; msg: string; }
let _tid = 0;

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({
  tab, setTab, todoOpen, inboxUnread, userInitials, userName, userEmail,
  pinned, setPinned, hovered, setHovered,
}: {
  tab: TabId;
  setTab: (t: TabId) => void;
  todoOpen: number;
  inboxUnread: number;
  userInitials: string;
  userName: string | null;
  userEmail: string | null;
  pinned: boolean;
  setPinned: (v: boolean) => void;
  hovered: boolean;
  setHovered: (v: boolean) => void;
}) {
  const { t } = useLang();
  // Active-nav item: layered surface + inset accent bar on the left edge.
  const activeShadow = { boxShadow: 'inset 2px 0 0 var(--accent)' };
  const navBtn = (active: boolean, locked: boolean) => cn(
    'w-full flex items-center gap-[11px] px-2.5 py-[7px] rounded-[var(--r-xs)] text-[12.5px] cursor-pointer transition-colors',
    active
      ? 'bg-[var(--s3)] text-[var(--t1)] font-semibold'
      : cn('font-[450] hover:bg-[var(--s3)] hover:text-[var(--t1)]',
           locked ? 'text-[var(--t3)]' : 'text-[var(--t2)]'),
  );
  return (
    <aside
      onMouseEnter={() => { if (!pinned) setHovered(true); }}
      onMouseLeave={() => { if (!pinned) setHovered(false); }}
      className={cn(
        'w-[238px] h-full flex flex-col border-r border-[var(--line)] bg-[var(--s1)] transition-transform duration-200 ease-out',
        pinned ? 'shrink-0 relative' : 'absolute inset-y-0 left-0 z-50 shadow-2xl',
        !pinned && !hovered && '-translate-x-full',
      )}>
      <div className="shrink-0 flex items-center gap-2.5 pt-[26px] px-[18px] pb-[18px]">
        <div className="w-[26px] h-[26px] shrink-0 rounded-[var(--r-xs)] flex items-center justify-center"
          style={{ background: 'var(--accent)' }}>
          <span className="text-[14px] font-bold leading-none tracking-[-0.06em] select-none" style={{ color: 'var(--accent-ink)' }}>V</span>
        </div>
        <div className="leading-[1.15] min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold tracking-[-0.02em] truncate">Vector</p>
        </div>
        <span className="shrink-0 text-[10px] text-[var(--t4)] num">v3.0</span>
        <button aria-label={pinned ? 'Unpin — auto-hide sidebar' : 'Pin sidebar open'}
          onClick={() => { setPinned(!pinned); setHovered(false); }}
          title={pinned ? 'Unpin — auto-hide sidebar' : 'Pin sidebar open'}
          className={cn(
            'shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center transition-colors',
            pinned
              ? 'text-[var(--t3)] hover:bg-[var(--s3)] hover:text-[var(--t1)]'
              : 'text-[var(--accent-text)] bg-[var(--accent-soft)]',
          )}>
          {pinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-[18px] px-3 flex flex-col gap-[26px] vec-scroll">
        {Object.entries(NAV_STRUCTURE).map(([key, sec]) => (
          <div key={key} className="flex flex-col gap-px">
            <div className="px-2.5 pb-[9px] text-[9.5px] font-bold tracking-[0.15em] uppercase text-[var(--t4)]">
              {t[sec.labelKey]}
            </div>
            {sec.items.map(it => {
              const active = it.id === tab;
              const locked = isLocked(it.id);
              const badge = it.id === 'Todo' ? todoOpen : it.id === 'Inbox' ? inboxUnread : 0;
              return (
                <button aria-label={locked ? 'Coming soon' : undefined} key={it.id} onClick={() => setTab(it.id)}
                  title={locked ? 'Coming soon' : undefined}
                  style={active ? activeShadow : undefined}
                  className={navBtn(active, locked)}>
                  <it.Icon className="w-4 h-4 shrink-0" style={active ? undefined : { opacity: 0.68 }} strokeWidth={1.7} />
                  <span className="flex-1 text-left truncate">{t[it.labelKey]}</span>
                  {locked && <Lock className="w-3 h-3 shrink-0 opacity-50" />}
                  {!locked && badge > 0 && (
                    <span className="min-w-[18px] h-[18px] px-[5px] rounded-[5px] text-[10px] font-semibold num flex items-center justify-center shrink-0 border border-[var(--line-2)]"
                      style={{ background: 'var(--s3)', color: 'var(--t2)' }}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="px-2.5 pb-3 pt-2 border-t border-[var(--line)] flex flex-col gap-0.5">
        <button onClick={() => setTab('Settings')}
          style={tab === 'Settings' ? activeShadow : undefined}
          className={navBtn(tab === 'Settings', false)}>
          <SettingsIcon className="w-[17px] h-[17px] shrink-0" strokeWidth={1.7} />
          <span className="flex-1 text-left">{t.settings}</span>
        </button>
        <div className="flex items-center gap-2.5 px-2.5 pt-2.5 pb-1 min-w-0">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0"
            style={{ background: 'linear-gradient(140deg, var(--accent), color-mix(in oklab, var(--accent) 50%, #8b5cf6))', color: 'var(--accent-ink)' }}>{userInitials}</div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[12px] font-medium truncate">{userName || (userEmail ? userEmail.split('@')[0] : 'Not connected')}</p>
            <p className="text-[10px] text-[var(--t3)] truncate mt-0.5">{userEmail || '—'}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({
  tab, setTab, dark, setDark, connected, userName, sessionElapsed,
  onConnect, connecting, notifs, hasNew, clearNew, onFeedback,
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
  onFeedback: () => void;
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

  const iconBtn = 'w-7 h-7 shrink-0 rounded-[var(--r-xs)] flex items-center justify-center text-[var(--t3)] hover:bg-[var(--s3)] hover:text-[var(--t1)] transition-colors';
  return (
    <header className="shrink-0 flex items-end gap-[18px] pt-[26px] px-[30px] pb-4 border-b border-[var(--line)] z-[5]"
      style={{ minHeight: 'var(--header-h)' }}>
      <div className="min-w-0">
        <h1 className="text-[21px] font-semibold leading-[1.15] tracking-[-0.028em]">{cur.t}</h1>
        <p className="text-[12.5px] text-[var(--t3)] mt-[5px] leading-[1.35] max-w-[62ch] truncate">{cur.s}</p>
      </div>

      <div className="flex-1" />

      {sessionElapsed && (
        <div className="hidden lg:flex items-center gap-1.5 text-[11.5px] text-[var(--t3)] num pr-0.5">
          <Clock className="w-[13px] h-[13px]" />
          {sessionElapsed}
        </div>
      )}

      <button aria-label={connecting ? tr.connecting : (userName || 'Click to connect to JOE')} onClick={onConnect} disabled={connecting}
        style={connected && !connecting
          ? { border: '1px solid color-mix(in oklab, var(--ok) 32%, transparent)', background: 'var(--ok-soft)', color: 'var(--ok)' }
          : undefined}
        className={cn(
          'h-8 px-[11px] rounded-[9px] text-[11.5px] font-semibold flex items-center gap-[7px] transition-colors border',
          connecting
            ? 'border-[var(--line-2)] bg-[var(--s2)] text-[var(--t3)] cursor-not-allowed'
            : !connected && 'border-[var(--line-2)] bg-[var(--s2)] text-[var(--t2)] hover:bg-[var(--s-hover)]',
        )}
        title={connecting ? tr.connecting : (userName || 'Click to connect to JOE')}>
        {connecting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <span className="w-1.5 h-1.5 rounded-full" style={{ background: connected ? 'var(--ok)' : 'var(--t3)' }} />}
        {connecting ? tr.connecting : connected ? (userName ? userName.split(' ')[0] : tr.connected) : tr.connectJoe}
        {connected && !connecting && <RefreshCw className="w-3 h-3 opacity-60" />}
      </button>

      <button aria-label="Send feedback" onClick={onFeedback} title="Send feedback"
        className="h-8 px-[11px] rounded-[9px] text-[11.5px] font-medium flex items-center gap-[7px] border border-[var(--line-2)] bg-[var(--s2)] text-[var(--t2)] hover:bg-[var(--s-hover)] hover:text-[var(--t1)] transition-colors">
        <MessageSquarePlus className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <button aria-label="Toggle theme" onClick={() => setDark((d: boolean) => !d)} title="Toggle theme" className={iconBtn}>
        {dark ? <Sun className="w-[15px] h-[15px]" /> : <Moon className="w-[15px] h-[15px]" />}
      </button>

      <div ref={notifRef} className="relative">
        <button onClick={() => { setNotifOpen(o => !o); clearNew(); }} className={cn(iconBtn, 'relative')}>
          <Bell className="w-[15px] h-[15px]" />
          {hasNew && <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-[var(--err)] border-[1.5px] border-[var(--s2)]" />}
        </button>
        <AnimatePresence>
          {notifOpen && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="absolute right-0 top-10 w-72 rounded-xl z-50 overflow-hidden v3-pop bg-[var(--s2)] border border-[var(--line)]">
              <p className="px-4 py-2.5 text-[10px] font-semibold text-[var(--t3)] uppercase tracking-widest border-b border-[var(--line)]">Activity</p>
              <div className="max-h-60 overflow-y-auto vec-scroll">
                {notifs.length === 0
                  ? <p className="px-4 py-5 text-[11.5px] text-[var(--t3)] text-center">No recent activity</p>
                  : notifs.map(t => (
                    <div key={t.id} className="flex items-start gap-2 px-4 py-2 border-b border-[var(--line)] last:border-0">
                      {t.type === 'ok'  ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--ok)' }} /> :
                       t.type === 'err' ? <AlertCircle  className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--err)' }} /> :
                                          <Info         className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />}
                      <p className="text-[11.5px] text-[var(--t2)]">{t.msg}</p>
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
    <div className="h-screen flex flex-col items-center justify-center bg-[var(--bg)] relative select-none">
      {/* Logo */}
      <div className="w-20 h-20 rounded-3xl bg-[var(--accent)] flex items-center justify-center mb-5 shadow-xl ring-4 ring-[var(--accent-line)]">
        <span className="text-white text-[40px] font-black leading-none tracking-tighter">V</span>
      </div>
      <h1 className="text-[26px] font-bold tracking-tight text-[var(--t1)]">Vector</h1>
      <p className="text-[12.5px] text-[var(--t3)] mt-1 mb-10">Quote Automation · v2.0</p>

      <button
        onClick={onConnect}
        disabled={connecting}
        className="h-11 px-8 rounded-xl text-[13.5px] font-semibold bg-[var(--t1)] text-[var(--bg)] hover:opacity-90 disabled:opacity-60 flex items-center gap-2.5 transition-colors shadow-sm">
        {connecting
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
        {connecting ? 'Connecting…' : 'Connect to JOE'}
      </button>

      <button
        onClick={onSkip}
        className="mt-4 text-[11.5px] text-[var(--t3)] hover:text-[var(--t2)] transition-colors underline-offset-2 hover:underline">
        Skip — enter without connection
      </button>

      <p className="absolute bottom-8 left-0 right-0 text-center text-[11px] text-[var(--t4)] px-8">
        Connects to the Eaton JOE SharePoint environment.
        Make sure you're on the Eaton network or VPN.
      </p>
    </div>
  );
}

// ─── Keyboard shortcuts modal ────────────────────────────────────────────────
const SHORTCUTS = [
  { key: 'Ctrl + K',  desc: 'Command palette — jump to any screen' },
  { key: 'Alt + 1',   desc: 'Dashboard' },
  { key: 'Alt + 2',   desc: 'Ask Vector' },
  { key: 'Alt + 3',   desc: 'Inbox' },
  { key: 'Alt + 4',   desc: 'History' },
  { key: 'Alt + 5',   desc: 'Analytics' },
  { key: 'Alt + 6',   desc: 'Job report' },
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
        className="bg-[var(--s1)] rounded-2xl shadow-2xl ring-1 ring-[var(--line-2)] p-5 w-80">
        <div className="flex items-center gap-2 mb-4">
          <Keyboard className="w-4 h-4 text-[var(--t3)]" />
          <span className="text-[13px] font-semibold flex-1">Keyboard Shortcuts</span>
          <button aria-label="Close" onClick={onClose} className="w-6 h-6 flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-1.5">
          {SHORTCUTS.map(s => (
            <div key={s.key} className="flex items-center justify-between py-1 border-b border-[var(--line)] last:border-0">
              <span className="text-[12px] text-[var(--t2)]">{s.desc}</span>
              <kbd className="px-2 py-0.5 rounded-md bg-[var(--s3)] text-[10.5px] font-mono text-[var(--t2)] border border-[var(--line-2)]">{s.key}</kbd>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10.5px] text-[var(--t3)] text-center">Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--s3)] text-[10px] font-mono border border-[var(--line-2)]">?</kbd> anytime to toggle</p>
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
                       bg-[var(--s1)] rounded-2xl shadow-2xl
                       ring-1 ring-[var(--line-2)] overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-2 px-3.5 py-2 border-b border-[var(--line)] shrink-0">
              <div className="w-5 h-5 rounded-md bg-[var(--accent)] flex items-center justify-center shrink-0">
                <span className="text-white text-[11px] font-black leading-none">V</span>
              </div>
              <span className="flex-1 text-[12px] font-semibold">Ask Vector</span>
              <button onClick={() => { onOpenFull(); setOpen(false); }}
                className="text-[10.5px] text-[var(--accent-text)] hover:text-[var(--accent-text)] font-medium mr-1">
                Full view →
              </button>
              <button aria-label="Clear chat" onClick={() => setMsgs([])} title="Clear chat"
                className="w-5 h-5 flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)]">
                <RefreshCw className="w-3 h-3" />
              </button>
              <button aria-label="Close" onClick={() => setOpen(false)}
                className="w-5 h-5 flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)]">
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Messages */}
            <div ref={bodyRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {msgs.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
                  <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-[var(--accent-text)]" />
                  </div>
                  <p className="text-[11.5px] font-medium text-[var(--t2)]">How can I help?</p>
                  <p className="text-[10.5px] text-[var(--t3)] leading-snug">Ask anything about quotes, specs, or projects.</p>
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[85%] px-2.5 py-1.5 rounded-xl text-[11.5px] leading-relaxed whitespace-pre-wrap break-words',
                    m.role === 'user'
                      ? 'bg-[var(--accent)] text-white rounded-br-sm'
                      : 'bg-[var(--s3)] text-[var(--t1)] rounded-bl-sm',
                  )}>{m.text}</div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-[var(--s3)] px-2.5 py-2 rounded-xl rounded-bl-sm">
                    <Loader2 className="w-3 h-3 text-[var(--t3)] animate-spin" />
                  </div>
                </div>
              )}
            </div>

            {/* Escalation banner */}
            {shouldEscalate && (
              <div className="px-3 py-1.5 bg-[var(--accent-soft)] border-t border-[var(--accent-line)] flex items-center gap-2 shrink-0">
                <Sparkles className="w-3 h-3 text-[var(--accent-text)] shrink-0" />
                <p className="text-[10.5px] text-[var(--accent-text)] flex-1">Getting complex — try full view.</p>
                <button onClick={() => { onOpenFull(); setOpen(false); }}
                  className="text-[10.5px] font-semibold text-[var(--accent-text)] hover:text-[var(--accent-text)] whitespace-nowrap">Open →</button>
              </div>
            )}

            {/* Input */}
            <div className="px-3 py-2 border-t border-[var(--line)] shrink-0 flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask anything… (Enter to send)"
                className="flex-1 resize-none text-[11.5px] bg-transparent outline-none text-[var(--t1)] placeholder:text-[var(--t3)] leading-relaxed py-0.5"
              />
              <button aria-label="Send message" onClick={send} disabled={!input.trim() || loading}
                className={cn(
                  'w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors mb-0.5',
                  input.trim() && !loading
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'bg-[var(--s3)] text-[var(--t3)] cursor-not-allowed',
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
                : 'bg-white/90 dark:bg-[var(--s2)] backdrop-blur text-[var(--t3)] ring-1 ring-[var(--line-2)]',
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
          'w-9 h-9 rounded-xl bg-[var(--accent)] text-white shadow-lg z-[9999]',
          'flex items-center justify-center hover:bg-[var(--accent-hover)] transition-colors',
          isDragging ? 'cursor-grabbing opacity-80' : 'cursor-grab',
        )}>
        {open
          ? <X className="w-4 h-4" />
          : <span className="text-[15px] font-black leading-none tracking-tighter select-none">V</span>}
        {hasUnread && !open && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-[var(--s1)]" />
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

// ─── Coming Soon (locked feature wall) ───────────────────────────────────────
function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="relative h-full min-h-[460px] w-full overflow-hidden rounded-[18px] border border-[var(--line)]">
      {/* Blurred faux content behind the wall */}
      <div aria-hidden className="absolute inset-0 blur-[7px] opacity-40 pointer-events-none select-none p-[26px]">
        <div className="h-[34px] w-1/3 rounded-[10px] bg-[var(--s3)] mb-[18px]" />
        <div className="grid grid-cols-3 gap-4 mb-[18px]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[110px] rounded-[14px] bg-[var(--s2)] border border-[var(--line)]" />
          ))}
        </div>
        <div className="h-[180px] rounded-[14px] bg-[var(--s2)] border border-[var(--line)]" />
      </div>
      {/* Overlay card */}
      <div className="absolute inset-0 flex items-center justify-center backdrop-blur-[2px]"
        style={{ background: 'color-mix(in oklab, var(--bg) 45%, transparent)' }}>
        <div className="text-center max-w-[400px] px-9 py-[38px] rounded-[20px] v3-pop bg-[var(--s2)] border border-[var(--line)]">
          <div className="w-[52px] h-[52px] mx-auto rounded-[15px] bg-[var(--accent-soft)] text-[var(--accent-text)] flex items-center justify-center mb-4">
            <Rocket className="w-6 h-6" />
          </div>
          <div className="inline-flex items-center gap-1.5 px-[11px] py-1 rounded-full bg-[var(--s3)] border border-[var(--line)] text-[10px] font-semibold tracking-wide uppercase text-[var(--t2)] mb-3.5 whitespace-nowrap">
            <Lock className="w-3 h-3" /> Coming soon
          </div>
          <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-[var(--t1)]">{title}</h2>
          <p className="text-[12.5px] text-[var(--t2)] mt-2.5 leading-relaxed">{desc}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Feedback modal ──────────────────────────────────────────────────────────
const FEEDBACK_CATEGORIES = ['Bug', 'Idea', 'Question', 'Other'] as const;

function FeedbackModal({
  onClose, currentTab, userName, userEmail, toast,
}: {
  onClose: () => void;
  currentTab: TabId;
  userName: string | null;
  userEmail: string | null;
  toast: ToastFn;
}) {
  const [category, setCategory] = useState<string>('Idea');
  const [message,  setMessage]  = useState('');
  const [sending,  setSending]  = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => taRef.current?.focus(), 120); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit() {
    const msg = message.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      const r = await api.feedback({ message: msg, category, page: currentTab, userName, userEmail });
      if (r.ok) { toast('ok', 'Feedback sent — thank you'); onClose(); }
      else      { toast('err', failed('send your feedback', r.error)); }
    } catch (e: any) {
      toast('err', failed('send your feedback', e));
    }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        onClick={e => e.stopPropagation()}
        className="bg-[var(--s1)] rounded-2xl shadow-2xl ring-1 ring-[var(--line-2)] p-5 w-[400px]">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquarePlus className="w-4 h-4 text-[var(--accent-text)]" />
          <span className="text-[13px] font-semibold flex-1">Send feedback</span>
          <button aria-label="Close" onClick={onClose} className="w-6 h-6 flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex gap-1.5 mb-3">
          {FEEDBACK_CATEGORIES.map(c => (
            <button key={c} onClick={() => setCategory(c)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-[11.5px] font-medium ring-1 ring-inset transition-colors',
                category === c
                  ? 'bg-[var(--t1)] text-[var(--bg)] ring-transparent'
                  : 'bg-[var(--s1)] text-[var(--t2)] ring-[var(--line-2)] hover:bg-[var(--s3)]',
              )}>{c}</button>
          ))}
        </div>

        <textarea
          ref={taRef}
          rows={5}
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          placeholder="What's working, what's broken, what you'd love to see…"
          className="w-full resize-none text-[12.5px] rounded-xl bg-[var(--s3)] ring-1 ring-inset ring-[var(--line-2)] p-3 outline-none focus:ring-[var(--accent-line)] text-[var(--t1)] placeholder:text-[var(--t3)] leading-relaxed"
        />

        <div className="flex items-center justify-between mt-4">
          <span className="text-[10.5px] text-[var(--t3)]">Goes to the Vector team</span>
          <button onClick={submit} disabled={!message.trim() || sending}
            className={cn(
              'h-9 px-4 rounded-xl text-[12.5px] font-semibold flex items-center gap-2 transition-colors',
              message.trim() && !sending
                ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                : 'bg-[var(--s3)] text-[var(--t3)] cursor-not-allowed',
            )}>
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── First-run welcome modal ─────────────────────────────────────────────────
const WELCOME_KEY = 'vector_welcome_seen_v1';

function WelcomeModal({ onClose }: { onClose: () => void }) {
  const steps = [
    { Icon: Zap,               title: 'Connect to JOE',  body: 'Hit “Connect to JOE” (top bar) while on the Eaton network or VPN to sync your quotes.' },
    { Icon: LayoutDashboard,   title: 'Process quotes',  body: 'Drop PDFs on the Dashboard to auto-extract, file, and upload to the D&Q Store.' },
    { Icon: ClipboardList,     title: 'Tools',           body: 'PMO, CBU sizer, Commission, and Doc packs live in the sidebar under Tools.' },
    { Icon: MessageSquarePlus, title: 'Send feedback',   body: 'Use the feedback button (top bar) anytime — it reaches the team directly.' },
  ];
  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <motion.div initial={{ opacity: 0, scale: 0.94, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.94 }}
        className="bg-[var(--s1)] rounded-2xl shadow-2xl ring-1 ring-[var(--line-2)] p-6 w-[440px]">
        <div className="flex flex-col items-center text-center mb-5">
          <div className="w-14 h-14 rounded-2xl bg-[var(--accent)] flex items-center justify-center mb-3 shadow-lg ring-4 ring-[var(--accent-line)]">
            <span className="text-white text-[28px] font-black leading-none tracking-tighter">V</span>
          </div>
          <h2 className="text-[18px] font-bold tracking-tight text-[var(--t1)]">Welcome to Vector</h2>
          <p className="text-[12px] text-[var(--t3)] mt-1">Eaton Quote &amp; PMO automation · v2.0</p>
        </div>

        <div className="space-y-2.5 mb-6">
          {steps.map(s => (
            <div key={s.title} className="flex items-start gap-3 p-2.5 rounded-xl bg-[var(--s3)]">
              <div className="w-8 h-8 rounded-lg bg-[var(--s1)] ring-1 ring-[var(--line-2)] flex items-center justify-center shrink-0">
                <s.Icon className="w-4 h-4 text-[var(--accent-text)]" />
              </div>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-[var(--t1)]">{s.title}</p>
                <p className="text-[11.5px] text-[var(--t3)] leading-snug mt-0.5">{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <button onClick={onClose}
          className="w-full h-11 rounded-xl text-[13.5px] font-semibold bg-[var(--t1)] text-[var(--bg)] hover:opacity-90 transition-colors">
          Get started
        </button>
      </motion.div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ────────────────────────────────────────────────────────────────────────────
// Every tab the app will route to and mount a panel for. Derived from the nav
// rather than hand-listed: this used to be a literal array, and a tab added to
// NAV_STRUCTURE but forgotten here got a working sidebar button that switched to
// a blank screen, because the render loop below never emitted a panel for it.
// Settings is appended because its button lives in the sidebar footer, not the nav.
const VALID_TABS: TabId[] = [
  ...Object.values(NAV_STRUCTURE).flatMap(g => g.items.map(i => i.id)),
  'Settings',
];

// Content width per tab, straight from the v2 canvas: every screen there is
// `padding:var(--pad-page)` around a centred column of this width. Framing the
// pages from here rather than inside each one keeps the 16 page files free of
// layout boilerplate — change a number here and that screen re-frames.
// 0 = full-bleed: the page owns the whole area (Assistant's chat, Inbox's panes).
const PAGE_FRAME: Record<TabId, number> = {
  Dashboard: 1240, Assistant: 0,    Inbox: 0,     Todo: 1240,
  CRM:       1240, ELInfo:    1100, Fenton: 1180, History: 1240,
  Analytics: 1240, Report:    1100, LSD:    1240, PMO:     1100,
  CBU:       1140, Commission: 1000, Schematics: 1240, Filing: 960,
  Docs:       960, Settings:   680,
};

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

  // Dark is the default the canvas is drawn in; only an explicit saved choice
  // ("light") opts out, so a first run matches the design rather than inverting it.
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Sidebar pin / auto-hide
  const [sidebarPinned, setSidebarPinned] = useState(() => localStorage.getItem('vector_sidebar_pinned') !== '0');
  const [sidebarHover, setSidebarHover]   = useState(false);
  useEffect(() => { localStorage.setItem('vector_sidebar_pinned', sidebarPinned ? '1' : '0'); }, [sidebarPinned]);

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

  // Toasts. Mantine owns the on-screen stack now — it can update a toast in
  // place ("Uploading…" → "Uploaded"), which an array of fire-and-forget divs
  // could not. We keep a short local history only to fill the header's bell.
  const [recentNotifs, setRecentNotifs] = useState<Toast[]>([]);
  const [hasNew, setHasNew] = useState(false);
  const toast: ToastFn = useCallback((type, msg) => {
    notify(type, msg);
    setRecentNotifs(p => [{ id: ++_tid, type, msg }, ...p].slice(0, 20));
    setHasNew(true);
  }, []);

  // Embed mode — used by outlook_overlay.py (PyWebView companion). Renders
  // only the Overlay page (no sidebar, no header, no splash). Toasts come from
  // the same Mantine layer as the main window, so there is no second
  // hand-rolled stack to keep in sync.
  const embedMode = typeof window !== 'undefined' && /(^|[?&])embed=1(&|$)/.test(window.location.search);
  if (embedMode) {
    return (
      <VectorMantine dark={dark}>
        <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
          <OverlayPage toast={toast} />
        </LangCtx.Provider>
      </VectorMantine>
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
  // The v2 sidebar badges what is still owed, not what is queued.
  const [todoOpen, setTodoOpen] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => !localStorage.getItem(WELCOME_KEY));
  const dismissWelcome = useCallback(() => {
    localStorage.setItem(WELCOME_KEY, '1');
    setWelcomeOpen(false);
  }, []);

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
    // Separate try/catch: the Todo sweep needs Outlook, and a failure there must
    // not blank the header. The canvas shows this badge on load, so the count is
    // fetched here rather than waiting for the Todo page to mount.
    try {
      const todo = await api.todoList('open');
      setTodoOpen(todo.items?.length ?? 0);
    } catch { /* leave the badge as it is */ }
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
        toast('err', failed('connect to JOE', detail || r.error || 'see vector.log for the reason'));
      }
      await refreshHeader();
    } catch (e: any) {
      toast('err', failed('connect to JOE', e));
    }
    setConnecting(false);
  }

  // One way into a tab, used by both the hotkeys and the palette, so a locked
  // tab explains itself instead of silently doing nothing.
  const go = useCallback((t: TabId) => {
    if (isLocked(t)) { toast('info', `${COMING_SOON[t]?.title ?? t} is coming soon`); return; }
    setTab(t);
  }, [setTab, toast]);

  // Keyboard shortcuts. useHotkeys already ignores INPUT/TEXTAREA/SELECT, so the
  // hand-rolled tag check is gone, and `mod+` is Ctrl on Windows / ⌘ on macOS.
  // Ctrl+K opens the command palette now rather than jumping to a single tab.
  useHotkeys([
    ['mod+K',   () => spotlight.open()],
    ['shift+/', () => setShortcutsOpen(o => !o)],
    ['alt+1',   () => go('Dashboard')],
    ['alt+2',   () => go('Assistant')],
    ['alt+3',   () => go('Inbox')],
    ['alt+4',   () => go('History')],
    ['alt+5',   () => go('Analytics')],
    ['alt+6',   () => go('Report')],
  ]);

  // Palette actions come from the same NAV_STRUCTURE the sidebar renders, so a
  // new tab shows up in both or in neither — they cannot drift apart.
  const spotlightActions = React.useMemo(() => [
    ...Object.values(NAV_STRUCTURE).map(group => ({
      group: tCurrent[group.labelKey] as string,
      actions: group.items.map(({ id, Icon, labelKey }) => ({
        id,
        label: tCurrent[labelKey] as string,
        description: tCurrent[TITLE_KEYS[id].s] as string,
        leftSection: <Icon className="w-[15px] h-[15px]" strokeWidth={1.9} />,
        onClick: () => go(id),
      })),
    })),
    {
      group: 'Workspace',
      actions: [{
        id: 'Settings',
        label: tCurrent.settings as string,
        description: tCurrent.sub_settings as string,
        leftSection: <SettingsIcon className="w-[15px] h-[15px]" strokeWidth={1.9} />,
        onClick: () => go('Settings'),
      }],
    },
  ], [tCurrent, go]);

  // In the packaged Tauri app the whole UI is one WebView2 window, where a plain
  // <a target="_blank"> (or any external link) navigates that single window
  // instead of opening a new one — so a stray link would replace the app. Delegate
  // every such click to the OS browser via openExternal, keeping the app window
  // put. No-op in a normal browser (native _blank works there).
  useEffect(() => {
    if (!isTauri()) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      const external = /^https?:\/\//i.test(href) && !href.startsWith(location.origin);
      if (a.getAttribute('target') === '_blank' || external) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const userInitials = userName
    ? userName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()
    : '—';

  return (
    <VectorMantine dark={dark}>
    <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
      <Spotlight
        actions={spotlightActions}
        nothingFound="Nothing matches that"
        highlightQuery
        limit={8}
        scrollAreaProps={{ type: 'never' }}
        searchProps={{
          placeholder: 'Jump to a screen…',
          leftSection: <Search className="w-4 h-4" />,
        }}
      />
      <CancelDock />

      {/* ── Splash screen — shown until first successful connection or skipped ── */}
      {!splashDone ? (
        <SplashScreen onConnect={onConnect} onSkip={() => setSplashDone(true)} connecting={connecting} />
      ) : (

      <>
      <div className="flex h-screen min-h-0 relative text-[var(--t1)]"
        style={{ backgroundColor: 'var(--bg)', backgroundImage: 'radial-gradient(120% 90% at 100% 0%, var(--bg-grad) 0%, var(--bg) 55%)' }}>
        {/* Auto-hide hover trigger — thin rail at the left edge when unpinned */}
        {!sidebarPinned && !sidebarHover && (
          <div className="absolute inset-y-0 left-0 w-2.5 z-40" onMouseEnter={() => setSidebarHover(true)} />
        )}
        <Sidebar
          tab={tab} setTab={setTab} todoOpen={todoOpen} inboxUnread={inboxUnread}
          userInitials={userInitials} userName={userName} userEmail={userEmail}
          pinned={sidebarPinned} setPinned={setSidebarPinned}
          hovered={sidebarHover} setHovered={setSidebarHover}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <Header
            tab={tab} setTab={setTab} dark={dark} setDark={setDark}
            connected={connected} userName={userName} sessionElapsed={elapsed}
            onConnect={onConnect}
            connecting={connecting}
            notifs={recentNotifs} hasNew={hasNew} clearNew={() => setHasNew(false)}
            onFeedback={() => setFeedbackOpen(true)}
          />
          {/* All visited pages stay mounted — outer div always in DOM, hidden via inline style */}
          <main className="flex-1 min-h-0 flex flex-col overflow-hidden vec-scroll">
            {VALID_TABS.map(t => {
              const active  = t === tab;
              const isInbox = t === 'Inbox';
              const frame   = PAGE_FRAME[t] ?? 1240;
              return (
                <div key={t}
                  className={cn('flex-1 min-h-0', !isInbox && 'overflow-y-auto')}
                  style={active ? undefined : { display: 'none' }}>
                  {/* Locked features show a Coming Soon wall — their real page never mounts */}
                  {isLocked(t) ? (
                    <div className="w-full h-full" style={{ padding: 'var(--pad-page)' }}>
                      <ComingSoon
                        title={COMING_SOON[t]?.title || t}
                        desc={COMING_SOON[t]?.desc || 'This feature is coming soon to your workspace.'}
                      />
                    </div>
                  ) : visited.has(t) && (isInbox ? (
                    <TabErrorBoundary label="Inbox">
                      <React.Suspense fallback={<div className="flex items-center justify-center h-full text-[var(--t3)]"><Loader2 className="w-5 h-5 animate-spin" /></div>}>
                        <InboxPage toast={toast} setTab={t2 => setTab(t2 as TabId)} onUnreadCount={setInboxUnread} />
                      </React.Suspense>
                    </TabErrorBoundary>
                  ) : (
                    // maxWidth carries the gutters too: border-box counts the
                    // padding inside it, so the column itself lands on `frame`.
                    <div className="w-full mx-auto"
                      style={frame
                        ? { padding: 'var(--pad-page)', maxWidth: `calc(${frame}px + var(--pad-page) * 2)` }
                        : undefined}>
                      <TabErrorBoundary label={t}>
                      <React.Suspense fallback={<div className="flex items-center justify-center py-20 text-[var(--t3)]"><Loader2 className="w-5 h-5 animate-spin" /></div>}>
                      {t === 'Dashboard'  && <DashboardPage  connected={!!connected} toast={toast} onTab={setTab} />}
                      {t === 'Analytics'  && <AnalyticsPage />}
                      {t === 'Report'     && <ReportPage      toast={toast} />}
                      {t === 'Todo'       && <TodoPage        toast={toast} onOpenCount={setTodoOpen} />}
                      {t === 'History'    && <HistoryPage      toast={toast} />}
                      {t === 'CRM'        && <CrmPage          toast={toast} />}
                      {t === 'ELInfo'     && <ELInfoPage       toast={toast} />}
                      {t === 'Fenton'     && <FentonKBPage     toast={toast} />}
                      {t === 'Assistant'  && AssistantPage  && <AssistantPage  connected={!!connected} toast={toast} />}
                      {t === 'Schematics' && SchematicsPage && <SchematicsPage toast={toast} />}
                {t === 'Filing'     && FilingPage     && <FilingPage toast={toast} />}
                      {t === 'PMO'        && PmoPage        && <PmoPage        toast={toast} />}
                      {t === 'Commission' && CommissionPage && <CommissionPage />}
                      {t === 'Docs'       && DocsPage       && <DocsPage       toast={toast} />}
                      {t === 'LSD'        && LsdPage        && <LsdPage        toast={toast} />}
                      {t === 'CBU'        && CbuPage       && <CbuPage />}
                      {t === 'Settings'   && <SettingsPage config={config} onSave={async c => {
                        await api.saveConfig(c); setConfig(c); toast('ok', tCurrent.settings_saved);
                      }} />}
                      </React.Suspense>
                      </TabErrorBoundary>
                    </div>
                  ))}
                </div>
              );
            })}
          </main>
        </div>
      </div>

      <AnimatePresence>
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
        {feedbackOpen && (
          <FeedbackModal
            onClose={() => setFeedbackOpen(false)}
            currentTab={tab} userName={userName} userEmail={userEmail} toast={toast}
          />
        )}
        {welcomeOpen && <WelcomeModal onClose={dismissWelcome} />}
      </AnimatePresence>
      </>

      )}
    </LangCtx.Provider>
    </VectorMantine>
  );
}

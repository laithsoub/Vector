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


import { cn } from './lib/cn';
import { api } from './lib/api';
import {
  VectorProvider, CommandPalette, ScreenScope, useAppHotkeys, useFormHotkeys, notify, openPalette,
  Badge, Button, EmptyState, IconButton, Indicator, Menu, Modal, Segmented, Shortcut, Textarea, Tooltip,
  type PaletteGroup, type ShortcutName,
} from './ui';
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
// Component gallery for the v3 redesign. Opened with ?ui-sample or #ui-sample.
const UiSamplePage   = React.lazy(() => import('./pages/UiSample').then(m => ({ default: m.UiSamplePage })));
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
  // Active item: weight + a 2px ink rule on the leading edge. No filled pill.
  const navBtn = (active: boolean, locked: boolean) => cn(
    'relative w-full h-h-sm flex items-center gap-2.5 px-2 rounded-control text-sm transition-colors duration-fast',
    active
      ? 'bg-subtle text-fg font-medium before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-signal'
      : cn('hover:bg-hover hover:text-fg', locked ? 'text-fg-4' : 'text-fg-2'),
  );
  return (
    <aside
      onMouseEnter={() => { if (!pinned) setHovered(true); }}
      onMouseLeave={() => { if (!pinned) setHovered(false); }}
      className={cn(
        'w-sidebar h-full flex flex-col border-r border-line bg-page transition-transform',
        pinned ? 'shrink-0 relative' : 'absolute inset-y-0 left-0 z-sidebar shadow-float',
        !pinned && !hovered && '-translate-x-full',
      )}>
      <div className="shrink-0 h-header flex items-center gap-2 px-4 border-b border-line">
        <div className="w-5 h-5 shrink-0 rounded-control bg-accent text-on-accent flex items-center justify-center ring-1 ring-signal ring-offset-1 ring-offset-page">
          <span className="text-xs font-semibold leading-none select-none">V</span>
        </div>
        <p className="flex-1 min-w-0 text-base font-semibold tracking-tight truncate">Vector</p>
        <span className="shrink-0 mono text-2xs text-fg-4">v3</span>
        <IconButton size="sm" icon={pinned ? Pin : PinOff} active={!pinned}
          label={pinned ? 'Unpin — auto-hide sidebar' : 'Pin sidebar open'}
          onClick={() => { setPinned(!pinned); setHovered(false); }} />
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-2 flex flex-col gap-5">
        {Object.entries(NAV_STRUCTURE).map(([key, sec]) => (
          <div key={key} className="flex flex-col gap-px">
            <div className="eyebrow px-2 pb-1.5">{t[sec.labelKey]}</div>
            {sec.items.map(it => {
              const active = it.id === tab;
              const locked = isLocked(it.id);
              const badge = it.id === 'Todo' ? todoOpen : it.id === 'Inbox' ? inboxUnread : 0;
              return (
                <button key={it.id} onClick={() => setTab(it.id)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={locked ? `${t[it.labelKey]} — coming soon` : undefined}
                  title={locked ? 'Coming soon' : undefined}
                  className={navBtn(active, locked)}>
                  <it.Icon className={cn('w-4 h-4 shrink-0', active ? 'text-accent-text' : 'text-fg-3')} strokeWidth={1.75} />
                  <span className="flex-1 text-left truncate">{t[it.labelKey]}</span>
                  {locked && <Lock className="w-3 h-3 shrink-0 text-fg-4" />}
                  {!locked && badge > 0 && (
                    <span className={cn('mono text-2xs shrink-0 inline-flex items-center gap-1', active ? 'text-fg' : 'text-fg-2')}>
                      {it.id === 'Inbox' && <span className="w-1.5 h-1.5 rounded-full bg-signal" />}{badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="shrink-0 px-2 py-2 border-t border-line flex flex-col gap-1">
        <button onClick={() => setTab('Settings')}
          aria-current={tab === 'Settings' ? 'page' : undefined}
          className={navBtn(tab === 'Settings', false)}>
          <SettingsIcon className={cn('w-4 h-4 shrink-0', tab === 'Settings' ? 'text-accent-text' : 'text-fg-3')} strokeWidth={1.75} />
          <span className="flex-1 text-left">{t.settings}</span>
        </button>
        <div className="flex items-center gap-2.5 px-2 py-1.5 min-w-0">
          <div className="w-6 h-6 rounded-full bg-accent-soft text-accent-text flex items-center justify-center text-2xs font-semibold shrink-0">
            {userInitials}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-sm font-medium truncate">{userName || (userEmail ? userEmail.split('@')[0] : 'Not connected')}</p>
            <p className="text-2xs text-fg-3 truncate">{userEmail || '—'}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({
  tab, dark, setDark, connected, userName, sessionElapsed,
  onConnect, connecting, notifs, hasNew, clearNew, onFeedback,
}: {
  tab: TabId;
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
  const connectLabel = connecting ? tr.connecting : (userName || 'Click to connect to JOE');

  return (
    <header className="shrink-0 h-header flex items-center gap-3 px-page border-b border-line bg-page">
      <div className="min-w-0 flex-1 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight truncate shrink-0 max-w-full">{cur.t}</h1>
        <p className="hidden xl:block text-sm text-fg-3 truncate min-w-0">{cur.s}</p>
      </div>

      <button onClick={openPalette}
        className="hidden lg:flex shrink-0 items-center gap-2 h-h-sm pl-2.5 pr-1.5 w-48 rounded-control border border-line-2 bg-surface text-sm text-fg-4 hover:border-line-3 transition-colors">
        <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
        <span className="flex-1 text-left">Jump to…</span>
        <Shortcut keys="palette" className="signal-keys" />
      </button>

      {sessionElapsed && (
        <Tooltip label="Time in this session">
          <span className="hidden 2xl:flex shrink-0 items-center gap-1.5 mono text-xs text-fg-3 whitespace-nowrap">
            <Clock className="w-3 h-3" strokeWidth={1.75} />
            {sessionElapsed}
          </span>
        </Tooltip>
      )}

      <Button tone="secondary" className="shrink-0" onClick={onConnect} disabled={connecting} hint={connectLabel} aria-label={connectLabel}
        icon={connecting
          ? <Loader2 className="animate-spin" />
          : <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-ok' : 'bg-fg-4')} />}
        trailing={connected && !connecting ? <RefreshCw className="w-3 h-3 text-fg-4" strokeWidth={1.75} /> : undefined}>
        {connecting ? tr.connecting : connected ? (userName ? userName.split(',')[0].split(' ')[0] : tr.connected) : tr.connectJoe}
      </Button>

      <IconButton icon={MessageSquarePlus} label="Send feedback" onClick={onFeedback} />

      <IconButton icon={dark ? Sun : Moon} label={dark ? 'Light theme' : 'Dark theme'} shortcut="theme"
        onClick={() => setDark((d: boolean) => !d)} />

      <Menu position="bottom-end" width="var(--popover-w)" onOpen={clearNew}>
        <Menu.Target>
          <Indicator disabled={!hasNew} size={6} offset={7} color="err" withBorder={false}>
            <IconButton icon={Bell} label="Activity" />
          </Indicator>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Activity</Menu.Label>
          <div className="max-h-72 overflow-y-auto">
            {notifs.length === 0
              ? <EmptyState compact title="No recent activity" />
              : notifs.map(n => (
                <div key={n.id} className="flex items-start gap-2 px-2 py-1.5 border-t border-line first:border-0">
                  {n.type === 'ok'   ? <CheckCircle2  className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ok" /> :
                   n.type === 'err'  ? <AlertCircle   className="w-3.5 h-3.5 mt-0.5 shrink-0 text-err" /> :
                   n.type === 'warn' ? <AlertCircle   className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warn" /> :
                                       <Info          className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent-text" />}
                  <p className="text-sm text-fg-2 leading-snug">{n.msg}</p>
                </div>
              ))}
          </div>
        </Menu.Dropdown>
      </Menu>
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
    <div className="h-screen flex flex-col items-center justify-center bg-page relative select-none">
      <div className="w-10 h-10 rounded-panel bg-accent text-on-accent flex items-center justify-center mb-4">
        <span className="text-2xl font-semibold leading-none">V</span>
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-fg">Vector</h1>
      <p className="mono text-xs text-fg-3 mt-1 mb-8">Quote automation · v3</p>

      <Button tone="primary" size="md" onClick={onConnect} loading={connecting}
        icon={<span className="w-1.5 h-1.5 rounded-full bg-on-accent" />}>
        {connecting ? 'Connecting…' : 'Connect to JOE'}
      </Button>
      <Button tone="ghost" size="xs" className="mt-2" onClick={onSkip}>
        Skip — enter without connection
      </Button>

      <p className="absolute bottom-8 left-0 right-0 text-center text-xs text-fg-4 px-8">
        Connects to the Eaton JOE SharePoint environment.
        Make sure you're on the Eaton network or VPN.
      </p>
    </div>
  );
}

// ─── Keyboard shortcuts sheet ────────────────────────────────────────────────
const SHORTCUT_SHEET: { keys: ShortcutName | string; desc: string }[] = [
  { keys: 'palette',     desc: 'Command palette — jump to any screen' },
  { keys: 'goDashboard', desc: 'Dashboard' },
  { keys: 'goAssistant', desc: 'Ask Vector' },
  { keys: 'goInbox',     desc: 'Inbox' },
  { keys: 'goHistory',   desc: 'History' },
  { keys: 'goAnalytics', desc: 'Analytics' },
  { keys: 'goReport',    desc: 'Job report' },
  { keys: 'save',        desc: 'Save on the current screen' },
  { keys: 'submit',      desc: 'Submit the open form' },
  { keys: 'theme',       desc: 'Switch light / dark' },
  { keys: 'help',        desc: 'Toggle this panel' },
  { keys: 'close',       desc: 'Close any dialog or panel' },
];

function ShortcutsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} size="var(--modal-sm)"
      title={<span className="flex items-center gap-2"><Keyboard className="w-4 h-4 text-fg-3" strokeWidth={1.75} />Keyboard shortcuts</span>}>
      <div className="flex flex-col">
        {SHORTCUT_SHEET.map(s => (
          <div key={s.desc} className="flex items-center justify-between gap-4 py-1.5 border-b border-line last:border-0">
            <span className="text-sm text-fg-2">{s.desc}</span>
            <Shortcut keys={s.keys} />
          </div>
        ))}
      </div>
    </Modal>
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
            className="fixed bottom-16 right-5 w-80 h-104 z-modal flex flex-col
                       bg-surface rounded-2xl 
                       ring-1 ring-line-2 overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-2 px-3.5 py-2 border-b border-line shrink-0">
              <div className="w-5 h-5 rounded-md bg-accent flex items-center justify-center shrink-0">
                <span className="text-on-accent text-xs font-semibold leading-none">V</span>
              </div>
              <span className="flex-1 text-sm font-semibold">Ask Vector</span>
              <button onClick={() => { onOpenFull(); setOpen(false); }}
                className="text-2xs text-accent-text hover:text-accent-text font-medium mr-1">
                Full view →
              </button>
              <button aria-label="Clear chat" onClick={() => setMsgs([])} title="Clear chat"
                className="w-5 h-5 flex items-center justify-center text-fg-3 hover:text-fg">
                <RefreshCw className="w-3 h-3" />
              </button>
              <button aria-label="Close" onClick={() => setOpen(false)}
                className="w-5 h-5 flex items-center justify-center text-fg-3 hover:text-fg">
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Messages */}
            <div ref={bodyRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {msgs.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
                  <div className="w-9 h-9 rounded-xl bg-accent-soft flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-accent-text" />
                  </div>
                  <p className="text-xs font-medium text-fg-2">How can I help?</p>
                  <p className="text-2xs text-fg-3 leading-snug">Ask anything about quotes, specs, or projects.</p>
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[85%] px-2.5 py-1.5 rounded-xl text-xs leading-relaxed whitespace-pre-wrap break-words',
                    m.role === 'user'
                      ? 'bg-accent text-on-accent rounded-br-sm'
                      : 'bg-subtle text-fg rounded-bl-sm',
                  )}>{m.text}</div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-subtle px-2.5 py-2 rounded-xl rounded-bl-sm">
                    <Loader2 className="w-3 h-3 text-fg-3 animate-spin" />
                  </div>
                </div>
              )}
            </div>

            {/* Escalation banner */}
            {shouldEscalate && (
              <div className="px-3 py-1.5 bg-accent-soft border-t border-accent-line flex items-center gap-2 shrink-0">
                <Sparkles className="w-3 h-3 text-accent-text shrink-0" />
                <p className="text-2xs text-accent-text flex-1">Getting complex — try full view.</p>
                <button onClick={() => { onOpenFull(); setOpen(false); }}
                  className="text-2xs font-semibold text-accent-text hover:text-accent-text whitespace-nowrap">Open →</button>
              </div>
            )}

            {/* Input */}
            <div className="px-3 py-2 border-t border-line shrink-0 flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask anything… (Enter to send)"
                className="flex-1 resize-none text-xs bg-transparent outline-none text-fg placeholder:text-fg-3 leading-relaxed py-0.5"
              />
              <button aria-label="Send message" onClick={send} disabled={!input.trim() || loading}
                className={cn(
                  'w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors mb-0.5',
                  input.trim() && !loading
                    ? 'bg-accent text-on-accent hover:bg-accent-hover'
                    : 'bg-subtle text-fg-3 cursor-not-allowed',
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
              'fixed bottom-8 left-1/2 -translate-x-1/2 z-modal pointer-events-none',
              'w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-fast',
              overDismiss
                ? 'bg-err text-on-status '
                : 'bg-surface text-fg-3 ring-1 ring-line-2',
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
          'w-9 h-9 rounded-xl bg-accent text-on-accent z-modal',
          'flex items-center justify-center hover:bg-accent-hover transition-colors',
          isDragging ? 'cursor-grabbing opacity-80' : 'cursor-grab',
        )}>
        {open
          ? <X className="w-4 h-4" />
          : <span className="text-lg font-semibold leading-none tracking-tighter select-none">V</span>}
        {hasUnread && !open && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-err ring-2 ring-surface" />
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
    <div className="h-full min-h-112 w-full flex items-center justify-center border border-dashed border-line-2 rounded-panel">
      <div className="text-center max-w-96 px-8">
        <Badge tone="neutral" leftSection={<Lock className="w-3 h-3" />}>Coming soon</Badge>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-fg">{title}</h2>
        <p className="text-sm text-fg-2 mt-2 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

// ─── Feedback modal ──────────────────────────────────────────────────────────
const FEEDBACK_CATEGORIES = ['Bug', 'Idea', 'Question', 'Other'] as const;
type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

function FeedbackModal({
  opened, onClose, currentTab, userName, userEmail, toast,
}: {
  opened: boolean;
  onClose: () => void;
  currentTab: TabId;
  userName: string | null;
  userEmail: string | null;
  toast: ToastFn;
}) {
  const [category, setCategory] = useState<FeedbackCategory>('Idea');
  const [message,  setMessage]  = useState('');
  const [sending,  setSending]  = useState(false);

  async function submit() {
    const msg = message.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      const r = await api.feedback({ message: msg, category, page: currentTab, userName, userEmail });
      if (r.ok) { toast('ok', 'Feedback sent — thank you'); setMessage(''); onClose(); }
      else      { toast('err', failed('send your feedback', r.error)); }
    } catch (e: any) {
      toast('err', failed('send your feedback', e));
    }
    setSending(false);
  }
  useFormHotkeys({ onSubmit: submit, enabled: opened });

  return (
    <Modal opened={opened} onClose={onClose} size="var(--modal-sm)"
      title={<span className="flex items-center gap-2"><MessageSquarePlus className="w-4 h-4 text-fg-3" strokeWidth={1.75} />Send feedback</span>}>
      <div className="flex flex-col gap-3">
        <Segmented value={category} onChange={setCategory} data={[...FEEDBACK_CATEGORIES]} fullWidth />
        <Textarea
          data-autofocus
          minRows={5}
          value={message}
          onChange={e => setMessage(e.currentTarget.value)}
          placeholder="What's working, what's broken, what you'd love to see…"
        />
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-fg-3">Goes to the Vector team</span>
          <Button tone="primary" icon={Send} onClick={submit} loading={sending}
            disabled={!message.trim()} shortcut="submit">
            Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── First-run welcome modal ─────────────────────────────────────────────────
const WELCOME_KEY = 'vector_welcome_seen_v1';

function WelcomeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const steps = [
    { Icon: Zap,               title: 'Connect to JOE',  body: 'Hit “Connect to JOE” (top bar) while on the Eaton network or VPN to sync your quotes.' },
    { Icon: LayoutDashboard,   title: 'Process quotes',  body: 'Drop PDFs on the Dashboard to auto-extract, file, and upload to the D&Q Store.' },
    { Icon: ClipboardList,     title: 'Tools',           body: 'PMO, CBU sizer, Commission, and Doc packs live in the sidebar under Tools.' },
    { Icon: MessageSquarePlus, title: 'Send feedback',   body: 'Use the feedback button (top bar) anytime — it reaches the team directly.' },
  ];
  return (
    <Modal opened={opened} onClose={onClose} size="var(--modal-sm)" withCloseButton={false}>
      <div className="flex flex-col gap-5">
        <div>
          <div className="w-8 h-8 rounded-panel bg-accent text-on-accent flex items-center justify-center mb-3">
            <span className="text-lg font-semibold leading-none">V</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Welcome to Vector</h2>
          <p className="text-sm text-fg-3 mt-1">Eaton Quote &amp; PMO automation</p>
        </div>

        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-start gap-3 py-2.5 border-t border-line">
              <span className="mono text-xs text-fg-4 w-4 pt-0.5">{i + 1}</span>
              <s.Icon className="w-4 h-4 mt-0.5 text-fg-3 shrink-0" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{s.title}</p>
                <p className="text-xs text-fg-3 leading-snug mt-0.5">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <Button tone="primary" size="md" fullWidth onClick={onClose} data-autofocus>
          Get started
        </Button>
      </div>
    </Modal>
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
// Values are in --sp-4 units (16px steps), so the frame stays on the grid.
const PAGE_FRAME: Record<TabId, number> = {
  Dashboard: 80, Assistant: 0,  Inbox: 0,   Todo: 80,
  CRM:       80, ELInfo:    70, Fenton: 74, History: 80,
  Analytics: 80, Report:    70, LSD:    80, PMO:     70,
  CBU:       72, Commission: 64, Schematics: 80, Filing: 60,
  Docs:      60, Settings:   64,
};

const TAB_SHORTCUT: Partial<Record<TabId, ShortcutName>> = {
  Dashboard: 'goDashboard', Assistant: 'goAssistant', Inbox: 'goInbox',
  History: 'goHistory', Analytics: 'goAnalytics', Report: 'goReport',
};

const uiSample = typeof window !== 'undefined' &&
  (/(^|[?&])ui-sample(=|&|$)/.test(window.location.search) || window.location.hash === '#ui-sample');

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
      <VectorProvider dark={dark}>
        <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
          <OverlayPage toast={toast} />
        </LangCtx.Provider>
      </VectorProvider>
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
  // Ctrl+K is bound by the palette itself (it must work from inside a field).
  useAppHotkeys({
    help:        () => setShortcutsOpen(o => !o),
    theme:       () => setDark(d => !d),
    goDashboard: () => go('Dashboard'),
    goAssistant: () => go('Assistant'),
    goInbox:     () => go('Inbox'),
    goHistory:   () => go('History'),
    goAnalytics: () => go('Analytics'),
    goReport:    () => go('Report'),
  });

  // Palette groups come from the same NAV_STRUCTURE the sidebar renders, so a
  // new tab shows up in both or in neither — they cannot drift apart.
  const paletteGroups = React.useMemo<PaletteGroup[]>(() => [
    ...Object.values(NAV_STRUCTURE).map(group => ({
      group: tCurrent[group.labelKey] as string,
      actions: group.items.map(({ id, Icon, labelKey }) => ({
        id,
        label: tCurrent[labelKey] as string,
        description: tCurrent[TITLE_KEYS[id].s] as string,
        icon: Icon,
        shortcut: TAB_SHORTCUT[id],
        keywords: [id],
        onRun: () => go(id),
      })),
    })),
    {
      group: 'Workspace',
      actions: [
        { id: 'Settings', label: tCurrent.settings as string, description: tCurrent.sub_settings as string,
          icon: SettingsIcon, onRun: () => go('Settings') },
        { id: 'theme', label: dark ? 'Switch to light theme' : 'Switch to dark theme',
          icon: dark ? Sun : Moon, shortcut: 'theme', onRun: () => setDark(d => !d) },
        { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, shortcut: 'help',
          onRun: () => setShortcutsOpen(true) },
        { id: 'feedback', label: 'Send feedback', icon: MessageSquarePlus,
          onRun: () => setFeedbackOpen(true) },
      ],
    },
  ], [tCurrent, go, dark]);

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
    <VectorProvider dark={dark}>
    <LangCtx.Provider value={{ lang, t: tCurrent, setLang: saveLang }}>
      <CommandPalette groups={paletteGroups} />
      <CancelDock />

      {uiSample ? (
        <React.Suspense fallback={null}>
          <UiSamplePage dark={dark} setDark={setDark} />
        </React.Suspense>
      ) : !splashDone ? (
        <SplashScreen onConnect={onConnect} onSkip={() => setSplashDone(true)} connecting={connecting} />
      ) : (

      <>
      <div className="flex h-screen min-h-0 relative bg-page text-fg">
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
            tab={tab} dark={dark} setDark={setDark}
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
              const frame   = PAGE_FRAME[t] ?? 80;
              return (
                <ScreenScope key={t} active={active}>
                <div
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
                      <React.Suspense fallback={<div className="flex items-center justify-center h-full text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>}>
                        <InboxPage toast={toast} setTab={t2 => setTab(t2 as TabId)} onUnreadCount={setInboxUnread} />
                      </React.Suspense>
                    </TabErrorBoundary>
                  ) : (
                    // maxWidth carries the gutters too: border-box counts the
                    // padding inside it, so the column itself lands on `frame`.
                    <div className="w-full mx-auto"
                      style={frame
                        ? { padding: 'var(--pad-page)', maxWidth: `calc(var(--sp-4) * ${frame} + var(--pad-page) * 2)` }
                        : undefined}>
                      <TabErrorBoundary label={t}>
                      <React.Suspense fallback={<div className="flex items-center justify-center py-20 text-fg-3"><Loader2 className="w-5 h-5 animate-spin" /></div>}>
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
                </ScreenScope>
              );
            })}
          </main>
        </div>
      </div>

      <ShortcutsModal opened={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <FeedbackModal
        opened={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        currentTab={tab} userName={userName} userEmail={userEmail} toast={toast}
      />
      <WelcomeModal opened={welcomeOpen} onClose={dismissWelcome} />
      </>

      )}
    </LangCtx.Provider>
    </VectorProvider>
  );
}

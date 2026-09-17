// ─── Panel, Section, Stat ────────────────────────────────────────────────────
// Hierarchy comes from type, not boxes. Reach for Section first (a heading and
// a hairline); use Panel only when content genuinely needs a frame — a form
// that is submitted as one, a table with its own toolbar.
import React from 'react';
import type { LucideIcon } from 'lucide-react';

type Tone = 'ok' | 'warn' | 'err' | 'ai' | 'accent';
const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', ai: 'var(--violet)', accent: 'var(--accent-text)',
};

interface HeadProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Right-aligned controls in the heading row. */
  actions?: React.ReactNode;
  /** Eyebrow above the title (step number, category). */
  eyebrow?: React.ReactNode;
}

function Head({ title, description, icon: I, actions, eyebrow, size }: HeadProps & { size: 'panel' | 'section' }) {
  if (!title && !actions && !eyebrow) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-3)', minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow && <div className="eyebrow" style={{ marginBottom: 'var(--sp-1)' }}>{eyebrow}</div>}
        {title && (
          <h3 style={{
            margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
            fontSize: size === 'panel' ? 'var(--fs-md)' : 'var(--fs-lg)',
            fontWeight: 'var(--fw-semibold)', lineHeight: 'var(--lh-snug)',
            letterSpacing: 'var(--tracking-tight)', color: 'var(--t1)',
          }}>
            {I && <I strokeWidth={1.75} style={{ width: 'var(--icon-md)', height: 'var(--icon-md)', color: 'var(--t3)' }} />}
            {title}
          </h3>
        )}
        {description && (
          <p style={{ margin: 'var(--sp-0-5) 0 0', fontSize: 'var(--fs-sm)', color: 'var(--t3)', lineHeight: 'var(--lh-snug)' }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

export type PanelProps = HeadProps & {
  children?: React.ReactNode;
  /** Body padding. `none` for a flush table. */
  padding?: 'none' | 'sm' | 'md';
  footer?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** A thin coloured rule on the leading edge, for a panel that carries a state. */
  tone?: Tone;
  as?: 'section' | 'div' | 'form';
  onSubmit?: React.FormEventHandler;
};

const PAD = { none: '0', sm: 'var(--sp-3)', md: 'var(--sp-4)' };

export function Panel({
  title, description, icon, actions, eyebrow, children, padding = 'md', footer,
  className, style, tone, as: Tag = 'section', onSubmit,
}: PanelProps) {
  const hasHead = !!(title || actions || eyebrow);
  return (
    <Tag className={className} onSubmit={onSubmit as never} style={{
      background: 'var(--s1)',
      border: 'var(--hairline) solid var(--line)',
      borderRadius: 'var(--r-panel)',
      boxShadow: tone ? `inset var(--focus-w) 0 0 ${TONE_VAR[tone]}` : undefined,
      minWidth: 0,
      overflow: 'hidden',
      ...style,
    }}>
      {hasHead && (
        <div style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: padding === 'none' || children ? 'var(--hairline) solid var(--line)' : undefined }}>
          <Head title={title} description={description} icon={icon} actions={actions} eyebrow={eyebrow} size="panel" />
        </div>
      )}
      {children != null && <div style={{ padding: PAD[padding] }}>{children}</div>}
      {footer && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--sp-2)',
          padding: 'var(--sp-3) var(--sp-4)', borderTop: 'var(--hairline) solid var(--line)',
          background: 'var(--s0)',
        }}>{footer}</div>
      )}
    </Tag>
  );
}

/** A heading row over content, separated by a hairline. No box. */
export function Section({ title, description, icon, actions, eyebrow, children, className, style, divider = true }: HeadProps & {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  divider?: boolean;
}) {
  return (
    <section className={className} style={{ minWidth: 0, ...style }}>
      <div style={{
        paddingBottom: 'var(--sp-2)',
        marginBottom: 'var(--sp-3)',
        borderBottom: divider ? 'var(--hairline) solid var(--line)' : undefined,
      }}>
        <Head title={title} description={description} icon={icon} actions={actions} eyebrow={eyebrow} size="section" />
      </div>
      {children}
    </section>
  );
}

/** A labelled figure. Rows of these are separated by hairlines, not cards. */
export function Stat({ label, value, sub, tone, icon: I, size = 'md' }: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1-5)' }}>
        {I && <I strokeWidth={1.75} style={{ width: 'var(--icon-sm)', height: 'var(--icon-sm)', color: tone ? TONE_VAR[tone] : undefined }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
      <div className="mono" style={{
        marginTop: 'var(--sp-1-5)',
        fontSize: size === 'lg' ? 'var(--fs-4xl)' : size === 'md' ? 'var(--fs-3xl)' : 'var(--fs-xl)',
        fontWeight: 'var(--fw-medium)',
        lineHeight: 'var(--lh-tight)',
        letterSpacing: 'var(--tracking-tight)',
        color: 'var(--t1)',
      }}>{value}</div>
      {sub && <div style={{ marginTop: 'var(--sp-1)', fontSize: 'var(--fs-xs)', color: 'var(--t3)' }}>{sub}</div>}
    </div>
  );
}

/** Stats laid out in a row with hairline dividers between them. */
export function StatRow({ children, columns = 4 }: { children: React.ReactNode; columns?: number }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      borderBlock: 'var(--hairline) solid var(--line)',
    }}>
      {React.Children.toArray(children).map((child, i) => (
        <div key={i} style={{
          padding: 'var(--sp-4)',
          paddingInlineStart: i === 0 ? 0 : 'var(--sp-4)',
          borderInlineStart: i === 0 ? undefined : 'var(--hairline) solid var(--line)',
        }}>{child}</div>
      ))}
    </div>
  );
}

/** Page heading used inside a screen (the shell header carries the title). */
export function Toolbar({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap', minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

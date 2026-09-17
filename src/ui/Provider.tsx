// ─── The Mantine provider ────────────────────────────────────────────────────
// One source of truth for the scheme: App's `dark` state. It drives Mantine's
// `forceColorScheme` AND the `.dark` class our tokens hang off, in the same
// effect, so the two can never disagree.
import React, { useLayoutEffect } from 'react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { MotionConfig } from 'motion/react';

import { vectorTheme, vectorCssVariables, TOKEN_MAP } from './theme';

const MOTION = { duration: 0.16, ease: [0.2, 0, 0, 1] as const };

export function VectorProvider({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  const scheme = dark ? 'dark' : 'light';
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
  }, [dark]);

  return (
    <MantineProvider
      theme={vectorTheme}
      cssVariablesResolver={vectorCssVariables}
      forceColorScheme={scheme}
    >
      <ModalsProvider
        labels={{ confirm: 'Confirm', cancel: 'Cancel' }}
        modalProps={{ size: 'var(--modal-sm)' }}
      >
        <Notifications
          position="bottom-right"
          autoClose={5000}
          limit={4}
          containerWidth="var(--toast-w)"
          zIndex="var(--z-toast)"
        />
        {/* Motion marks state changes only: short, ease-out, never a spring. */}
        <MotionConfig transition={MOTION} reducedMotion="user">
          {children}
        </MotionConfig>
      </ModalsProvider>
    </MantineProvider>
  );
}

/** Renders its children in the other theme, whatever the page is in. Used by
 *  the UI sample to show light and dark side by side. Portalled layers (menus,
 *  modals) follow the page theme, not the scope. */
export function SchemeScope({ scheme, children, className }: {
  scheme: 'light' | 'dark'; children: React.ReactNode; className?: string;
}) {
  return (
    <div
      className={[scheme, className].filter(Boolean).join(' ')}
      data-mantine-color-scheme={scheme}
      // Re-declaring the mapping here makes the var() references resolve
      // against this subtree's tokens rather than the page's.
      style={{ ...(TOKEN_MAP as React.CSSProperties), background: 'var(--bg)', color: 'var(--t1)' }}
    >
      {children}
    </div>
  );
}

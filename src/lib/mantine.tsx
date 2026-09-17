// ─── The Mantine provider ────────────────────────────────────────────────────
// Mantine supplies BEHAVIOUR (stacking toasts, a command palette, confirm
// dialogs, hotkeys). It deliberately does not supply the LOOK: the theme in
// mantineTheme.ts reads every colour, radius, shadow, font size and spacing
// step back out of the v2 tokens in index.css, so a Mantine control and a
// hand-written one are the same object.
//
// This module exports ONLY a component, which is what keeps it Fast
// Refreshable — the toast and confirm helpers live in ./notify.
import React from 'react';
import { MantineProvider, type MantineColorScheme } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';

import { vectorTheme, vectorCssVariables } from './mantineTheme';

/** `forceColorScheme` is driven by App's existing `dark` state so there is one
 *  source of truth for the theme — Mantine never reads localStorage itself. */
export function VectorMantine({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  const scheme: MantineColorScheme = dark ? 'dark' : 'light';
  return (
    <MantineProvider
      theme={vectorTheme}
      cssVariablesResolver={vectorCssVariables}
      forceColorScheme={scheme}
    >
      <ModalsProvider labels={{ confirm: 'Confirm', cancel: 'Cancel' }}>
        {/* Above the app's own z-[10000] modals so a toast is never buried. */}
        <Notifications
          position="bottom-right"
          autoClose={5000}
          limit={4}
          containerWidth={360}
          zIndex={10050}
        />
        {children}
      </ModalsProvider>
    </MantineProvider>
  );
}

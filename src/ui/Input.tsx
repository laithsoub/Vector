// ─── Text inputs ─────────────────────────────────────────────────────────────
// `mono` switches a field to Plex Mono with tabular figures: use it for every
// code, id, part number or quotation number.
import React, { forwardRef } from 'react';
import {
  PasswordInput as MPasswordInput, Textarea as MTextarea, TextInput as MTextInput,
  type PasswordInputProps, type TextareaProps as MTextareaProps, type TextInputProps,
} from '@mantine/core';
import type { LucideIcon } from 'lucide-react';

type Mono = { mono?: boolean };
type WithIcon = { icon?: LucideIcon };

const monoStyle = { input: { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums slashed-zero' } };

export type InputProps = TextInputProps & Mono & WithIcon;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, icon: I, styles, leftSection, ...rest }, ref,
) {
  return (
    <MTextInput ref={ref} {...rest}
      leftSection={I ? <I strokeWidth={1.75} /> : leftSection}
      styles={mono ? { ...monoStyle, ...(styles as object) } : styles} />
  );
});

export type TextareaProps = MTextareaProps & Mono;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, styles, ...rest }, ref,
) {
  return <MTextarea ref={ref} styles={mono ? { ...monoStyle, ...(styles as object) } : styles} {...rest} />;
});

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(props, ref) {
  return <MPasswordInput ref={ref} {...props} />;
});

export type { TextInputProps, PasswordInputProps };

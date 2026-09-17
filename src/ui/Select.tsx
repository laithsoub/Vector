// ─── Select, MultiSelect, Autocomplete, Combobox ─────────────────────────────
// Thin pass-throughs: the theme already sets size, dropdown look and motion.
// `mono` is for pickers whose options are codes (catalogue numbers, ids).
import { forwardRef } from 'react';
import {
  Autocomplete as MAutocomplete, MultiSelect as MMultiSelect, Select as MSelect,
  type AutocompleteProps as MAutocompleteProps, type MultiSelectProps, type SelectProps as MSelectProps,
} from '@mantine/core';
import { ChevronsUpDown, Search } from 'lucide-react';

const monoStyles = {
  input:  { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' },
  option: { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' },
};

export type SelectProps = MSelectProps & { mono?: boolean };

export const Select = forwardRef<HTMLInputElement, SelectProps>(function Select(
  { mono, styles, rightSection, ...rest }, ref,
) {
  return (
    <MSelect ref={ref} {...rest}
      rightSection={rightSection ?? <ChevronsUpDown strokeWidth={1.75} />}
      styles={mono ? { ...monoStyles, ...(styles as object) } : styles} />
  );
});

export const MultiSelect = forwardRef<HTMLInputElement, MultiSelectProps>(function MultiSelect(props, ref) {
  return <MMultiSelect ref={ref} {...props} />;
});

export type AutocompleteProps = MAutocompleteProps & { mono?: boolean; searchIcon?: boolean };

export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(function Autocomplete(
  { mono, searchIcon, styles, leftSection, ...rest }, ref,
) {
  return (
    <MAutocomplete ref={ref} {...rest}
      leftSection={searchIcon ? <Search strokeWidth={1.75} /> : leftSection}
      styles={mono ? { ...monoStyles, ...(styles as object) } : styles} />
  );
});

// Full Combobox for custom pickers (search + rich rows). Re-exported so app
// code still imports from src/ui only.
export { Combobox, useCombobox, InputBase, Input as MantineInput } from '@mantine/core';
export type { ComboboxItem, ComboboxData, MultiSelectProps } from '@mantine/core';


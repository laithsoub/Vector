// ─── src/ui — the only door to Mantine ───────────────────────────────────────
// App code imports components from here, never from @mantine/* directly, so
// the look can change in one place.
export { VectorProvider, SchemeScope } from './Provider';
export { tokenValue } from './tokens';
export { vectorTheme } from './theme';

export { Button, IconButton, IconLink, type ButtonProps, type ButtonTone, type IconButtonProps } from './Button';
export { Input, Textarea, PasswordInput, type InputProps, type TextareaProps } from './Input';
export {
  NumberInput, PriceInput, QtyInput, PercentInput,
  formatMoney, formatQty, formatPct,
  type Currency, type NumberInputProps, type PriceInputProps,
} from './NumberInput';
export {
  Select, MultiSelect, Autocomplete, Combobox, useCombobox, InputBase,
  type SelectProps, type AutocompleteProps, type ComboboxItem, type ComboboxData,
} from './Select';
export { Checkbox, Switch, Radio, type CheckboxProps, type SwitchProps } from './Choice';
export { Tabs, TabBar, Segmented, type TabItem } from './Tabs';
export { Menu, ActionMenu, type ActionMenuItem } from './Menu';
export { Tooltip, type TooltipProps } from './Tooltip';
export { Table, DataTable, Num, type Column, type DataTableProps } from './Table';
export { Panel, Section, Stat, StatRow, Toolbar, type PanelProps } from './Panel';
export { EmptyState } from './EmptyState';
export { Badge, statusTone, type StatusTone, type BadgeProps } from './Badge';
export { FileDrop, type FileDropProps, type FileKind } from './FileDrop';
export {
  AiMark, AiThinking, AiMessage, UserMessage, AiSuggestions, AiThread, AiComposer,
  AiPromptGrid, AiWelcome, AiPanelHeader, AiSidePanel, AiFileChip, CopyAction, useThinkingSteps, aiProse,
  type AiSideMessage,
  type AiPrompt, type AiComposerProps,
} from './ai/AiKit';
export { CommandPalette, openPalette, type PaletteAction, type PaletteGroup } from './CommandPalette';

export { notify, notifyProgress, type ToastType } from './notify';
export { confirm, confirmAsync, type ConfirmOptions } from './confirm';
export {
  SHORTCUTS, Shortcut, shortcutKeys, ScreenScope, useScreenActive,
  useFormHotkeys, useAppHotkeys, type ShortcutName,
} from './shortcuts';

// Layout and feedback primitives used as-is.
export {
  Box, Stack, Group, SimpleGrid, Flex, Grid, Center, Space,
  Text, Title, Anchor, Divider, Kbd, Loader, Progress, RingProgress, Skeleton,
  ScrollArea, Collapse, Transition, Popover, HoverCard, Modal, Drawer,
  CloseButton, CopyButton, Avatar, Indicator, UnstyledButton, NavLink, Alert,
  Pagination, Accordion, Stepper, Timeline, Chip, Portal, FocusTrap, VisuallyHidden,
} from '@mantine/core';
export { useDisclosure, useDebouncedValue, useClipboard, useLocalStorage, useHotkeys, useClickOutside } from '@mantine/hooks';
export { modals } from '@mantine/modals';

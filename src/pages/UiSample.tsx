// ─── UI sample (v3 checkpoint) ───────────────────────────────────────────────
// Every src/ui component in one place, in both themes. Opened with
// ?ui-sample or #ui-sample; not in the nav. Figures below are sample data.
import { useMemo, useState } from 'react';
import {
  ArrowLeft, Bell, Calculator, Copy, FileSpreadsheet, Mail, Pencil, Save, Search,
  Send, Sparkles, Tags, Trash2, Upload, Users,
} from 'lucide-react';

import {
  Autocomplete, Badge, Button, Checkbox, Combobox, DataTable, EmptyState, FileDrop,
  Group, IconButton, Input, InputBase, Menu, ActionMenu, Modal, Num, Panel,
  PercentInput, PriceInput, QtyInput, Radio, SchemeScope, Section, Segmented, Select,
  Shortcut, SimpleGrid, Stack, Stat, StatRow, Switch, TabBar, Tabs, Text, Textarea,
  Toolbar, Tooltip, confirm, formatMoney, formatQty, notify, openPalette,
  statusTone, useCombobox, useDisclosure, useFormHotkeys, type Column,
} from '../ui';
import { SignalCompare } from './SignalCompare';

// ── sample data ──────────────────────────────────────────────────────────────
interface Line {
  pos: number;
  code: string;
  description: string;
  qty: number;
  list: number;
  discount: number;
  status: string;
}

const LINES: Line[] = [
  { pos: 10, code: 'CBU-24V-10A',   description: 'Central battery unit, 24 V, 10 A, 3 h',  qty: 1,  list: 18420.00, discount: 38, status: 'Approved' },
  { pos: 20, code: 'NXL-EX-25M',    description: 'Exit sign, maintained, 25 m viewing',     qty: 42, list: 164.50,   discount: 35, status: 'Approved' },
  { pos: 30, code: 'NXL-OA-400',    description: 'Open-area luminaire, 400 lm, DALI',       qty: 118, list: 212.80,  discount: 35, status: 'Needs review' },
  { pos: 40, code: 'SUB-MON-8',     description: 'Sub-circuit monitor, 8 channels',         qty: 6,  list: 1290.00,  discount: 30, status: 'Pending' },
  { pos: 50, code: 'COM-SITE-1D',   description: 'Commissioning, per engineer day',         qty: 3,  list: 980.00,   discount: 0,  status: 'Draft' },
  { pos: 60, code: 'BAT-12V-24AH',  description: 'Replacement battery block, 12 V 24 Ah',   qty: 2,  list: 356.25,   discount: 37, status: 'Missing price' },
];

const net = (l: Line) => l.list * (1 - l.discount / 100);

const CUSTOMERS = [
  'Khimji Ramdas', 'Energixcel Trading', 'Al Saigh Electrical', 'Gulf Lighting Supply',
  'Bristol Royal Infirmary', 'Cadogan Square Estates', 'Hippodrome Theatre',
];

// ── gallery ─────────────────────────────────────────────────────────────────
function Gallery() {
  const [tab, setTab] = useState<'lines' | 'history' | 'files'>('lines');
  const [selected, setSelected] = useState<number | null>(20);
  const [seg, setSeg] = useState<'all' | 'open' | 'done'>('all');
  const [price, setPrice] = useState<number | string>(18420);
  const [qty, setQty] = useState<number | string>(42);
  const [pct, setPct] = useState<number | string>(35);
  const [currency, setCurrency] = useState<'EUR' | 'GBP'>('EUR');
  const [notifyEmail, setNotifyEmail] = useState(true);

  const total = useMemo(() => LINES.reduce((s, l) => s + net(l) * l.qty, 0), []);
  const listTotal = useMemo(() => LINES.reduce((s, l) => s + l.list * l.qty, 0), []);

  const columns: Column<Line>[] = [
    { key: 'pos',   header: 'Pos',  kind: 'num', width: '6ch' },
    { key: 'code',  header: 'Material', kind: 'code', width: '16ch' },
    { key: 'description', header: 'Description',
      render: l => <span className="text-fg-2">{l.description}</span> },
    { key: 'qty',   header: 'Qty',  kind: 'num', render: l => formatQty(l.qty) },
    { key: 'list',  header: 'List', kind: 'num', render: l => formatMoney(l.list, currency) },
    { key: 'discount', header: 'Disc.', kind: 'num',
      render: l => l.discount ? `${l.discount}%` : <span className="text-fg-4">—</span> },
    { key: 'net',   header: 'Net total', kind: 'num',
      render: l => <strong className="font-medium">{formatMoney(net(l) * l.qty, currency)}</strong>,
      footer: formatMoney(total, currency) },
    { key: 'status', header: 'Status', width: '18ch',
      render: l => <Badge tone={statusTone(l.status)} dot>{l.status}</Badge>,
      footer: <span className="text-fg-3 font-normal">{LINES.length} lines</span> },
    { key: 'menu', header: '', width: 'var(--h-md)', align: 'end',
      render: () => (
        <ActionMenu items={[
          { heading: 'Line' },
          { label: 'Edit price', icon: Pencil, shortcut: 'mod+E', onClick: () => notify.info('Edit price') },
          { label: 'Duplicate', icon: Copy, onClick: () => notify.info('Duplicated') },
          { divider: true },
          { label: 'Remove line', icon: Trash2, danger: true,
            onClick: async () => { if (await confirm.remove({ what: 'this line' })) notify.success('Line removed'); } },
        ]} />
      ) },
  ];

  return (
    <Stack gap="var(--sp-10)">
      {/* ── type ── */}
      <Section title="Type" description="IBM Plex Sans for words, IBM Plex Mono for every figure and code.">
        <Stack gap="var(--sp-2)">
          <div className="text-2xl font-semibold">Quote W262224492E · Energixcel</div>
          <div className="text-xl font-semibold">Panel title, 16</div>
          <div className="text-lg font-semibold">Section title, 14</div>
          <div className="text-md text-fg-2 max-w-measure">
            Body copy sits at 13 on a 1.5 leading. Hierarchy comes from weight and size, and a
            hairline does the rest — no card around every paragraph.
          </div>
          <div className="text-xs text-fg-3">Caption, 11.5 — hints and metadata</div>
          <div className="eyebrow">Eyebrow · step 2 of 3</div>
          <div className="mono text-3xl">€ 1,284,906.40</div>
          <div className="mono text-sm text-fg-2">006QO00000zc0jpYAA · EU1L0817X6K2-0000 · 0123456789</div>
        </Stack>
      </Section>

      {/* ── colour ── */}
      <Section title="Colour" description="Warm neutrals, one ink-blue accent, muted status.">
        <SimpleGrid cols={{ base: 3, sm: 6 }} spacing="var(--sp-3)">
          {[
            ['page', 'bg-page'], ['surface', 'bg-surface'], ['subtle', 'bg-subtle'],
            ['hover', 'bg-hover'], ['line', 'bg-line'], ['line-3', 'bg-line-3'],
            ['accent', 'bg-accent'], ['accent-soft', 'bg-accent-soft'], ['ok', 'bg-ok'],
            ['warn', 'bg-warn'], ['err', 'bg-err'], ['ai', 'bg-ai'],
          ].map(([name, cls]) => (
            <div key={name}>
              <div className={`${cls} h-h-lg rounded border`} />
              <div className="mono text-2xs text-fg-3 mt-1">{name}</div>
            </div>
          ))}
        </SimpleGrid>
      </Section>

      {/* ── buttons ── */}
      <Section title="Buttons" description="Only primary wears the accent. Hover a button to see its shortcut.">
        <Stack gap="var(--sp-3)">
          <Toolbar>
            <Button tone="primary" icon={Save} shortcut="save">Save quote</Button>
            <Button tone="secondary" icon={FileSpreadsheet}>Working file</Button>
            <Button tone="ghost">Cancel</Button>
            <Button tone="ai" icon={Sparkles}>Ask Vector</Button>
            <Button tone="danger" icon={Trash2}>Delete</Button>
            <Button tone="quiet-danger">Discard draft</Button>
          </Toolbar>
          <Toolbar>
            <Button tone="primary" size="xs">Extra small</Button>
            <Button tone="primary" size="sm">Small</Button>
            <Button tone="primary" size="md">Medium</Button>
            <Button tone="primary" loading>Pricing</Button>
            <Button tone="primary" disabled>Disabled</Button>
            <Button tone="secondary" icon={Send} shortcut="submit">Send</Button>
          </Toolbar>
          <Toolbar>
            <IconButton icon={Search} label="Search" shortcut="palette" />
            <IconButton icon={Bell} label="Notifications" />
            <IconButton icon={Pencil} label="Edit" tone="secondary" />
            <IconButton icon={Users} label="Filter: mine" active />
            <IconButton icon={Trash2} label="Delete" tone="danger" />
          </Toolbar>
        </Stack>
      </Section>

      {/* ── inputs ── */}
      <Section title="Inputs" description="Numbers are mono and right-aligned; prices format while you type.">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="var(--sp-4)" verticalSpacing="var(--sp-4)">
          <Input label="Project name" placeholder="e.g. Soho Cinema, London" />
          <Input label="Transaction #" mono defaultValue="W262223256E" description="From Oracle CPQ" />
          <Input label="Customer email" icon={Mail} placeholder="name@company.com" error="Not a valid address" />
          <PriceInput label="List price" currency={currency} value={price} onChange={setPrice} />
          <QtyInput label="Quantity" value={qty} onChange={setQty} />
          <PercentInput label="Requested discount" value={pct} onChange={setPct} max={100} />
          <Select label="Currency" data={['EUR', 'GBP']} value={currency}
            onChange={v => v && setCurrency(v as 'EUR' | 'GBP')} />
          <Select label="Price book" mono searchable
            data={['PV 2025', 'MV Ledger 2025', 'Trigger 2026-09', 'Guidance H2']} defaultValue="PV 2025" />
          <Autocomplete label="Customer" searchIcon placeholder="Start typing…" data={CUSTOMERS} />
          <CustomerCombobox />
          <Textarea label="Note to Dalia" placeholder="What changed and why" className="sm:col-span-2" />
        </SimpleGrid>
      </Section>

      {/* ── choices ── */}
      <Section title="Choices">
        <Group gap="var(--sp-8)" align="flex-start">
          <Stack gap="var(--sp-2)">
            <Checkbox label="Keep the as-pasted draft" defaultChecked />
            <Checkbox label="Attach T&C" description="Adds the standard terms PDF" />
            <Checkbox label="Unavailable" disabled />
          </Stack>
          <Stack gap="var(--sp-2)">
            <Switch label="Email me when priced" checked={notifyEmail} onChange={e => setNotifyEmail(e.currentTarget.checked)} />
            <Switch label="Compact tables" />
          </Stack>
          <Radio.Group defaultValue="floor" label="Pricing rule">
            <Stack gap="var(--sp-2)" mt="var(--sp-1)">
              <Radio value="requested" label="Requested discount" />
              <Radio value="floor" label="Target E2E as a floor" />
            </Stack>
          </Radio.Group>
          <Stack gap="var(--sp-2)">
            <Text size="xs" c="var(--t2)" fw={500}>Segmented</Text>
            <Segmented value={seg} onChange={setSeg}
              data={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }]} />
          </Stack>
        </Group>
      </Section>

      {/* ── badges ── */}
      <Section title="Status">
        <Stack gap="var(--sp-3)">
          <Group gap="var(--sp-2)">
            <Badge>Draft</Badge>
            <Badge tone="accent">Yours</Badge>
            <Badge tone="ok">Processed</Badge>
            <Badge tone="warn">On hold</Badge>
            <Badge tone="err">Rejected</Badge>
            <Badge tone="ai">Suggested by Vector</Badge>
            <Badge mono>RPI 6.8%</Badge>
          </Group>
          <Group gap="var(--sp-4)">
            <Badge tone="ok" dot>Sent</Badge>
            <Badge tone="warn" dot>Waiting on Dalia</Badge>
            <Badge tone="err" dot>No SF id</Badge>
          </Group>
        </Stack>
      </Section>

      {/* ── stats ── */}
      <Section title="Figures" description="Rows of stats divided by hairlines, not a card each.">
        <StatRow>
          <Stat label="Quotes this month" value="148" sub="+12 vs August" icon={Tags} />
          <Stat label="Pipeline" value={formatMoney(1284906, 'EUR', 0)} sub="31 open deals" icon={Calculator} />
          <Stat label="Avg. RPI" value="6.8%" sub="target 6.0%" tone="warn" icon={Calculator} />
          <Stat label="E2E margin" value="39.2%" sub="floor 37%" tone="ok" icon={Calculator} />
        </StatRow>
      </Section>

      {/* ── table ── */}
      <Section title="Quote lines" description="Sticky header, mono figures, click a row to select it."
        actions={<>
          <Button icon={Upload}>Import BOM</Button>
          <Button tone="primary" icon={Save} shortcut="save">Save</Button>
        </>}>
        <TabBar
          value={tab} onChange={setTab}
          items={[
            { value: 'lines', label: 'Lines', count: LINES.length },
            { value: 'history', label: 'Price history', count: 14 },
            { value: 'files', label: 'Files', count: 0 },
          ]}>
          <Tabs.Panel value="lines">
            <DataTable
              columns={columns}
              rows={LINES}
              rowKey={l => l.pos}
              selectedKey={selected}
              onRowClick={l => setSelected(l.pos)}
              maxHeight="calc(var(--sp-16) * 4)"
              caption={<>List {formatMoney(listTotal, currency)} · net <Num strong>{formatMoney(total, currency)}</Num></>}
            />
          </Tabs.Panel>
          <Tabs.Panel value="history">
            <EmptyState compact icon={Calculator} title="No history for this customer"
              description="The RPI falls back to the Gulf average. Check the mix before trusting a big number." />
          </Tabs.Panel>
          <Tabs.Panel value="files">
            <FileDrop accept={['excel', 'pdf']} hint="CPQ export (.xlsx, .xlsb) or the customer PDF"
              onDrop={files => notify.success(`${files.length} file(s) added`)} />
          </Tabs.Panel>
        </TabBar>
      </Section>

      {/* ── panels ── */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="var(--sp-4)">
        <Panel title="Deal header" description="Framed because it is submitted as one" icon={Tags}
          actions={<Tooltip label="Copy transaction #"><IconButton icon={Copy} label="Copy" /></Tooltip>}
          footer={<><Button tone="ghost">Reset</Button><Button tone="primary" shortcut="submit">Price it</Button></>}>
          <Stack gap="var(--sp-3)">
            <Input label="Sold-to" mono defaultValue="1254741" />
            <Select label="Pricing customer" data={CUSTOMERS} defaultValue={CUSTOMERS[1]} />
          </Stack>
        </Panel>
        <Panel title="Waiting in Dalia's sheet" padding="none" tone="warn">
          <EmptyState compact title="Nothing waiting" description="Read 2 minutes ago."
            action={<Button size="xs">Refresh</Button>} />
        </Panel>
      </SimpleGrid>

      {/* ── feedback ── */}
      <Section title="Notifications and dialogs">
        <FeedbackDemos />
      </Section>

      {/* ── menu ── */}
      <Section title="Menu">
        <Menu>
          <Menu.Target><Button trailing={<Shortcut keys="alt+M" />}>Export</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Export as</Menu.Label>
            <Menu.Item leftSection={<FileSpreadsheet />} rightSection={<Shortcut keys="mod+shift+E" />}>Working file (.xlsb)</Menu.Item>
            <Menu.Item leftSection={<FileSpreadsheet />}>Approved offer (.pdf)</Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<Upload />}>Upload to SharePoint</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Section>
    </Stack>
  );
}

function CustomerCombobox() {
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  const [value, setValue] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const shown = CUSTOMERS.filter(c => c.toLowerCase().includes(search.toLowerCase().trim()));
  return (
    <Combobox store={combobox} onOptionSubmit={v => { setValue(v); setSearch(v); combobox.closeDropdown(); }}>
      <Combobox.Target>
        <InputBase
          label="Account (Combobox)"
          rightSection={<Combobox.Chevron />}
          value={search}
          onChange={e => { setSearch(e.currentTarget.value); combobox.openDropdown(); combobox.updateSelectedOptionIndex(); }}
          onClick={() => combobox.openDropdown()}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => { combobox.closeDropdown(); setSearch(value ?? ''); }}
          placeholder="Search accounts"
          rightSectionPointerEvents="none"
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options>
          {shown.length === 0 && <Combobox.Empty>No account matches</Combobox.Empty>}
          {shown.map((c, i) => (
            <Combobox.Option value={c} key={c}>
              <Group justify="space-between" wrap="nowrap">
                <span>{c}</span>
                <span className="mono text-fg-3 text-xs">{String(1254741 + i * 317)}</span>
              </Group>
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

function FeedbackDemos() {
  const [opened, { open, close }] = useDisclosure(false);
  const [note, setNote] = useState('');
  const submit = () => { close(); notify.success('Hand-off draft saved'); };
  useFormHotkeys({ onSubmit: opened && submit, onClose: opened && close, enabled: opened });

  const fakeUpload = () => new Promise<number>(res => setTimeout(() => res(3), 1400));
  const fakeSend = () => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Outlook is not running')), 1400));

  return (
    <Stack gap="var(--sp-3)">
      <Toolbar>
        <Button onClick={() => notify.success('Quote saved to History')}>Success</Button>
        <Button onClick={() => notify.error('Could not reach JOE. Check the VPN.', { title: 'Connection failed' })}>Error</Button>
        <Button onClick={() => notify.info('3 new threads in UKQuoteFactoryEL')}>Info</Button>
        <Button onClick={() => notify.warn('Price book is older than 30 days')}>Warning</Button>
      </Toolbar>
      <Toolbar>
        <Button icon={Upload} onClick={() => notify.promise(fakeUpload(), {
          loading: 'Uploading 3 files to SharePoint…',
          success: n => `Uploaded ${n} files`,
          error: 'Upload failed',
        })}>Promise: upload (succeeds)</Button>
        <Button icon={Send} onClick={() => notify.promise(fakeSend(), {
          title: 'Email',
          loading: 'Sending to Dalia…',
          success: 'Sent',
          error: e => `Not sent: ${(e as Error).message}`,
        }).catch(() => undefined)}>Promise: send (fails)</Button>
      </Toolbar>
      <Toolbar>
        <Button onClick={async () => {
          if (await confirm.send({ to: 'dalia.example@eaton.com', subject: 'RE: W262224492E — revised offer' }))
            notify.success('Sent');
        }}>Confirm send</Button>
        <Button tone="quiet-danger" onClick={async () => {
          if (await confirm.remove({ what: 'account "Khimji Ramdas"', message: 'Its contacts and facts go too.\nQuotes in history are not affected.' }))
            notify.success('Deleted');
        }}>Confirm delete</Button>
        <Button onClick={async () => {
          if (await confirm.overwrite({ what: 'unit price', message: 'Line 30 changes from €138.32 to €131.40.' }))
            notify.success('Price replaced');
        }}>Confirm price overwrite</Button>
        <Button tone="primary" onClick={open}>Open a form modal</Button>
      </Toolbar>
      <Text size="xs" c="var(--t3)">
        Try <Shortcut keys="save" /> anywhere on this page, and <Shortcut keys="submit" /> / <Shortcut keys="close" /> inside the form modal.
      </Text>

      <Modal opened={opened} onClose={close} title="Hand off to the team">
        <Stack gap="var(--sp-3)">
          <Select label="Owner" data={['Dalia', 'Andrea', 'Mark']} defaultValue="Dalia" />
          <Textarea label="Note" value={note} onChange={e => setNote(e.currentTarget.value)} data-autofocus />
          <Group justify="space-between" mt="var(--sp-2)">
            <Text size="xs" c="var(--t3)"><Shortcut keys="submit" /> to save</Text>
            <Group gap="var(--sp-2)">
              <Button tone="ghost" onClick={close}>Cancel</Button>
              <Button tone="primary" onClick={submit} shortcut="submit">Save draft</Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

// ── page ────────────────────────────────────────────────────────────────────
export function UiSamplePage({ dark, setDark }: { dark: boolean; setDark: (fn: (d: boolean) => boolean) => void }) {
  const [layout, setLayout] = useState<'both' | 'single'>('both');
  useFormHotkeys({ onSave: () => notify.success('Ctrl+S caught — this screen would save now') });

  return (
    <div className="min-h-screen bg-page text-fg">
      <header className="sticky top-0 z-sidebar h-header flex items-center gap-3 px-page bg-page hairline-b">
        <a href="./" className="flex items-center gap-2 text-sm text-fg-2 hover:text-fg">
          <ArrowLeft className="w-4 h-4" strokeWidth={1.75} /> Vector
        </a>
        <span className="text-line-3">/</span>
        <h1 className="text-2xl font-semibold m-0">UI sample</h1>
        <Badge tone="accent" mono>v3</Badge>
        <div className="flex-1" />
        <Segmented value={layout} onChange={setLayout}
          data={[{ value: 'both', label: 'Light + dark' }, { value: 'single', label: 'Page theme' }]} />
        <Switch label="Dark" checked={dark} onChange={() => setDark(d => !d)} />
        <Button icon={Search} onClick={openPalette} shortcut="palette">Palette</Button>
      </header>

      <SignalCompare />

      {layout === 'single' ? (
        <main className="p-page mx-auto" style={{ maxWidth: 'calc(var(--sp-16) * 19)' }}>
          <Gallery />
        </main>
      ) : (
        <main className="grid grid-cols-1 2xl:grid-cols-2">
          <SchemeScope scheme="light" className="p-page min-w-0">
            <div className="eyebrow mb-4">Light · paper</div>
            <Gallery />
          </SchemeScope>
          <SchemeScope scheme="dark" className="p-page min-w-0 border-l">
            <div className="eyebrow mb-4">Dark · warm charcoal</div>
            <Gallery />
          </SchemeScope>
        </main>
      )}
      <footer className="px-page py-6 hairline-t text-xs text-fg-3">
        Menus, dialogs and notifications render in a portal and follow the page theme — flip the switch to see them in dark.
      </footer>
    </div>
  );
}


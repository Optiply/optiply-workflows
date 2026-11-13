import {
  AlignLeft,
  AppWindow,
  Braces,
  CalendarDays,
  CalendarRange,
  ChartColumn,
  ChartNoAxesGantt,
  ChevronsUpDown,
  CircleDot,
  ClipboardList,
  FileUp,
  Hash,
  Image,
  ListChecks,
  type LucideIcon,
  Menu,
  RectangleHorizontal,
  Rows3,
  SeparatorHorizontal,
  SquareCheck,
  SquareDashed,
  SquareSplitHorizontal,
  Table2,
  TextCursorInput,
  ToggleRight,
  TrendingUp,
  TriangleAlert,
  Type,
} from 'lucide-react'

/** A palette entry: its icon and the words it's also found by (its label always finds it). */
interface PaletteEntry {
  icon: LucideIcon
  keywords: string
}

/** The palette's component types (session 41, after Retool's palette): an icon and search words each. */
export const PALETTE_ENTRIES: Readonly<Record<string, PaletteEntry>> = {
  textInput: { icon: TextCursorInput, keywords: 'input field string' },
  numberInput: { icon: Hash, keywords: 'input field integer decimal amount' },
  dateInput: { icon: CalendarDays, keywords: 'input field day calendar time' },
  select: { icon: ChevronsUpDown, keywords: 'input dropdown options choose picker' },
  checkbox: { icon: SquareCheck, keywords: 'input boolean toggle tick' },
  table: { icon: Table2, keywords: 'data grid rows list' },
  chart: { icon: ChartColumn, keywords: 'data graph plot bar line pie' },
  button: { icon: RectangleHorizontal, keywords: 'action click submit' },
  text: { icon: Type, keywords: 'label markdown heading paragraph' },
  container: { icon: SquareDashed, keywords: 'group box card tabs views layout' },
  form: { icon: ClipboardList, keywords: 'inputs submit group' },
  modal: { icon: AppWindow, keywords: 'dialog popup overlay' },
  navigation: { icon: Menu, keywords: 'menu links pages nav' },
  // Session 41.
  textArea: { icon: AlignLeft, keywords: 'input field multiline long text notes' },
  switch: { icon: ToggleRight, keywords: 'input boolean toggle on off' },
  checkboxGroup: { icon: ListChecks, keywords: 'input options several multiselect choose' },
  radioGroup: { icon: CircleDot, keywords: 'input options one choose' },
  segmentedControl: { icon: SquareSplitHorizontal, keywords: 'input options tabs buttons toggle' },
  dateRange: { icon: CalendarRange, keywords: 'input dates period from to calendar' },
  fileInput: { icon: FileUp, keywords: 'input upload attachment csv' },
  statistic: { icon: TrendingUp, keywords: 'number kpi metric total figure' },
  image: { icon: Image, keywords: 'picture photo logo' },
  divider: { icon: SeparatorHorizontal, keywords: 'line separator rule' },
  alert: { icon: TriangleAlert, keywords: 'banner message warning info callout' },
  progressBar: { icon: ChartNoAxesGantt, keywords: 'percentage loading status' },
  keyValue: { icon: Rows3, keywords: 'data object details record fields' },
  jsonExplorer: { icon: Braces, keywords: 'data object tree debug' },
}

/** The palette's categories, in order; each type is in exactly one (so its button's name is unique). */
export const PALETTE_GROUPS: readonly { title: string; types: readonly string[] }[] = [
  { title: 'Data', types: ['table', 'chart', 'keyValue', 'jsonExplorer'] },
  {
    title: 'Inputs',
    types: [
      'textInput',
      'textArea',
      'numberInput',
      'dateInput',
      'dateRange',
      'select',
      'checkbox',
      'switch',
      'checkboxGroup',
      'radioGroup',
      'segmentedControl',
      'fileInput',
    ],
  },
  { title: 'Buttons and text', types: ['button', 'text'] },
  { title: 'Presentation', types: ['statistic', 'image', 'alert', 'progressBar', 'divider'] },
  { title: 'Containers and forms', types: ['container', 'form', 'modal'] },
  { title: 'Navigation', types: ['navigation'] },
]

/**
 * The groups with the types matching `query` (every word found in the label, type or keywords; any case), empty
 * groups left out. `labelOf` gives a type's label; `allowed` drops types this editor can't place.
 */
export function filterPalette(
  query: string,
  labelOf: (type: string) => string,
  allowed: (type: string) => boolean = () => true,
): { title: string; types: string[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (type: string) => {
    const haystack = `${labelOf(type)} ${type} ${PALETTE_ENTRIES[type]?.keywords ?? ''}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  }
  return PALETTE_GROUPS.map((g) => ({
    title: g.title,
    types: g.types.filter((t) => allowed(t) && matches(t)),
  })).filter((g) => g.types.length > 0)
}

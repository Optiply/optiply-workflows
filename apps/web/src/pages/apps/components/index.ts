import type { ComponentType } from 'react'
import type { RendererProps } from '../renderer'
import { ButtonRenderer, TextRenderer } from './basic'
import { ChartRenderer } from './chart'
import { ContainerRenderer, FormRenderer, ModalRenderer } from './containers'
import { CustomRenderer } from './custom'
import {
  AlertRenderer,
  DividerRenderer,
  ImageRenderer,
  JsonExplorerRenderer,
  KeyValueRenderer,
  ProgressBarRenderer,
  StatisticRenderer,
} from './display'
import {
  CheckboxRenderer,
  DateInputRenderer,
  NumberInputRenderer,
  SelectRenderer,
  TextInputRenderer,
} from './inputs'
import { ModuleRenderer } from './module'
import {
  CheckboxGroupRenderer,
  DateRangeRenderer,
  FileInputRenderer,
  RadioGroupRenderer,
  SegmentedControlRenderer,
  SwitchRenderer,
  TextAreaRenderer,
} from './more-inputs'
import { NavigationRenderer } from './navigation'
import { TableRenderer } from './table'

/** Renderers by component type; a type without one shows its state. */
export const RENDERERS: Partial<Record<string, ComponentType<RendererProps>>> = {
  text: TextRenderer,
  button: ButtonRenderer,
  textInput: TextInputRenderer,
  numberInput: NumberInputRenderer,
  dateInput: DateInputRenderer,
  select: SelectRenderer,
  checkbox: CheckboxRenderer,
  table: TableRenderer,
  container: ContainerRenderer,
  form: FormRenderer,
  modal: ModalRenderer,
  chart: ChartRenderer,
  navigation: NavigationRenderer,
  module: ModuleRenderer,
  custom: CustomRenderer,
  // Session 41.
  textArea: TextAreaRenderer,
  switch: SwitchRenderer,
  checkboxGroup: CheckboxGroupRenderer,
  radioGroup: RadioGroupRenderer,
  segmentedControl: SegmentedControlRenderer,
  dateRange: DateRangeRenderer,
  fileInput: FileInputRenderer,
  statistic: StatisticRenderer,
  image: ImageRenderer,
  divider: DividerRenderer,
  alert: AlertRenderer,
  progressBar: ProgressBarRenderer,
  keyValue: KeyValueRenderer,
  jsonExplorer: JsonExplorerRenderer,
}

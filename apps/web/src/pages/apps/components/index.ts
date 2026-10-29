import type { ComponentType } from 'react'
import type { RendererProps } from '../renderer'
import { ButtonRenderer, TextRenderer } from './basic'
import { ChartRenderer } from './chart'
import { ContainerRenderer, FormRenderer, ModalRenderer } from './containers'
import { CustomRenderer } from './custom'
import {
  CheckboxRenderer,
  DateInputRenderer,
  NumberInputRenderer,
  SelectRenderer,
  TextInputRenderer,
} from './inputs'
import { ModuleRenderer } from './module'
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
}

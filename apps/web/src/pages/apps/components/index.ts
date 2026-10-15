import type { ComponentType } from 'react'
import type { RendererProps } from '../renderer'
import { ContainerRenderer, FormRenderer, ModalRenderer } from './containers'

/** Renderers by component type; types without one show their state. */
export const RENDERERS: Partial<Record<string, ComponentType<RendererProps>>> = {
  container: ContainerRenderer,
  form: FormRenderer,
  modal: ModalRenderer,
}

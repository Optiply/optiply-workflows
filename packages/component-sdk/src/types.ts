/**
 * The SDK's types as a declaration file, for the library editor's TypeScript checking (M25): Monaco gets this as
 * `@ow/component-sdk`. Kept by hand beside `index.ts`; a test checks the two name the same exports.
 */
export const SDK_TYPES = `declare module '@ow/component-sdk' {
  /** Light or dark, and the Optiply tokens (also CSS variables --ow-<name> on the frame's root). */
  export interface FrameTheme {
    mode: 'light' | 'dark'
    tokens: Record<string, string>
  }
  /** A prop's value as the app evaluated it (its declared default when the app leaves it empty). */
  export function useProp<T = unknown>(name: string): T
  /** Every prop by name. */
  export function useProps<T extends Record<string, unknown> = Record<string, unknown>>(): T
  /** A state value and its setter; the app reads it as <component>.<name>. */
  export function useStateValue<T = unknown>(name: string): [T, (next: T | ((previous: T) => T)) => void]
  /** A function that fires one of the component's events: the app runs its handlers. */
  export function useEvent(name: string): () => void
  /** Answers the app's calls to one of the component's methods with fn's result (awaited). */
  export function useMethod(name: string, fn: (...args: any[]) => unknown): void
  /** Light or dark, and the Optiply tokens. */
  export function useTheme(): FrameTheme
  /** What the app does for a component. */
  export const utils: {
    openUrl(url: string, options?: { newTab?: boolean }): void
    openPage(page: string, params?: Record<string, string>): void
    notify(message: string, tone?: 'info' | 'success' | 'error'): void
  }
}
`

/** The SDK's exports, as `SDK_TYPES` declares them. */
export const SDK_EXPORTS = [
  'useProp',
  'useProps',
  'useStateValue',
  'useEvent',
  'useMethod',
  'useTheme',
  'utils',
] as const

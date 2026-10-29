/**
 * Declarations a component library's TypeScript is checked against in the editor (M25): React's hooks and JSX as
 * far as components use them (the real types would weigh megabytes), CSS imports, and any npm package as `any`
 * (their types aren't installed in the browser). The SDK's come from `@ow/component-sdk/types`.
 */
export const REACT_DTS = `declare module 'react' {
  export type ReactNode = any
  export type ReactElement = any
  export type FC<P = {}> = (props: P) => ReactNode
  export type ComponentType<P = {}> = (props: P) => ReactNode
  export type Dispatch<A> = (value: A) => void
  export type SetStateAction<S> = S | ((previous: S) => S)
  export interface RefObject<T> { current: T }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>]
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T
  export function useRef<T>(initial: T): RefObject<T>
  export function useRef<T>(initial: T | null): RefObject<T | null>
  export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, Dispatch<A>]
  export function useId(): string
  export const Fragment: any
  export function createElement(type: any, props?: any, ...children: any[]): ReactElement
  const React: { createElement: typeof createElement; Fragment: any }
  export default React
}
declare module 'react/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
}
declare module 'react-dom' { const ReactDOM: any; export default ReactDOM; export function createPortal(children: any, node: Element): any }
declare module '*.css'
declare module '*.svg' { const url: string; export default url }
declare module '*.json' { const value: any; export default value }
declare namespace JSX {
  type Element = any
  interface IntrinsicElements { [name: string]: any }
  interface IntrinsicAttributes { key?: string | number }
}
`

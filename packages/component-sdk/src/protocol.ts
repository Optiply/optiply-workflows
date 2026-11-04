/**
 * How a custom component's frame and the app's page talk (M25, architecture §2.28). The page creates the frame (an
 * iframe with an opaque origin), posts {@link CONNECT_MESSAGE} with a `MessagePort`, and from then on both sides use
 * the port. Everything crossing it is structured-cloned: plain data only.
 */

/** Posted once by the page with the port. */
export const CONNECT_MESSAGE = 'ow-component-connect'

/** The theme a component sees: light or dark and the Optiply tokens (`--ow-*` names without the prefix). */
export interface FrameTheme {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}

/** From the page to the frame. */
export type ToFrame =
  | {
      type: 'init'
      /** The library's bundle (an ESM module exporting each component by name) and its CSS. */
      js: string
      css: string
      component: string
      props: Record<string, unknown>
      /** The declared state's starting values. */
      state: Record<string, unknown>
      theme: FrameTheme
    }
  | { type: 'props'; props: Record<string, unknown> }
  | { type: 'theme'; theme: FrameTheme }
  /** The app calls one of the component's methods; answered by `result` with the same id. */
  | { type: 'call'; id: number; method: string; args: unknown[] }
  | { type: 'ping'; n: number }

/** What a component asks the app to do (checked by the page, as an app's own `utils` are). */
export type FrameUtil =
  | { action: 'openUrl'; url: string; newTab?: boolean }
  | { action: 'openPage'; page: string; params?: Record<string, string> }
  | { action: 'notify'; message: string; tone?: 'info' | 'success' | 'error' }

/** From the frame to the page. */
export type FromFrame =
  /** The component is mounted. */
  | { type: 'ready' }
  | { type: 'setState'; name: string; value: unknown }
  | { type: 'event'; name: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | ({ type: 'util' } & FrameUtil)
  /** The bundle didn't load, the component isn't in it, or it threw while rendering. */
  | { type: 'error'; message: string }
  /** An error the component didn't catch outside rendering (an event handler, a promise): for the app's console. */
  | { type: 'log'; level: 'error' | 'warn'; message: string }
  | { type: 'pong'; n: number }

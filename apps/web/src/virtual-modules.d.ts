declare module 'virtual:app-runtime' {
  /** The app sandbox's script, bundled into one IIFE (see vite/app-runtime.ts). */
  const code: string
  export default code
}

declare module 'virtual:component-frame' {
  /** A custom component frame's script (M25), bundled into one IIFE (see vite/app-runtime.ts). */
  const code: string
  export default code
}

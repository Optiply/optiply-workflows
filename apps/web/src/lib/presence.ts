/**
 * Each person's colour while editing together (M16): one of the palette's hues, the same for them everywhere (code
 * field cursors, avatars, outlines on blocks), picked from their user id. `.ow-presence-<n>` (styles.css) sets
 * `--presence` to it, in either theme (selections mix it lighter).
 */
export const PRESENCE_COLOURS = 6

export function presenceColour(userId: string | undefined): number {
  let hash = 0
  for (const c of userId ?? '') hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return hash % PRESENCE_COLOURS
}

/** Who someone is, as the server puts it in their presence. */
export interface PresenceUser {
  id: string
  name: string
  avatarUrl: string | null
}

import type { Peer } from '@/lib/presence'
import { cn } from '@/lib/utils'
import { Avatar } from './ui'

/** At most this many people's avatars show; the rest are counted. */
const MAX_AVATARS = 4

/**
 * Who else has the draft open (M16), each ringed in their colour; `me` (in any tab) isn't shown, and someone with
 * several tabs shows once.
 */
export function PresenceAvatars({ peers, me }: { peers: Peer[]; me: string }) {
  const people = [...new Map(peers.filter((p) => p.user.id !== me).map((p) => [p.user.id, p])).values()]
  if (!people.length) return null
  const more = people.length - MAX_AVATARS
  return (
    <div className="flex items-center" data-testid="presence">
      {people.slice(0, MAX_AVATARS).map((p) => (
        <span
          key={p.user.id}
          title={p.user.name}
          data-testid={`presence-${p.user.name}`}
          className={cn(
            '-ml-1.5 rounded-full ring-2 ring-[var(--presence)] first:ml-0',
            `ow-presence-${p.colour}`,
          )}
        >
          <Avatar name={p.user.name} src={p.user.avatarUrl} />
        </span>
      ))}
      {more > 0 && <span className="ml-1.5 text-xs text-muted">and {more} more</span>}
    </div>
  )
}

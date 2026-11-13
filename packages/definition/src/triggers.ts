import { DEFAULT_TIMEZONE, nextCronFire, nextIntervalFire, parseCron } from './cron'
import {
  DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS,
  type ScheduleTrigger,
  type WEBHOOK_METHODS,
  type WEBHOOK_SIGNATURE_PRESETS,
  type WebhookAuth,
  type WebhookTrigger,
} from './schema'

/** One segment of a webhook alias: fixed text, or a `:name` that captures that part of the URL. */
export type AliasSegment = { text: string; param?: undefined } | { param: string; text?: undefined }

export type AliasParseResult =
  | {
      ok: true
      segments: AliasSegment[]
      /** Segments with every param as `:`, e.g. `orders/:`. Two live aliases with the same shape conflict. */
      shape: string
    }
  | { ok: false; error: string; hint?: string }

const MAX_ALIAS_SEGMENTS = 10
const TEXT_SEGMENT = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]{0,31})$/

/**
 * Parses a webhook alias such as `orders/:orderId/refunds`. Segments are lowercase text or `:params`; the first one
 * must be text, so every alias has a fixed prefix.
 */
export function parseWebhookAlias(alias: string): AliasParseResult {
  if (alias.startsWith('/') || alias.endsWith('/')) {
    return {
      ok: false,
      error: "An alias can't start or end with /",
      hint: 'Write orders/:id, not /orders/:id/',
    }
  }
  const parts = alias.split('/')
  if (parts.length > MAX_ALIAS_SEGMENTS) {
    return { ok: false, error: `An alias can have at most ${MAX_ALIAS_SEGMENTS} segments` }
  }
  const segments: AliasSegment[] = []
  const params = new Set<string>()
  for (const [i, part] of parts.entries()) {
    const param = PARAM_SEGMENT.exec(part)?.[1]
    if (param) {
      if (i === 0) return { ok: false, error: 'An alias must start with fixed text, not a :param' }
      if (params.has(param)) return { ok: false, error: `The parameter ":${param}" appears twice` }
      params.add(param)
      segments.push({ param })
    } else if (TEXT_SEGMENT.test(part)) {
      segments.push({ text: part })
    } else {
      return {
        ok: false,
        error: part ? `Invalid alias segment "${part}"` : 'An alias has an empty segment (//)',
        hint: 'Use lowercase letters, digits, -, _ or ., or :name for a parameter',
      }
    }
  }
  return { ok: true, segments, shape: segments.map((s) => s.text ?? ':').join('/') }
}

/**
 * Matches URL path segments (already split and decoded) against an alias. Returns the captured params, or null.
 * Callers prefer the alias with the most fixed segments when several match.
 */
export function matchWebhookAlias(
  segments: readonly AliasSegment[],
  path: readonly string[],
): Record<string, string> | null {
  if (segments.length !== path.length) return null
  const params: Record<string, string> = {}
  for (const [i, segment] of segments.entries()) {
    if (segment.param) {
      if (!path[i]) return null
      params[segment.param] = path[i]!
    } else if (segment.text !== path[i]) {
      return null
    }
  }
  return params
}

/**
 * When a schedule fires next, strictly after `after`. Interval schedules keep to the grid of their previous fire
 * (the first fire is one interval after `after`). Null when the schedule is invalid or never fires.
 */
export function nextScheduleFire(
  schedule: Pick<ScheduleTrigger, 'cron' | 'intervalMs' | 'timezone'>,
  after: Date,
  previous?: Date | null,
): Date | null {
  if (schedule.intervalMs !== undefined && schedule.cron === undefined) {
    if (schedule.intervalMs <= 0) return null
    return previous
      ? nextIntervalFire(previous, schedule.intervalMs, after)
      : new Date(after.getTime() + schedule.intervalMs)
  }
  if (schedule.cron === undefined || schedule.intervalMs !== undefined) return null
  const parsed = parseCron(schedule.cron)
  if (!parsed.ok) return null
  try {
    return nextCronFire(parsed.cron, after, schedule.timezone ?? DEFAULT_TIMEZONE)
  } catch {
    return null // Unknown time zone.
  }
}

export type WebhookSignaturePreset = (typeof WEBHOOK_SIGNATURE_PRESETS)[number]

export interface WebhookPresetInfo {
  label: string
  /** The header with the signature, lowercase. */
  header: string
  /** The header with the signing time, when the provider sends it apart from the signature. */
  timestampHeader?: string
  /** Whether the signature covers a timestamp, so `toleranceSeconds` applies. */
  timestamped: boolean
  /** The provider's delivery id, used as the Idempotency-Key unless the webhook sets another header. */
  idempotencyHeader?: string
}

/** What the editor shows and the server checks for each provider preset (custom is configured by hand). */
export const WEBHOOK_PRESETS: Record<Exclude<WebhookSignaturePreset, 'custom'>, WebhookPresetInfo> = {
  stripe: { label: 'Stripe', header: 'stripe-signature', timestamped: true },
  github: {
    label: 'GitHub',
    header: 'x-hub-signature-256',
    timestamped: false,
    idempotencyHeader: 'x-github-delivery',
  },
  slack: {
    label: 'Slack',
    header: 'x-slack-signature',
    timestampHeader: 'x-slack-request-timestamp',
    timestamped: true,
  },
  hubspot: {
    label: 'HubSpot',
    header: 'x-hubspot-signature-v3',
    timestampHeader: 'x-hubspot-request-timestamp',
    timestamped: true,
  },
  shopify: {
    label: 'Shopify',
    header: 'x-shopify-hmac-sha256',
    timestamped: false,
    idempotencyHeader: 'x-shopify-webhook-id',
  },
  sns: {
    label: 'Amazon SNS',
    header: 'x-amz-sns-message-type',
    timestamped: false,
    idempotencyHeader: 'x-amz-sns-message-id',
  },
}

export const DEFAULT_WEBHOOK_METHODS: readonly (typeof WEBHOOK_METHODS)[number][] = ['POST']
export const DEFAULT_WEBHOOK_RATE_LIMIT = { requests: 60, windowSeconds: 60 } as const
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300
/** Custom signatures sign the body alone unless `signedPayload` says otherwise. */
export const DEFAULT_SIGNED_PAYLOAD = '{body}'
export const SIGNED_PAYLOAD_PARTS = ['timestamp', 'body', 'method', 'url'] as const
/** The largest body schema, as JSON. */
export const MAX_BODY_SCHEMA_BYTES = 64 * 1024

export interface ResolvedWebhook {
  enabled: boolean
  alias?: string
  methods: readonly (typeof WEBHOOK_METHODS)[number][]
  syncTimeoutMs: number
  auth: WebhookAuth
  bodySchema: Record<string, unknown> | null
  /** Null: no limit (API-key webhooks without one). */
  rateLimit: { requests: number; windowSeconds: number } | null
  /** `all` (API-key webhooks by default), `default` (the default environment) or the listed slugs. */
  environments: 'all' | 'default' | readonly string[]
  /** Lowercase; null when there is none. */
  idempotencyHeader: string | null
}

/**
 * A webhook with every default applied, so the server and the editor agree on them: API-key auth; signed and public
 * webhooks rate limited and limited to the default environment unless they say otherwise; a preset's delivery id as
 * the idempotency header.
 */
export function resolveWebhookSettings(webhook: WebhookTrigger): ResolvedWebhook {
  const auth: WebhookAuth = webhook.auth ?? { type: 'apiKey' }
  const keyed = auth.type === 'apiKey'
  const preset =
    auth.type === 'signature' && auth.preset !== 'custom' ? WEBHOOK_PRESETS[auth.preset] : undefined
  const idempotencyHeader = webhook.idempotencyHeader ?? preset?.idempotencyHeader
  return {
    enabled: webhook.enabled,
    ...(webhook.alias !== undefined && { alias: webhook.alias }),
    methods: webhook.methods ?? DEFAULT_WEBHOOK_METHODS,
    syncTimeoutMs: webhook.syncTimeoutMs ?? DEFAULT_WEBHOOK_SYNC_TIMEOUT_MS,
    auth,
    bodySchema: webhook.bodySchema ?? null,
    rateLimit: webhook.rateLimit ?? (keyed ? null : DEFAULT_WEBHOOK_RATE_LIMIT),
    environments: webhook.environments ?? (keyed ? 'all' : 'default'),
    idempotencyHeader: idempotencyHeader ? idempotencyHeader.toLowerCase() : null,
  }
}

/**
 * The environments a webhook runs in, out of `envs`: all of them, the default one, or the listed ones in their order
 * (slugs no environment has are left out). The runtime check, the publish check and the OpenAPI document all use it.
 */
export function webhookEnvironments<E extends { slug: string; isDefault: boolean }>(
  webhook: Pick<ResolvedWebhook, 'environments'>,
  envs: readonly E[],
): E[] {
  const allowed = webhook.environments
  if (allowed === 'all') return [...envs]
  if (allowed === 'default') return envs.filter((e) => e.isDefault)
  return allowed.flatMap((slug) => envs.filter((e) => e.slug === slug))
}

/** The header a signed webhook's signature arrives in (lowercase); null for other auth or a custom one without it. */
export function signatureHeaderOf(auth: WebhookAuth): string | null {
  if (auth.type !== 'signature') return null
  return auth.preset === 'custom' ? auth.header?.toLowerCase() || null : WEBHOOK_PRESETS[auth.preset].header
}

export type SignedPayloadPart = (typeof SIGNED_PAYLOAD_PARTS)[number]

export type SignedPayloadParseResult =
  | { ok: true; pieces: ({ text: string } | { part: SignedPayloadPart })[] }
  | { ok: false; error: string; hint?: string }

/**
 * Splits a custom signature's `signedPayload` (e.g. `{timestamp}.{body}`) into text and parts. Only the four parts
 * are placeholders; it must contain `{body}`.
 */
export function parseSignedPayload(template: string): SignedPayloadParseResult {
  const pieces: ({ text: string } | { part: SignedPayloadPart })[] = []
  const placeholder = /\{([A-Za-z_]+)\}/g
  let last = 0
  for (const match of template.matchAll(placeholder)) {
    const name = match[1]!
    if (!(SIGNED_PAYLOAD_PARTS as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: `Unknown part {${name}}`,
        hint: `Use ${SIGNED_PAYLOAD_PARTS.map((p) => `{${p}}`).join(', ')}`,
      }
    }
    if (match.index > last) pieces.push({ text: template.slice(last, match.index) })
    pieces.push({ part: name as SignedPayloadPart })
    last = match.index + match[0].length
  }
  if (last < template.length) pieces.push({ text: template.slice(last) })
  if (!pieces.some((p) => 'part' in p && p.part === 'body')) {
    return { ok: false, error: 'The signed payload must include {body}' }
  }
  return { ok: true, pieces }
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/

/** Whether a string is a valid HTTP header name. */
export function isHeaderName(name: string): boolean {
  return HEADER_NAME.test(name)
}

/** The rule for config var names (the config vars API uses the same). */
export const CONFIG_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

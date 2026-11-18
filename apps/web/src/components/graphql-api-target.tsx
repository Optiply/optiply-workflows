import { RefreshCw } from 'lucide-react'
import { type RequestAuth, RequestAuthFields } from '@/components/action-query'
import { Button, Field, Input } from '@/components/ui'
import type { GraphqlApiSchemaState } from '@/lib/graphql-schema'

/**
 * The built-in GraphQL resource's endpoint (session 57): its full URL, its own sign-in, and Load schema, which reads
 * the endpoint's schema for the query editor's completions. Shared by the workflow block, the app query and the
 * playground.
 */
export function GraphqlApiTargetFields({
  url,
  onUrl,
  auth,
  onAuth,
  schema,
  onLoadSchema,
  urlPlaceholder = 'https://api.example.com/graphql',
  secretsHint,
}: {
  url: string
  onUrl: (url: string) => void
  auth: RequestAuth | undefined
  onAuth: (auth: RequestAuth) => void
  schema: GraphqlApiSchemaState
  onLoadSchema: () => void
  urlPlaceholder?: string
  secretsHint?: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Endpoint URL"
        hint="The GraphQL endpoint’s full URL. In apps, type its scheme and host out."
      >
        <Input
          aria-label="Endpoint URL"
          className="font-mono"
          placeholder={urlPlaceholder}
          value={url}
          data-testid="graphql-api-url"
          onChange={(e) => onUrl(e.target.value)}
        />
      </Field>
      <RequestAuthFields auth={auth} onChange={onAuth} {...(secretsHint && { secretsHint })} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          loading={schema.status === 'loading'}
          disabled={!/^https?:\/\/\S/i.test(url.trim())}
          data-testid="graphql-api-load-schema"
          onClick={onLoadSchema}
        >
          <RefreshCw className="size-3.5" /> {schema.status === 'loaded' ? 'Reload schema' : 'Load schema'}
        </Button>
        <span
          className={schema.status === 'failed' ? 'text-xs text-danger' : 'text-xs text-muted'}
          data-testid="graphql-api-schema-status"
        >
          {schema.status === 'loaded'
            ? `Schema loaded: ${schema.types} types.`
            : schema.status === 'failed'
              ? `The schema couldn’t be read: ${schema.message}`
              : schema.status === 'loading'
                ? 'Reading the schema…'
                : 'Reads the endpoint’s schema for completions. Secret config vars aren’t filled in here.'}
        </span>
      </div>
    </div>
  )
}

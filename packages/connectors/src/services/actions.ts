// Pure data with no Node imports, so the web app's query forms can use it (`@ow/connectors/actions`).
//
// The service connectors' actions (M27, M29): Slack, HubSpot, SendGrid, Google Sheets, S3, … A query is `{action, ...fields}`
// where every field is a string: a template, rendered by its kind when the query runs.

export const SERVICE_TYPES = [
  'slack',
  'hubspot',
  'sendgrid',
  'googlesheets',
  's3',
  'stripe',
  'airtable',
  'jira',
  'notion',
  'salesforce',
  'rabbitmq',
  'sns',
  'kinesis',
  // AI (M35): a language model's actions, through Anthropic's API or an OpenAI-compatible one.
  'anthropic',
  'openai_compatible',
] as const
export type ServiceType = (typeof SERVICE_TYPES)[number]

export function isServiceType(type: string | undefined): type is ServiceType {
  return (SERVICE_TYPES as readonly string[]).includes(type ?? '')
}

export interface ActionField {
  key: string
  label: string
  /**
   * How the template is read: `text` a line, `long` several lines (`language` for the editor), `json` JSON with
   * `{{ }}` (as a REST body), `value` a lone `{{ }}` for any value or text, `list` an array (`{{ }}`) or comma- and
   * line-separated text, `bool` true/false, `number`, `select` one of `options`.
   */
  kind: 'text' | 'long' | 'json' | 'value' | 'list' | 'bool' | 'number' | 'select'
  required?: boolean
  placeholder?: string
  hint?: string
  options?: readonly { value: string; label: string }[]
  language?: 'json' | 'html' | 'markdown' | 'plaintext'
  /** What a new query starts with. */
  initial?: string
}

export interface ActionSpec {
  id: string
  label: string
  description: string
  fields: readonly ActionField[]
}

const MAX_FIELD: ActionField = {
  key: 'max',
  label: 'At most',
  kind: 'number',
  placeholder: '1000',
  hint: 'Pages are fetched until this many results (default 1,000).',
}

const API_FIELDS: readonly ActionField[] = [
  {
    key: 'method',
    label: 'Method',
    kind: 'select',
    options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
    initial: 'GET',
  },
  { key: 'path', label: 'Path', kind: 'text', required: true },
  {
    key: 'query',
    label: 'Query parameters',
    kind: 'json',
    language: 'json',
    hint: 'A JSON object, or empty.',
  },
  { key: 'body', label: 'Body', kind: 'json', language: 'json', hint: 'JSON, or empty.' },
]

const SLACK: readonly ActionSpec[] = [
  {
    id: 'postMessage',
    label: 'Send a message',
    description: 'chat.postMessage: to a channel (name or id), a person’s id, or a thread.',
    fields: [
      { key: 'channel', label: 'Channel', kind: 'text', required: true, placeholder: '#general or C0123…' },
      {
        key: 'text',
        label: 'Text',
        kind: 'long',
        language: 'markdown',
        hint: 'Slack’s mrkdwn. Also the fallback when there are blocks.',
      },
      {
        key: 'blocks',
        label: 'Blocks',
        kind: 'json',
        language: 'json',
        hint: 'Block Kit JSON (an array), or empty.',
      },
      { key: 'threadTs', label: 'Reply in thread (ts)', kind: 'text', placeholder: '1712345678.000100' },
      { key: 'replyBroadcast', label: 'Also send to the channel', kind: 'bool' },
      { key: 'unfurlLinks', label: 'Unfurl links', kind: 'bool' },
      { key: 'username', label: 'Name shown', kind: 'text', hint: 'Needs the chat:write.customize scope.' },
      { key: 'iconEmoji', label: 'Icon emoji', kind: 'text', placeholder: ':robot_face:' },
    ],
  },
  {
    id: 'updateMessage',
    label: 'Edit a message',
    description: 'chat.update: a message the token sent, by channel and ts.',
    fields: [
      { key: 'channel', label: 'Channel id', kind: 'text', required: true },
      { key: 'ts', label: 'Message ts', kind: 'text', required: true },
      { key: 'text', label: 'Text', kind: 'long', language: 'markdown' },
      { key: 'blocks', label: 'Blocks', kind: 'json', language: 'json' },
    ],
  },
  {
    id: 'deleteMessage',
    label: 'Delete a message',
    description: 'chat.delete: by channel and ts.',
    fields: [
      { key: 'channel', label: 'Channel id', kind: 'text', required: true },
      { key: 'ts', label: 'Message ts', kind: 'text', required: true },
    ],
  },
  {
    id: 'listChannels',
    label: 'List channels',
    description: 'conversations.list, every page.',
    fields: [
      {
        key: 'types',
        label: 'Types',
        kind: 'text',
        initial: 'public_channel',
        hint: 'Comma-separated: public_channel, private_channel, mpim, im.',
      },
      { key: 'excludeArchived', label: 'Leave out archived', kind: 'bool', initial: 'true' },
      MAX_FIELD,
    ],
  },
  {
    id: 'listUsers',
    label: 'List people',
    description: 'users.list, every page.',
    fields: [MAX_FIELD],
  },
  {
    id: 'lookupUserByEmail',
    label: 'Find a person by email',
    description: 'users.lookupByEmail (needs users:read.email).',
    fields: [{ key: 'email', label: 'Email', kind: 'text', required: true }],
  },
  {
    id: 'uploadFile',
    label: 'Upload a file',
    description: 'A file from base64 or a webhook’s upload, shared to a channel.',
    fields: [
      {
        key: 'channel',
        label: 'Channel id',
        kind: 'text',
        placeholder: 'C0123…',
        hint: 'Empty: uploaded, not shared.',
      },
      {
        key: 'file',
        label: 'File',
        kind: 'value',
        required: true,
        hint: 'Base64 text, or {{ startTrigger.data.file }}.',
      },
      { key: 'filename', label: 'File name', kind: 'text', required: true },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'comment', label: 'Message', kind: 'long', language: 'markdown' },
      { key: 'threadTs', label: 'In thread (ts)', kind: 'text' },
    ],
  },
  {
    id: 'api',
    label: 'Call any method',
    description: 'Any Web API method with JSON arguments.',
    fields: [
      { key: 'method', label: 'Method', kind: 'text', required: true, placeholder: 'reactions.add' },
      { key: 'args', label: 'Arguments', kind: 'json', language: 'json', initial: '{}' },
    ],
  },
]

const OBJECT_TYPE: ActionField = {
  key: 'objectType',
  label: 'Object',
  kind: 'text',
  required: true,
  initial: 'contacts',
  hint: 'contacts, companies, deals, tickets, products, line_items, or a custom object’s type id.',
}

const HUBSPOT: readonly ActionSpec[] = [
  {
    id: 'search',
    label: 'Search records',
    description: 'CRM search, every page up to “At most”.',
    fields: [
      OBJECT_TYPE,
      {
        key: 'filters',
        label: 'Filters',
        kind: 'json',
        language: 'json',
        hint: 'An array of {propertyName, operator, value} (all must match), or HubSpot’s filterGroups. Empty: all.',
        initial: '[]',
      },
      { key: 'query', label: 'Text search', kind: 'text' },
      { key: 'properties', label: 'Properties', kind: 'list', placeholder: 'email, firstname, lastname' },
      {
        key: 'sorts',
        label: 'Sort',
        kind: 'json',
        language: 'json',
        hint: '[{"propertyName": "createdate", "direction": "DESCENDING"}]',
      },
      { ...MAX_FIELD, hint: 'At most this many results (HubSpot’s search stops at 10,000).' },
    ],
  },
  {
    id: 'get',
    label: 'Get a record',
    description: 'By its id, or by a unique property.',
    fields: [
      OBJECT_TYPE,
      { key: 'id', label: 'Id', kind: 'text', required: true },
      {
        key: 'idProperty',
        label: 'Id property',
        kind: 'text',
        placeholder: 'email',
        hint: 'Empty: HubSpot’s record id.',
      },
      { key: 'properties', label: 'Properties', kind: 'list' },
      { key: 'associations', label: 'Associations', kind: 'list', placeholder: 'companies, deals' },
    ],
  },
  {
    id: 'create',
    label: 'Create a record',
    description: 'With its properties.',
    fields: [
      OBJECT_TYPE,
      {
        key: 'properties',
        label: 'Properties',
        kind: 'json',
        language: 'json',
        required: true,
        initial: '{}',
      },
    ],
  },
  {
    id: 'update',
    label: 'Update a record',
    description: 'Changes only the properties given.',
    fields: [
      OBJECT_TYPE,
      { key: 'id', label: 'Id', kind: 'text', required: true },
      { key: 'idProperty', label: 'Id property', kind: 'text', placeholder: 'email' },
      {
        key: 'properties',
        label: 'Properties',
        kind: 'json',
        language: 'json',
        required: true,
        initial: '{}',
      },
    ],
  },
  {
    id: 'archive',
    label: 'Archive a record',
    description: 'HubSpot’s delete (restorable for 90 days).',
    fields: [OBJECT_TYPE, { key: 'id', label: 'Id', kind: 'text', required: true }],
  },
  {
    id: 'batchUpsert',
    label: 'Create or update many',
    description: 'Matched by a unique property, in batches of 100.',
    fields: [
      OBJECT_TYPE,
      { key: 'idProperty', label: 'Matched by', kind: 'text', required: true, placeholder: 'email' },
      {
        key: 'records',
        label: 'Records',
        kind: 'value',
        required: true,
        hint: 'An array of objects of properties, each with the matching property: {{ table.data }}.',
      },
    ],
  },
  {
    id: 'associate',
    label: 'Associate two records',
    description: 'HubSpot’s default association between them.',
    fields: [
      { ...OBJECT_TYPE, key: 'fromType', label: 'From object' },
      { key: 'fromId', label: 'From id', kind: 'text', required: true },
      { ...OBJECT_TYPE, key: 'toType', label: 'To object', initial: 'companies' },
      { key: 'toId', label: 'To id', kind: 'text', required: true },
    ],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under api.hubapi.com.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/crm/v3/owners' } : f)),
  },
]

const SENDGRID: readonly ActionSpec[] = [
  {
    id: 'send',
    label: 'Send an email',
    description: 'Mail Send: text, HTML or a dynamic template, with attachments.',
    fields: [
      {
        key: 'from',
        label: 'From',
        kind: 'text',
        required: true,
        placeholder: 'Optiply <noreply@optiply.com>',
      },
      {
        key: 'to',
        label: 'To',
        kind: 'list',
        required: true,
        hint: 'Addresses, comma-separated, or {{ an array }}.',
      },
      { key: 'cc', label: 'Cc', kind: 'list' },
      { key: 'bcc', label: 'Bcc', kind: 'list' },
      { key: 'replyTo', label: 'Reply to', kind: 'text' },
      {
        key: 'separate',
        label: 'One email per recipient',
        kind: 'bool',
        hint: 'Recipients don’t see each other.',
      },
      { key: 'subject', label: 'Subject', kind: 'text' },
      { key: 'text', label: 'Text', kind: 'long', language: 'plaintext' },
      { key: 'html', label: 'HTML', kind: 'long', language: 'html' },
      { key: 'templateId', label: 'Dynamic template id', kind: 'text', placeholder: 'd-…' },
      { key: 'templateData', label: 'Template data', kind: 'json', language: 'json' },
      {
        key: 'attachments',
        label: 'Attachments',
        kind: 'value',
        hint: 'An array of {base64, filename, contentType}, e.g. a webhook’s uploads.',
      },
      { key: 'categories', label: 'Categories', kind: 'list' },
      { key: 'customArgs', label: 'Custom arguments', kind: 'json', language: 'json' },
      {
        key: 'sendAt',
        label: 'Send at',
        kind: 'value',
        hint: 'A date, or seconds since 1970; up to 72 hours ahead.',
      },
    ],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under /v3.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/v3/suppression/bounces' } : f)),
  },
]

const SPREADSHEET: ActionField = {
  key: 'spreadsheet',
  label: 'Spreadsheet',
  kind: 'text',
  required: true,
  hint: 'Its id or URL.',
}
const VALUE_INPUT: ActionField = {
  key: 'valueInput',
  label: 'Values are',
  kind: 'select',
  options: [
    { value: 'USER_ENTERED', label: 'As if typed (formulas, dates)' },
    { value: 'RAW', label: 'Stored as they are' },
  ],
  initial: 'USER_ENTERED',
}

const GOOGLE_SHEETS: readonly ActionSpec[] = [
  {
    id: 'read',
    label: 'Read rows',
    description: 'A sheet or range; the first row names the columns.',
    fields: [
      SPREADSHEET,
      {
        key: 'range',
        label: 'Sheet or range',
        kind: 'text',
        placeholder: 'Orders or Orders!A1:F',
        hint: 'Empty: the first sheet.',
      },
      {
        key: 'headers',
        label: 'First row is headers',
        kind: 'bool',
        initial: 'true',
        hint: 'Rows come back as objects by column name.',
      },
      {
        key: 'render',
        label: 'Values',
        kind: 'select',
        options: [
          { value: 'FORMATTED_VALUE', label: 'As shown' },
          { value: 'UNFORMATTED_VALUE', label: 'Raw (numbers as numbers)' },
          { value: 'FORMULA', label: 'Formulas' },
        ],
        initial: 'FORMATTED_VALUE',
      },
    ],
  },
  {
    id: 'append',
    label: 'Append rows',
    description: 'After the last row; objects go under their column names.',
    fields: [
      SPREADSHEET,
      { key: 'range', label: 'Sheet', kind: 'text', placeholder: 'Orders', hint: 'Empty: the first sheet.' },
      {
        key: 'rows',
        label: 'Rows',
        kind: 'value',
        required: true,
        hint: 'An array of objects (by header) or of arrays.',
      },
      VALUE_INPUT,
    ],
  },
  {
    id: 'update',
    label: 'Update rows',
    description: 'Rows matching a key column (objects), or a range (arrays).',
    fields: [
      SPREADSHEET,
      {
        key: 'range',
        label: 'Sheet or range',
        kind: 'text',
        hint: 'With arrays: the range to write, e.g. Orders!B2:C3.',
      },
      {
        key: 'keyColumn',
        label: 'Key column',
        kind: 'text',
        placeholder: 'id',
        hint: 'With objects: the column matching rows.',
      },
      { key: 'rows', label: 'Rows', kind: 'value', required: true },
      VALUE_INPUT,
    ],
  },
  {
    id: 'clear',
    label: 'Clear a range',
    description: 'Values only; formatting stays.',
    fields: [SPREADSHEET, { key: 'range', label: 'Range', kind: 'text', required: true }],
  },
  {
    id: 'info',
    label: 'Spreadsheet info',
    description: 'Title and sheets with their sizes.',
    fields: [SPREADSHEET],
  },
  {
    id: 'addSheet',
    label: 'Add a sheet',
    description: 'A new tab.',
    fields: [SPREADSHEET, { key: 'title', label: 'Title', kind: 'text', required: true }],
  },
  {
    id: 'deleteSheet',
    label: 'Delete a sheet',
    description: 'A tab, by title.',
    fields: [SPREADSHEET, { key: 'title', label: 'Title', kind: 'text', required: true }],
  },
  {
    id: 'create',
    label: 'Create a spreadsheet',
    description: 'A new spreadsheet, shared with someone if given.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'sheets', label: 'Sheets', kind: 'list', placeholder: 'Orders, Customers' },
      {
        key: 'shareWith',
        label: 'Share with',
        kind: 'list',
        hint: 'Emails given edit access (through Google Drive).',
      },
    ],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under sheets.googleapis.com/v4/spreadsheets.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/{id}:batchUpdate' } : f)),
  },
]

const S3_BUCKET: ActionField = {
  key: 'bucket',
  label: 'Bucket',
  kind: 'text',
  placeholder: 'the resource’s default bucket',
  hint: 'Empty: the bucket set on the resource.',
}
const S3_KEY: ActionField = {
  key: 'key',
  label: 'Key',
  kind: 'text',
  required: true,
  placeholder: 'reports/2026-11.csv',
}
const S3_FORMAT: ActionField = {
  key: 'format',
  label: 'As',
  kind: 'select',
  options: [
    { value: 'text', label: 'Text' },
    { value: 'json', label: 'JSON' },
    { value: 'base64', label: 'Base64 (binary)' },
  ],
  initial: 'text',
}

const S3: readonly ActionSpec[] = [
  {
    id: 'list',
    label: 'List objects',
    description: 'Objects under a prefix, page after page; a delimiter groups keys into folders.',
    fields: [
      S3_BUCKET,
      { key: 'prefix', label: 'Prefix', kind: 'text', placeholder: 'reports/' },
      {
        key: 'delimiter',
        label: 'Delimiter',
        kind: 'text',
        placeholder: '/',
        hint: 'Set to / to list one folder level.',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'get',
    label: 'Get an object',
    description: 'An object’s content (up to 10 MB) as text, JSON or base64, with its type and metadata.',
    fields: [S3_BUCKET, S3_KEY, S3_FORMAT],
  },
  {
    id: 'put',
    label: 'Put an object',
    description: 'Writes an object from text, JSON or base64 (or a webhook’s file object).',
    fields: [
      S3_BUCKET,
      S3_KEY,
      {
        key: 'body',
        label: 'Content',
        kind: 'value',
        required: true,
        hint: 'Text, {{ }} for any value (objects are written as JSON), or base64 with As: Base64.',
      },
      S3_FORMAT,
      { key: 'contentType', label: 'Content type', kind: 'text', placeholder: 'text/csv' },
      {
        key: 'metadata',
        label: 'Metadata',
        kind: 'json',
        language: 'json',
        hint: 'A JSON object of strings, or empty.',
      },
      { key: 'cacheControl', label: 'Cache control', kind: 'text', placeholder: 'max-age=3600' },
    ],
  },
  {
    id: 'delete',
    label: 'Delete objects',
    description: 'Deletes one key, or several (a list).',
    fields: [
      S3_BUCKET,
      {
        key: 'keys',
        label: 'Keys',
        kind: 'list',
        required: true,
        hint: 'One key, a {{ }} array, or one per line.',
      },
    ],
  },
  {
    id: 'copy',
    label: 'Copy an object',
    description: 'Copies an object within a bucket or to another.',
    fields: [
      { key: 'sourceBucket', label: 'From bucket', kind: 'text', placeholder: 'the target bucket' },
      { key: 'sourceKey', label: 'From key', kind: 'text', required: true },
      S3_BUCKET,
      S3_KEY,
    ],
  },
  {
    id: 'head',
    label: 'Object details',
    description: 'An object’s size, type, ETag, dates and metadata, without its content.',
    fields: [S3_BUCKET, S3_KEY],
  },
  {
    id: 'presign',
    label: 'Presigned URL',
    description: 'A URL anyone can use to download (GET) or upload (PUT) one object until it expires.',
    fields: [
      S3_BUCKET,
      S3_KEY,
      {
        key: 'method',
        label: 'For',
        kind: 'select',
        options: [
          { value: 'GET', label: 'Download (GET)' },
          { value: 'PUT', label: 'Upload (PUT)' },
        ],
        initial: 'GET',
      },
      {
        key: 'expiresIn',
        label: 'Expires in (seconds)',
        kind: 'number',
        placeholder: '900',
        hint: 'Up to 604,800 (7 days).',
      },
      {
        key: 'contentType',
        label: 'Content type (PUT)',
        kind: 'text',
        hint: 'An upload must then send this type.',
      },
    ],
  },
  { id: 'listBuckets', label: 'List buckets', description: 'The buckets the identity can see.', fields: [] },
]

export const STRIPE_KINDS = [
  'customers',
  'payment_intents',
  'charges',
  'invoices',
  'subscriptions',
  'products',
  'prices',
  'refunds',
  'payment_methods',
  'coupons',
  'events',
] as const
/** The kinds Stripe's search API covers. */
export const STRIPE_SEARCHABLE = [
  'customers',
  'payment_intents',
  'charges',
  'invoices',
  'subscriptions',
  'products',
  'prices',
] as const

const stripeKind = (kinds: readonly string[] = STRIPE_KINDS): ActionField => ({
  key: 'kind',
  label: 'Object',
  kind: 'select',
  options: kinds.map((k) => ({ value: k, label: k.replaceAll('_', ' ') })),
  initial: 'customers',
})
const STRIPE_PARAMS: ActionField = {
  key: 'params',
  label: 'Parameters',
  kind: 'json',
  language: 'json',
  hint: 'A JSON object, as in Stripe’s API reference (nested objects and arrays are sent the way Stripe expects).',
}
const STRIPE_IDEMPOTENCY: ActionField = {
  key: 'idempotencyKey',
  label: 'Idempotency key',
  kind: 'text',
  hint: 'Empty: one made from the run and the request, so a retried block doesn’t charge twice.',
}

const STRIPE: readonly ActionSpec[] = [
  {
    id: 'list',
    label: 'List objects',
    description: 'Objects of a kind, newest first, page after page.',
    fields: [
      stripeKind(),
      {
        key: 'filters',
        label: 'Filters',
        kind: 'json',
        language: 'json',
        hint: 'e.g. {"customer": "cus_…", "status": "open"}',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Stripe’s search query language, e.g. email:"ada@example.com" AND metadata["shop"]:"nl".',
    fields: [
      stripeKind(STRIPE_SEARCHABLE),
      { key: 'query', label: 'Query', kind: 'text', required: true },
      MAX_FIELD,
    ],
  },
  {
    id: 'retrieve',
    label: 'Get an object',
    description: 'One object by its id.',
    fields: [
      stripeKind(),
      { key: 'id', label: 'Id', kind: 'text', required: true },
      { key: 'expand', label: 'Expand', kind: 'list', hint: 'Fields to expand, e.g. customer' },
    ],
  },
  {
    id: 'create',
    label: 'Create an object',
    description: 'Creates an object from its parameters.',
    fields: [stripeKind(), STRIPE_PARAMS, STRIPE_IDEMPOTENCY],
  },
  {
    id: 'update',
    label: 'Update an object',
    description: 'Changes an object’s parameters (an empty string clears one).',
    fields: [
      stripeKind(),
      { key: 'id', label: 'Id', kind: 'text', required: true },
      STRIPE_PARAMS,
      STRIPE_IDEMPOTENCY,
    ],
  },
  {
    id: 'delete',
    label: 'Delete an object',
    description: 'Deletes an object where Stripe allows it (customers, products, coupons, …).',
    fields: [stripeKind(), { key: 'id', label: 'Id', kind: 'text', required: true }],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under api.stripe.com/v1 (the body is sent form-encoded).',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/v1/balance' } : f)),
  },
]

const AIRTABLE_BASE: ActionField = {
  key: 'base',
  label: 'Base',
  kind: 'text',
  placeholder: 'the resource’s default base (app…)',
  hint: 'A base id (app…). Empty: the base set on the resource.',
}
const AIRTABLE_TABLE: ActionField = {
  key: 'table',
  label: 'Table',
  kind: 'text',
  required: true,
  placeholder: 'Orders or tbl…',
}
const AIRTABLE_TYPECAST: ActionField = {
  key: 'typecast',
  label: 'Convert values',
  kind: 'bool',
  hint: 'Let Airtable turn text into the field’s type (and add select options).',
}

const AIRTABLE: readonly ActionSpec[] = [
  {
    id: 'list',
    label: 'List records',
    description: 'Records of a table or view, filtered by a formula, page after page.',
    fields: [
      AIRTABLE_BASE,
      AIRTABLE_TABLE,
      { key: 'view', label: 'View', kind: 'text' },
      { key: 'filterByFormula', label: 'Formula', kind: 'text', placeholder: "{Status} = 'Open'" },
      {
        key: 'sort',
        label: 'Sort',
        kind: 'json',
        language: 'json',
        hint: '[{"field": "Name", "direction": "asc"}]',
      },
      { key: 'fields', label: 'Fields', kind: 'list', hint: 'Only these fields (empty: all).' },
      MAX_FIELD,
    ],
  },
  {
    id: 'get',
    label: 'Get a record',
    description: 'One record by its id.',
    fields: [AIRTABLE_BASE, AIRTABLE_TABLE, { key: 'id', label: 'Record id', kind: 'text', required: true }],
  },
  {
    id: 'create',
    label: 'Create records',
    description: 'One record (an object of fields) or many (an array); sent 10 at a time.',
    fields: [
      AIRTABLE_BASE,
      AIRTABLE_TABLE,
      { key: 'records', label: 'Records', kind: 'json', language: 'json', required: true },
      AIRTABLE_TYPECAST,
    ],
  },
  {
    id: 'update',
    label: 'Update records',
    description: 'Records as {id, fields} (or {id, ...fields}); only the fields given change.',
    fields: [
      AIRTABLE_BASE,
      AIRTABLE_TABLE,
      { key: 'records', label: 'Records', kind: 'json', language: 'json', required: true },
      AIRTABLE_TYPECAST,
    ],
  },
  {
    id: 'upsert',
    label: 'Upsert records',
    description: 'Updates records matching on the merge fields, creates the rest.',
    fields: [
      AIRTABLE_BASE,
      AIRTABLE_TABLE,
      { key: 'records', label: 'Records', kind: 'json', language: 'json', required: true },
      { key: 'mergeOn', label: 'Match on', kind: 'list', required: true, hint: 'Field names, e.g. SKU' },
      AIRTABLE_TYPECAST,
    ],
  },
  {
    id: 'delete',
    label: 'Delete records',
    description: 'Records by id (a list), 10 at a time.',
    fields: [
      AIRTABLE_BASE,
      AIRTABLE_TABLE,
      { key: 'ids', label: 'Record ids', kind: 'list', required: true },
    ],
  },
  {
    id: 'schema',
    label: 'Tables and fields',
    description: 'The base’s tables, their fields and views.',
    fields: [AIRTABLE_BASE],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under api.airtable.com/v0.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/v0/meta/bases' } : f)),
  },
]

const JIRA_ISSUE: ActionField = {
  key: 'issue',
  label: 'Issue',
  kind: 'text',
  required: true,
  placeholder: 'OPS-123',
}
const JIRA_FIELDS: ActionField = {
  key: 'fields',
  label: 'Other fields',
  kind: 'json',
  language: 'json',
  hint: 'A JSON object of Jira fields, e.g. {"labels": ["stock"], "priority": {"name": "High"}}',
}

const JIRA: readonly ActionSpec[] = [
  {
    id: 'search',
    label: 'Search issues (JQL)',
    description: 'Issues matching a JQL query, page after page.',
    fields: [
      {
        key: 'jql',
        label: 'JQL',
        kind: 'long',
        required: true,
        language: 'plaintext',
        initial: 'project = OPS AND statusCategory != Done ORDER BY updated DESC',
      },
      {
        key: 'fieldList',
        label: 'Fields',
        kind: 'list',
        hint: 'Fields to return (default: summary, status, assignee, updated, …).',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'getIssue',
    label: 'Get an issue',
    description: 'One issue by key or id.',
    fields: [JIRA_ISSUE, { key: 'fieldList', label: 'Fields', kind: 'list', hint: 'Empty: all fields.' }],
  },
  {
    id: 'createIssue',
    label: 'Create an issue',
    description: 'A new issue; the description is plain text (turned into Jira’s format).',
    fields: [
      { key: 'project', label: 'Project', kind: 'text', required: true, placeholder: 'OPS' },
      { key: 'issueType', label: 'Issue type', kind: 'text', required: true, initial: 'Task' },
      { key: 'summary', label: 'Summary', kind: 'text', required: true },
      { key: 'description', label: 'Description', kind: 'long', language: 'plaintext' },
      JIRA_FIELDS,
    ],
  },
  {
    id: 'updateIssue',
    label: 'Update an issue',
    description: 'Changes the fields given.',
    fields: [
      JIRA_ISSUE,
      { key: 'summary', label: 'Summary', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'long', language: 'plaintext' },
      JIRA_FIELDS,
    ],
  },
  {
    id: 'transition',
    label: 'Move an issue',
    description: 'Moves an issue through its workflow by the transition’s name (or id).',
    fields: [
      JIRA_ISSUE,
      { key: 'transition', label: 'Transition', kind: 'text', required: true, placeholder: 'Done' },
      { key: 'comment', label: 'Comment', kind: 'long', language: 'plaintext' },
      JIRA_FIELDS,
    ],
  },
  {
    id: 'addComment',
    label: 'Comment on an issue',
    description: 'Adds a plain-text comment.',
    fields: [
      JIRA_ISSUE,
      { key: 'body', label: 'Comment', kind: 'long', required: true, language: 'plaintext' },
    ],
  },
  {
    id: 'assign',
    label: 'Assign an issue',
    description: 'Assigns to a user (Cloud: account id; Data Center: username); empty unassigns.',
    fields: [JIRA_ISSUE, { key: 'assignee', label: 'Assignee', kind: 'text' }],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under the site’s /rest.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/rest/api/3/project' } : f)),
  },
]

const NOTION_ID = (label: string): ActionField => ({
  key: 'id',
  label,
  kind: 'text',
  required: true,
  hint: 'Its id or its Notion URL.',
})
const NOTION_PROPERTIES: ActionField = {
  key: 'properties',
  label: 'Properties',
  kind: 'json',
  language: 'json',
  hint: 'Plain values by property name, e.g. {"Name": "Order 12", "Qty": 3, "Tags": ["urgent"], "Due": "2026-11-04"}',
}

const NOTION: readonly ActionSpec[] = [
  {
    id: 'queryDatabase',
    label: 'Query a database',
    description: 'A database’s pages, filtered and sorted (Notion’s JSON), as rows of plain values.',
    fields: [
      NOTION_ID('Database'),
      {
        key: 'filter',
        label: 'Filter',
        kind: 'json',
        language: 'json',
        hint: '{"property": "Status", "status": {"equals": "Open"}}',
      },
      {
        key: 'sorts',
        label: 'Sorts',
        kind: 'json',
        language: 'json',
        hint: '[{"property": "Due", "direction": "ascending"}]',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'getPage',
    label: 'Get a page',
    description: 'A page’s properties as plain values.',
    fields: [NOTION_ID('Page')],
  },
  {
    id: 'createPage',
    label: 'Create a page',
    description: 'A page in a database (properties as plain values) or under a page, with optional content.',
    fields: [
      {
        key: 'parent',
        label: 'Database or page',
        kind: 'text',
        required: true,
        hint: 'An id or URL. A database takes properties; a page takes a title.',
      },
      NOTION_PROPERTIES,
      { key: 'title', label: 'Title (under a page)', kind: 'text' },
      {
        key: 'content',
        label: 'Content',
        kind: 'long',
        language: 'markdown',
        hint: 'Lines: # heading, - bullet, 1. numbered, [ ] to-do, else paragraphs.',
      },
    ],
  },
  {
    id: 'updatePage',
    label: 'Update a page',
    description: 'Changes the properties given (plain values).',
    fields: [NOTION_ID('Page'), NOTION_PROPERTIES],
  },
  {
    id: 'archivePage',
    label: 'Archive a page',
    description: 'Moves a page to the trash.',
    fields: [NOTION_ID('Page')],
  },
  {
    id: 'appendBlocks',
    label: 'Add content',
    description: 'Adds content at the end of a page.',
    fields: [
      NOTION_ID('Page'),
      {
        key: 'content',
        label: 'Content',
        kind: 'value',
        required: true,
        hint: 'Lines as in Create a page, or {{ }} with Notion block objects.',
      },
    ],
  },
  {
    id: 'getBlocks',
    label: 'Read content',
    description: 'A page’s blocks, with their plain text.',
    fields: [NOTION_ID('Page'), MAX_FIELD],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Pages and databases shared with the integration, by title.',
    fields: [
      { key: 'query', label: 'Title contains', kind: 'text' },
      {
        key: 'only',
        label: 'Only',
        kind: 'select',
        options: [
          { value: '', label: 'Pages and databases' },
          { value: 'page', label: 'Pages' },
          { value: 'database', label: 'Databases' },
        ],
        initial: '',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under api.notion.com/v1.',
    fields: API_FIELDS.map((f) => (f.key === 'path' ? { ...f, placeholder: '/v1/users' } : f)),
  },
]

const SF_OBJECT: ActionField = {
  key: 'object',
  label: 'Object',
  kind: 'text',
  required: true,
  placeholder: 'Account',
}
const SF_ID: ActionField = { key: 'id', label: 'Record id', kind: 'text', required: true }
const SF_RECORD: ActionField = {
  key: 'record',
  label: 'Fields',
  kind: 'json',
  language: 'json',
  required: true,
  hint: 'A JSON object of field values, e.g. {"Name": "Acme", "Industry": "Retail"}',
}

const SALESFORCE: readonly ActionSpec[] = [
  {
    id: 'query',
    label: 'Query (SOQL)',
    description:
      'A SOQL query; each {{ }} is sent as a quoted, escaped value (put it outside quotes), page after page.',
    fields: [
      {
        key: 'soql',
        label: 'SOQL',
        kind: 'long',
        required: true,
        language: 'plaintext',
        initial: 'SELECT Id, Name FROM Account WHERE Name = {{ name }} LIMIT 100',
      },
      { key: 'all', label: 'Include deleted and archived', kind: 'bool' },
      MAX_FIELD,
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Records containing a term, across objects (Salesforce’s parameterized search).',
    fields: [
      { key: 'term', label: 'Term', kind: 'text', required: true },
      {
        key: 'objects',
        label: 'Objects',
        kind: 'list',
        hint: 'e.g. Account, Contact (empty: all searchable objects).',
      },
      {
        key: 'fieldList',
        label: 'Fields',
        kind: 'list',
        hint: 'Fields to return for each object, e.g. Id, Name.',
      },
      MAX_FIELD,
    ],
  },
  {
    id: 'get',
    label: 'Get a record',
    description: 'One record by its id.',
    fields: [
      SF_OBJECT,
      SF_ID,
      { key: 'fieldList', label: 'Fields', kind: 'list', hint: 'Empty: all fields.' },
    ],
  },
  { id: 'create', label: 'Create a record', description: 'A new record.', fields: [SF_OBJECT, SF_RECORD] },
  {
    id: 'update',
    label: 'Update a record',
    description: 'Changes the fields given.',
    fields: [SF_OBJECT, SF_ID, SF_RECORD],
  },
  {
    id: 'upsert',
    label: 'Upsert a record',
    description: 'Creates or updates the record with this external id.',
    fields: [
      SF_OBJECT,
      {
        key: 'externalIdField',
        label: 'External id field',
        kind: 'text',
        required: true,
        placeholder: 'Optiply_Id__c',
      },
      { key: 'externalId', label: 'External id', kind: 'text', required: true },
      SF_RECORD,
    ],
  },
  {
    id: 'delete',
    label: 'Delete a record',
    description: 'Moves a record to the recycle bin.',
    fields: [SF_OBJECT, SF_ID],
  },
  {
    id: 'describe',
    label: 'Describe an object',
    description: 'An object’s fields, their types and whether they’re required.',
    fields: [SF_OBJECT],
  },
  {
    id: 'api',
    label: 'Call any endpoint',
    description: 'Any path under /services/data.',
    fields: API_FIELDS.map((f) =>
      f.key === 'path' ? { ...f, placeholder: '/services/data/v62.0/limits' } : f,
    ),
  },
]

const RABBITMQ: readonly ActionSpec[] = [
  {
    id: 'publish',
    label: 'Publish',
    description: 'Messages to an exchange, confirmed by the broker; a message no queue takes is an error.',
    fields: [
      {
        key: 'exchange',
        label: 'Exchange',
        kind: 'text',
        hint: 'Empty: the default exchange, where the routing key is a queue.',
      },
      { key: 'routingKey', label: 'Routing key', kind: 'text', placeholder: 'orders' },
      {
        key: 'messages',
        label: 'Messages',
        kind: 'json',
        language: 'json',
        required: true,
        initial: '{"body": {}}',
        hint: 'One message or an array: {"body": …, "headers": {…}, "messageId": "…", "persistent": true, "priority": 0, "expiration": "60000"}. A body that isn’t a string is sent as JSON.',
      },
    ],
  },
]

const SNS: readonly ActionSpec[] = [
  {
    id: 'publish',
    label: 'Publish',
    description: 'Messages to a topic (10 per request); FIFO topics need a group id.',
    fields: [
      {
        key: 'topicArn',
        label: 'Topic ARN',
        kind: 'text',
        required: true,
        placeholder: 'arn:aws:sns:eu-west-1:123456789012:orders',
      },
      {
        key: 'messages',
        label: 'Messages',
        kind: 'json',
        language: 'json',
        required: true,
        initial: '{"message": {}}',
        hint: 'One message or an array: {"message": …, "subject": "…", "attributes": {…}, "groupId": "…", "deduplicationId": "…"}. A message that isn’t a string is sent as JSON.',
      },
    ],
  },
]

const KINESIS: readonly ActionSpec[] = [
  {
    id: 'putRecords',
    label: 'Put records',
    description:
      'Records into a stream (500 per request); a record without a partition key gets a random one.',
    fields: [
      { key: 'stream', label: 'Stream', kind: 'text', required: true, placeholder: 'orders, or its ARN' },
      {
        key: 'records',
        label: 'Records',
        kind: 'json',
        language: 'json',
        required: true,
        initial: '{"data": {}, "partitionKey": ""}',
        hint: 'One record or an array: {"data": …, "partitionKey": "…", "explicitHashKey": "…"}. Data that isn’t a string is sent as JSON; records with one key stay in order.',
      },
    ],
  },
]

// AI (M35, docs/architecture.md §2.38): the same actions for both providers. Every answer's usage, model and cost
// are the query's metadata; its data is the answer (text, the extracted JSON, the label).
const AI_MODEL: ActionField = {
  key: 'model',
  label: 'Model',
  kind: 'text',
  hint: "Empty: the resource's default model.",
}
const AI_MAX_TOKENS: ActionField = {
  key: 'maxTokens',
  label: 'Max tokens',
  kind: 'number',
  placeholder: '16000',
  hint: 'The most the answer may take, thinking included (Anthropic). The run’s budget is the resource’s.',
}
const AI_EFFORT: ActionField = {
  key: 'effort',
  label: 'Effort',
  kind: 'select',
  options: [
    { value: '', label: "The model's default" },
    { value: 'low', label: 'Low (fast, cheap)' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High (thorough)' },
  ],
  initial: '',
  hint: 'Anthropic: how much the model thinks. Ignored by OpenAI-compatible providers.',
}

export const AI_ACTIONS: readonly ActionSpec[] = [
  {
    id: 'generate',
    label: 'Generate text',
    description: 'Answers a prompt with text.',
    fields: [
      {
        key: 'system',
        label: 'System prompt',
        kind: 'long',
        language: 'plaintext',
        hint: 'Who the model is, how to answer.',
      },
      { key: 'prompt', label: 'Prompt', kind: 'long', language: 'plaintext', required: true },
      AI_MODEL,
      AI_EFFORT,
      AI_MAX_TOKENS,
    ],
  },
  {
    id: 'summarize',
    label: 'Summarize',
    description: 'Summarizes a text: short, medium or long, as prose or bullets.',
    fields: [
      { key: 'input', label: 'Text', kind: 'long', language: 'plaintext', required: true },
      {
        key: 'length',
        label: 'Length',
        kind: 'select',
        options: [
          { value: 'short', label: 'Short (a sentence or two)' },
          { value: 'medium', label: 'Medium (a paragraph)' },
          { value: 'long', label: 'Long (several paragraphs)' },
        ],
        initial: 'medium',
      },
      {
        key: 'style',
        label: 'Style',
        kind: 'select',
        options: [
          { value: 'prose', label: 'Prose' },
          { value: 'bullets', label: 'Bullet points' },
        ],
        initial: 'prose',
      },
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'long',
        language: 'plaintext',
        hint: 'What to focus on (optional).',
      },
      AI_MODEL,
      AI_EFFORT,
      AI_MAX_TOKENS,
    ],
  },
  {
    id: 'extract',
    label: 'Extract JSON',
    description: 'Reads a text into JSON matching a schema (the answer is checked against it).',
    fields: [
      { key: 'input', label: 'Text', kind: 'long', language: 'plaintext', required: true },
      {
        key: 'schema',
        label: 'JSON Schema',
        kind: 'json',
        language: 'json',
        required: true,
        hint: 'An object schema: the properties to fill (required ones, and `additionalProperties: false`, recommended).',
        initial:
          '{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" }\n  },\n  "required": ["name"],\n  "additionalProperties": false\n}',
      },
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'long',
        language: 'plaintext',
        hint: 'How to read the text (optional).',
      },
      AI_MODEL,
      AI_EFFORT,
      AI_MAX_TOKENS,
    ],
  },
  {
    id: 'classify',
    label: 'Classify',
    description: 'Picks one label (or several) for a text, with the reason.',
    fields: [
      { key: 'input', label: 'Text', kind: 'long', language: 'plaintext', required: true },
      {
        key: 'labels',
        label: 'Labels',
        kind: 'list',
        required: true,
        placeholder: 'complaint, question, order',
      },
      {
        key: 'multiple',
        label: 'Several labels',
        kind: 'bool',
        hint: 'Every label that applies, instead of the best one.',
      },
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'long',
        language: 'plaintext',
        hint: 'What each label means (optional).',
      },
      AI_MODEL,
      AI_EFFORT,
      AI_MAX_TOKENS,
    ],
  },
  {
    id: 'agent',
    label: 'Agent (workflows as tools)',
    description:
      'Works on a task, calling the workflows it’s given as tools, until it answers. Workflows only.',
    fields: [
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'long',
        language: 'plaintext',
        hint: 'The agent’s role and rules.',
      },
      { key: 'prompt', label: 'Task', kind: 'long', language: 'plaintext', required: true },
      {
        key: 'tools',
        label: 'Workflows it may call',
        kind: 'list',
        required: true,
        placeholder: 'lookup-customer, create-ticket',
      },
      {
        key: 'maxSteps',
        label: 'Max steps',
        kind: 'number',
        placeholder: '10',
        hint: 'Model turns at most (up to 50).',
      },
      AI_MODEL,
      AI_EFFORT,
      AI_MAX_TOKENS,
    ],
  },
]

export const SERVICE_ACTIONS: Readonly<Record<ServiceType, readonly ActionSpec[]>> = {
  slack: SLACK,
  anthropic: AI_ACTIONS,
  openai_compatible: AI_ACTIONS,
  hubspot: HUBSPOT,
  sendgrid: SENDGRID,
  googlesheets: GOOGLE_SHEETS,
  s3: S3,
  stripe: STRIPE,
  airtable: AIRTABLE,
  jira: JIRA,
  notion: NOTION,
  salesforce: SALESFORCE,
  rabbitmq: RABBITMQ,
  sns: SNS,
  kinesis: KINESIS,
}

export function actionSpec(type: ServiceType, action: string): ActionSpec | undefined {
  return SERVICE_ACTIONS[type].find((a) => a.id === action)
}

/** A new query for an action: its fields' starting values. */
export function defaultActionQuery(
  type: ServiceType,
  action = SERVICE_ACTIONS[type][0]!.id,
): Record<string, string> {
  const spec = actionSpec(type, action)
  const query: Record<string, string> = { action }
  for (const field of spec?.fields ?? []) query[field.key] = field.initial ?? ''
  return query
}

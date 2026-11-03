// Pure data with no Node imports, so the web app's query forms can use it (`@ow/connectors/actions`).
//
// The service connectors' actions (M27, M29): Slack, HubSpot, SendGrid, Google Sheets, S3, … A query is `{action, ...fields}`
// where every field is a string: a template, rendered by its kind when the query runs.

export const SERVICE_TYPES = ['slack', 'hubspot', 'sendgrid', 'googlesheets', 's3'] as const
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

export const SERVICE_ACTIONS: Readonly<Record<ServiceType, readonly ActionSpec[]>> = {
  slack: SLACK,
  hubspot: HUBSPOT,
  sendgrid: SENDGRID,
  googlesheets: GOOGLE_SHEETS,
  s3: S3,
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

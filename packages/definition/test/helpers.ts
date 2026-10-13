/** A definition from blocks and `[from, to, port?]` edges; the port defaults to `out`. */
export function wf(blocks: object[], edges: [string, string, string?][] = [], extra: object = {}) {
  return {
    schemaVersion: 1,
    blocks,
    edges: edges.map(([from, to, port = 'out']) => ({ from, port, to })),
    ...extra,
  }
}

export const start = { name: 'startTrigger', type: 'startTrigger' }

export const code = (name: string, src = 'return 1', settings?: object) => ({
  name,
  type: 'code',
  config: { code: src },
  ...(settings && { settings }),
})

export const sql = (name: string, text: string, resource = 'warehouse') => ({
  name,
  type: 'resourceQuery',
  config: { resource, query: { sql: text } },
})

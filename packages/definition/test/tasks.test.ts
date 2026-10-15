import { describe, expect, it } from 'vitest'
import {
  checkTaskSubmission,
  type OpenTaskField,
  suspends,
  taskOutcomes,
  validateDefinition,
  workflowDefinitionSchema,
} from '../src'
import { code, start, wf } from './helpers'

const task = (config: object, extra: object = {}) => ({
  name: 'approval',
  type: 'userTask',
  config: { title: 'Approve the refund', assignees: { groups: ['Finance'] }, ...config },
  ...extra,
})
const diagnostics = (blocks: object[], edges: [string, string, string?][], extra?: object) =>
  validateDefinition(wf(blocks, edges, extra)).diagnostics
const flow = (t: object) => diagnostics([start, t], [['startTrigger', 'approval']])

describe('the User Task block', () => {
  it('parses a full task, and waits like a Wait', () => {
    const def = workflowDefinitionSchema.parse(
      wf(
        [
          start,
          task(
            {
              title: 'Refund {{ startTrigger.data.amount }} to {{ startTrigger.data.customer }}?',
              description: 'Ordered on {{ startTrigger.data.date }}',
              assignees: {
                users: ['{{ startTrigger.data.owner }}', 'finance@optiply.nl'],
                groups: ['Finance'],
              },
              fields: [
                { name: 'reason', label: 'Reason', type: 'longText', required: true },
                {
                  name: 'amount',
                  label: 'Amount',
                  type: 'number',
                  default: '{{ startTrigger.data.amount }}',
                },
                { name: 'notify', label: 'Tell the customer', type: 'checkbox', default: 'true' },
                { name: 'channel', label: 'Channel', type: 'select', options: ['email', 'phone'] },
              ],
              outcomes: [
                { id: 'approve', label: 'Approve' },
                { id: 'reject', label: 'Reject' },
              ],
              due: { amount: '2', unit: 'days' },
            },
            { settings: { finally: 'continue' } },
          ),
          code('after', 'return approval.data.outcome'),
        ],
        [
          ['startTrigger', 'approval'],
          ['approval', 'after'],
        ],
      ),
    )
    const block = def.blocks[1]!
    expect(suspends(block)).toBe(true)
    expect(validateDefinition(def).diagnostics).toEqual([])
    // Only `finally`: nothing to retry or time out.
    expect(() =>
      workflowDefinitionSchema.parse(wf([start, task({}, { settings: { timeoutMs: 1000 } })])),
    ).toThrow()
  })

  it('needs a title and someone to do it', () => {
    expect(flow(task({ title: '  ' }))).toMatchObject([
      { code: 'invalid_task', message: 'Give the task a title', path: ['blocks', 1, 'config', 'title'] },
    ])
    expect(flow(task({ assignees: { users: [' '], groups: [] } }))).toMatchObject([
      { code: 'invalid_task', message: 'Assign the task to at least one user or group' },
    ])
    expect(flow(task({ assignees: { users: ['finance'] } }))).toMatchObject([
      {
        code: 'invalid_task',
        message: '"finance" isn\'t an email address',
        path: ['blocks', 1, 'config', 'assignees', 'users', 0],
      },
    ])
  })

  it('checks fields, outcomes and the due time', () => {
    const problems = flow(
      task({
        fields: [
          { name: 'a', label: 'A', type: 'text' },
          { name: 'a', label: '', type: 'select', options: [] },
        ],
        outcomes: [
          { id: 'ok', label: 'OK' },
          { id: 'ok', label: '' },
        ],
        due: { amount: '90', unit: 'days' },
      }),
    ).map((d) => d.message)
    expect(problems).toEqual([
      'Two fields are named "a"',
      'Give the field a label',
      'A choice needs at least one option',
      'Two outcomes have the id "ok"',
      'Give the button a label',
      'A task can be due at most 60 days out',
    ])
    expect(flow(task({ due: { amount: 'soon', unit: 'hours' } })).map((d) => d.message)).toEqual([
      '"soon" isn\'t a number of hours',
    ])
  })

  it('checks what its templates read', () => {
    expect(
      flow(task({ title: 'For {{ nobody.data }}', assignees: { users: ['{{ startTrigger.data.owner }}'] } })),
    ).toMatchObject([{ code: 'unknown_identifier', message: '"nobody" is not defined' }])
  })

  it("can't be in a function or the error handler", () => {
    const inFunction = diagnostics([start], [], {
      functions: [{ name: 'ask', blocks: [task({})], edges: [] }],
    })
    expect(inFunction.map((d) => d.message)).toContain(
      "A function can't wait for a person: function calls aren't checkpointed",
    )
    const inHandler = diagnostics(
      [start, code('work'), { name: 'onFailure', type: 'errorTrigger' }, task({})],
      [
        ['startTrigger', 'work'],
        ['onFailure', 'approval'],
      ],
    )
    expect(inHandler).toMatchObject([{ code: 'task_in_handler', path: ['blocks', 3] }])
  })
})

describe('checkTaskSubmission', () => {
  const fields: OpenTaskField[] = [
    { name: 'reason', label: 'Reason', type: 'text', required: true },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'notify', label: 'Notify', type: 'checkbox' },
    { name: 'channel', label: 'Channel', type: 'select', options: ['email', 'phone'] },
  ]
  const outcomes = [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ]

  it('types the values and fills in the empty ones', () => {
    expect(
      checkTaskSubmission(fields, outcomes, 'approve', { reason: 'Late', amount: '12.5', channel: 'email' }),
    ).toEqual({
      ok: true,
      outcome: 'approve',
      values: { reason: 'Late', amount: 12.5, notify: false, channel: 'email' },
    })
    expect(
      checkTaskSubmission(fields, outcomes, 'reject', { reason: 'No', amount: '', notify: true }),
    ).toEqual({
      ok: true,
      outcome: 'reject',
      values: { reason: 'No', amount: null, notify: true, channel: null },
    })
  })

  it('reports every problem, by field', () => {
    const result = checkTaskSubmission(fields, outcomes, 'maybe', {
      reason: '  ',
      amount: 'lots',
      notify: 'yes',
      channel: 'fax',
      extra: 1,
    })
    expect(result).toEqual({
      ok: false,
      errors: [
        { message: '"maybe" isn\'t one of this task\'s outcomes' },
        { field: 'extra', message: 'This task has no field "extra"' },
        { field: 'reason', message: 'Reason is required' },
        { field: 'amount', message: 'Amount must be a number' },
        { field: 'notify', message: 'Notify must be yes or no' },
        { field: 'channel', message: 'Choose one of the options for Channel' },
      ],
    })
  })

  it('has a single Submit outcome by default', () => {
    expect(taskOutcomes(undefined)).toEqual([{ id: 'submit', label: 'Submit' }])
    expect(checkTaskSubmission([], undefined, 'submit', {})).toEqual({
      ok: true,
      outcome: 'submit',
      values: {},
    })
    expect(checkTaskSubmission([], undefined, 'approve', {}).ok).toBe(false)
  })
})

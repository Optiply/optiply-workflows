/** JavaScript packages in Git: `package.json` beside `workflow.json` and `app.json`. */
import { type AppDefinition, canonicalizeApp } from '@ow/app-definition'
import { workflowDefinitionSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import {
  APP_FILE,
  decodeApp,
  decodeModule,
  decodeWorkflow,
  encodeApp,
  encodeModule,
  encodeWorkflow,
  PACKAGE_FILE,
  REQUIREMENTS_FILE,
  WORKFLOW_FILE,
  type WorkflowObject,
  workflowForGit,
} from '../src'

const workflow = (settings: object): WorkflowObject => ({
  name: 'Packages',
  description: null,
  definition: workflowDefinitionSchema.parse({
    schemaVersion: 1,
    settings,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
    edges: [],
  }),
})

const app = (javascript?: AppDefinition['javascript']) => ({
  name: 'Orders',
  description: null,
  definition: {
    schemaVersion: 1,
    components: [],
    queries: [],
    ...(javascript && { javascript }),
  } as AppDefinition,
})

describe('a workflow’s JavaScript packages', () => {
  it('go into package.json as npm dependencies, in their order, out of the JSON, and read back', () => {
    const wf = workflow({
      timeoutMs: 60_000,
      javascript: { packages: ['zod@^3', 'date-fns', '@acme/utils@1.2.0', 'any@*'] },
    })
    const { files, warnings } = encodeWorkflow(wf)
    expect(warnings).toEqual([])
    expect(JSON.parse(files[PACKAGE_FILE]!)).toEqual({
      private: true,
      dependencies: { zod: '^3', 'date-fns': '', '@acme/utils': '1.2.0', any: '*' },
    })
    expect(Object.keys(JSON.parse(files[PACKAGE_FILE]!).dependencies)).toEqual([
      'zod',
      'date-fns',
      '@acme/utils',
      'any',
    ])
    expect(files[WORKFLOW_FILE]).not.toContain('zod')
    expect(JSON.parse(files[WORKFLOW_FILE]!).settings).toEqual({ timeoutMs: 60_000 })
    const decoded = decodeWorkflow(files)
    expect(decoded.ok && decoded.value.definition).toEqual(workflowForGit(wf.definition))
  })

  it('sit beside Python’s, keep an empty list, and leave no file without the setting', () => {
    const both = encodeWorkflow(
      workflow({ python: { requirements: ['polars'] }, javascript: { packages: ['zod'] } }),
    ).files
    expect(both).toHaveProperty(REQUIREMENTS_FILE)
    expect(JSON.parse(both[WORKFLOW_FILE]!)).not.toHaveProperty('settings')
    const decoded = decodeWorkflow(both)
    expect(decoded.ok && decoded.value.definition.settings).toEqual({
      python: { requirements: ['polars'] },
      javascript: { packages: ['zod'] },
    })
    const empty = encodeWorkflow(workflow({ javascript: { packages: [] } })).files
    const back = decodeWorkflow(empty)
    expect(back.ok && back.value.definition.settings).toEqual({ javascript: { packages: [] } })
    expect(encodeWorkflow(workflow({})).files).not.toHaveProperty(PACKAGE_FILE)
  })

  it('reads a file edited by hand or by npm: other fields ignored, lines for the validator', () => {
    const { files } = encodeWorkflow(workflow({}))
    const decoded = decodeWorkflow({
      ...files,
      [PACKAGE_FILE]: JSON.stringify({
        name: 'x',
        version: '1.0.0',
        dependencies: { lodash: ' ^4.17 ', 'user/repo': '' },
        devDependencies: { vitest: '^5' },
      }),
    })
    expect(decoded.ok && decoded.value.definition.settings).toEqual({
      javascript: { packages: ['lodash@^4.17', 'user/repo'] },
    })
    // Without `dependencies`: the setting, empty.
    const bare = decodeWorkflow({ ...files, [PACKAGE_FILE]: '{"private": true}' })
    expect(bare.ok && bare.value.definition.settings).toEqual({ javascript: { packages: [] } })
  })

  it('says what is wrong with the file, and with packages in both places', () => {
    const { files } = encodeWorkflow(workflow({}))
    const problems = (content: string, extra: object = {}) => {
      const decoded = decodeWorkflow({ ...files, ...extra, [PACKAGE_FILE]: content })
      return decoded.ok ? [] : decoded.problems.map((p) => [p.path, p.message])
    }
    expect(problems('{ nope')[0]?.[0]).toBe(PACKAGE_FILE)
    expect(problems('[]')).toEqual([[PACKAGE_FILE, 'package.json: Expected an object']])
    expect(problems('{"dependencies": ["zod"]}')).toEqual([
      [PACKAGE_FILE, 'package.json: dependencies: expected an object'],
    ])
    expect(problems('{"dependencies": {"zod": 3}}')).toEqual([
      [PACKAGE_FILE, 'package.json: dependencies.zod: expected a version range (a string)'],
    ])
    const json = JSON.parse(files[WORKFLOW_FILE]!)
    expect(
      problems('{}', {
        [WORKFLOW_FILE]: JSON.stringify({ ...json, settings: { javascript: { packages: [] } } }),
      }),
    ).toEqual([[WORKFLOW_FILE, 'workflow.json: settings.javascript: the packages belong in package.json']])
  })

  it('keeps the first of a name listed twice, with a warning', () => {
    const { files, warnings } = encodeWorkflow(workflow({ javascript: { packages: ['zod@^3', 'zod@^4'] } }))
    expect(JSON.parse(files[PACKAGE_FILE]!).dependencies).toEqual({ zod: '^3' })
    expect(warnings).toEqual([
      { path: PACKAGE_FILE, message: '"zod" is listed twice: package.json keeps the first' },
    ])
  })
})

describe('an app’s JavaScript packages', () => {
  it('go into package.json, out of app.json, and read back', () => {
    const { files } = encodeApp(app({ packages: ['zod@^3', 'date-fns'] }))
    expect(JSON.parse(files[PACKAGE_FILE]!).dependencies).toEqual({ zod: '^3', 'date-fns': '' })
    expect(JSON.parse(files[APP_FILE]!)).not.toHaveProperty('javascript')
    const decoded = decodeApp(files)
    expect(decoded.ok && decoded.value.definition).toEqual(
      canonicalizeApp(app({ packages: ['zod@^3', 'date-fns'] }).definition),
    )
    expect(encodeApp(app()).files).not.toHaveProperty(PACKAGE_FILE)
  })

  it('refuses packages in app.json when package.json has them', () => {
    const { files } = encodeApp(app({ packages: ['zod'] }))
    const decoded = decodeApp({
      ...files,
      [APP_FILE]: JSON.stringify({ ...JSON.parse(files[APP_FILE]!), javascript: { packages: [] } }),
    })
    expect(decoded.ok ? [] : decoded.problems.map((p) => p.message)).toEqual([
      'app.json: javascript: the packages belong in package.json',
    ])
  })

  it('round-trips on a module too (the validator, not Git, refuses them there)', () => {
    const mod = app({ packages: ['zod'] })
    mod.definition.module = { inputs: [], outputs: [], events: [] }
    const decoded = decodeModule(encodeModule(mod).files)
    expect(decoded.ok && decoded.value.definition.javascript).toEqual({ packages: ['zod'] })
  })
})

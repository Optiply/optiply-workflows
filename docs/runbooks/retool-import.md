# Runbook: importing from Retool

Retool apps and workflows can be imported here from their JSON exports. Each becomes a draft built like the original:
check it, map what it needs, publish. The design is `docs/architecture.md` §2.40; this page is for doing it.

## Exporting from Retool

- **A workflow:** open it in Retool, then the workflow's menu → **Export to JSON**.
- **An app:** open it in Retool, then the app's menu (⋯ beside the app's name) → **Export to JSON**.

Exports can hold secrets (a token typed into a query's header, an example webhook body). Keep them out of Git and
chat. The import never keeps the file, only a report of what it did.

## Importing

1. **Workflows first.** In **Build → Workflows**, press **Import** and choose (or drop) the exports. An app that runs
   Retool workflows needs them imported first, so you can link them.
2. **Read each row.** It says whether the file makes a **new** workflow or **updates** one imported before (a new
   draft; the history keeps the old one). Tick **Make a copy instead** to keep the old one as it is. Open the row
   for the details: notes, config vars to set, problems to fix before publishing, and every part that isn't as it
   was in Retool.
3. **Map the resources.** For each Retool resource, pick the resource here that is the same database or API. What
   you pick is remembered for the next import, and resources with the same name are suggested. Left unpicked, the
   queries use a placeholder (`retool_<name>`) that you change in the editor.
4. **Pick a folder** for new ones, and press **Import**. Each result links to its editor.
5. **Apps** go the same way from **Build → Apps**, with one more step: for each Retool workflow the app runs
   (Retool names them by id only), pick the workflow here.

In an editor, **Imported from Retool** in the status bar opens the import's report again.

## After importing

- **Config vars to set.** A secret written into the export (an `Authorization` header, an `api_key`) was replaced by
  `{{ configVars.RETOOL_SECRET_n }}`. Create those config vars in **Settings → Config vars**, as secrets, with the
  values from Retool. The same secret in several places shares one.
- **Problems.** Validator errors left after the import are in the report and the editor's Problems panel. They are
  usually things missing in Retool too (a component or query that was deleted, code that never worked).
- **Skipped blocks.** Workflow blocks nothing leads to never ran in Retool, so they aren't imported. One exception: a
  loop or filter nothing leads to runs in Retool after the block it goes through, so it's connected after that block
  here (and noted). If a skipped block should run, add it in the editor.
- **Approximated parts.** Some Retool parts have a close equivalent, not the same thing: an editable text is a text
  input, a link is a secondary button, a chart keeps its type and data but not its Plotly settings, a table's
  toolbar buttons and row actions aren't imported. The report lists each one with what to check.
- **Publish** when it works. Publishing checks every resource and workflow it uses, as for anything built here.

## What carries over

| Retool | Here |
|---|---|
| Workflow blocks: start, code, SQL/REST/OpenAPI/GraphQL queries, branch, filter, loop, response | The same blocks, with edges, retries, timeouts, positions |
| Workflow functions (multi-block or one query) | Workflow functions; parameters read as `params.x` |
| Setup script loading lodash, moment, numbro, Papa, uuid | Nothing: they're built in |
| Other workflow libraries | JavaScript packages, imported where used |
| App components (44 kinds seen) | Ours; stacks and grids laid out on our grid, containers with views and tabs, modals, forms |
| Text (Markdown) | Text with **Markdown** on |
| Queries (SQL, REST, OpenAPI, GraphQL, JS), State, Functions | Queries, variables, transformers |
| Retool's `WorkflowRun` query | A **Run workflow** query |
| Event handlers | Event handlers (scripts, queries, component methods, utils, local storage) |
| Retool's SQL data by column (`q.data.id[0]`) | Rewritten for ours by row (`q.data.map((r) => r.id)[0]`) |

## Adding support for a Retool part

The converters are registries in `packages/retool-import/src`: workflow blocks in `workflow/convert.ts` (`BLOCKS`),
queries in `workflow/queries.ts`, app components in `app/widgets.ts` (`WIDGETS`), event names and actions in
`app/events.ts`, renamed members in `app/compat.ts`. Supporting a new kind is one entry plus a fixture in the
package's tests (`test/fixtures.ts` writes exports the way Retool does). To see what real exports contain:

```sh
RETOOL_EXPORTS_DIR=~/path/to/exports corepack pnpm --filter @ow/retool-import exec vitest run test/local-exports.test.ts --silent=false
```

It prints counts only, never names or values.

## Troubleshooting

- **"This is a Retool app: import it from Apps"** (or the other way round): each list imports its own kind.
- **"This isn't a Retool app or workflow export":** the file isn't one (a Retool module, a Toolscript `.rsx`
  source file, or something else). Modules and Toolscript aren't supported yet.
- **"You can't use a resource …":** you can only map to resources you have Use on in some environment.
- **An app's Run workflow query fails "isn't published":** publish the workflow it runs (or pick another in the
  query).

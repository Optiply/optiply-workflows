/**
 * Reads real Retool exports from a folder on this machine, never committed:
 *   RETOOL_EXPORTS_DIR=~/Desktop/retool_exports pnpm --filter @ow/retool-import test
 * Skipped when the variable isn't set. It prints counts only (kinds and numbers), never names or values: exports
 * can hold customer data and secrets.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertWorkflow, readRetoolExport } from '../src'

const dir = process.env.RETOOL_EXPORTS_DIR?.replace(/^~(?=\/)/, process.env.HOME ?? '~')

function jsonFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return jsonFiles(path)
    return name.toLowerCase().endsWith('.json') ? [path] : []
  })
}

describe.skipIf(!dir)('real exports (RETOOL_EXPORTS_DIR)', () => {
  it('reads every export in the folder', () => {
    const files = jsonFiles(dir!)
    expect(files.length).toBeGreaterThan(0)
    const kinds = new Map<string, number>()
    const count = (key: string) => kinds.set(key, (kinds.get(key) ?? 0) + 1)
    const lines: string[] = []
    files.forEach((file, i) => {
      const read = readRetoolExport(readFileSync(file, 'utf8'), { fileName: file })
      if (read.kind === 'app') {
        for (const p of read.plugins) count(`app ${p.type}/${p.subtype}`)
        const placed = read.plugins.filter((p) => p.position).length
        lines.push(`#${i + 1} app: ${read.plugins.length} parts, ${placed} on the grid`)
      } else {
        const blocks = [...read.blocks, ...read.functions.flatMap((f) => f.blocks)]
        for (const b of blocks)
          count(`workflow block ${b.blockType}${b.editorType ? ` (${b.editorType})` : ''}`)
        const withPlugin = blocks.filter((b) => b.plugin).length
        lines.push(
          `#${i + 1} workflow: ${read.blocks.length} blocks, ${read.functions.length} functions, ` +
            `${blocks.length - withPlugin} blocks without a template, ${read.webhooks.length} webhooks`,
        )
        const { report } = convertWorkflow(read)
        const c = report.counts
        const codes = [...new Set(report.diagnostics.map((d) => d.code))]
        lines.push(
          `   converted ${c.converted}, approximated ${c.approximated}, unsupported ${c.unsupported}, skipped ${c.skipped}; ` +
            `resources ${report.resources.length} (${report.resources.filter((r) => !r.mapped).length} to map); ` +
            `secrets ${report.secrets.length}; diagnostics ${report.diagnostics.length}${codes.length ? ` (${codes.join(', ')})` : ''}`,
        )
        for (const e of report.entries.filter((x) => x.status !== 'converted')) {
          lines.push(
            `   - ${e.status} ${e.kind} → ${e.became}: ${e.notes.map((n) => n.replace(/\(.*\)/, '(…)')).join('; ')}`,
          )
        }
      }
    })
    const table = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(4)} ${k}`)
    console.log([`${files.length} exports`, ...lines, 'kinds:', ...table].join('\n'))
  })
})

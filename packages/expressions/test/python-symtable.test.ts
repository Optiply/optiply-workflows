/**
 * The tokenizer against Python itself: for each snippet in the corpus, the names Python's symtable says the code
 * reads from outside (the code wrapped in a function as the executor runs it, builtins aside) must be exactly the
 * references `analyzePython` finds. Needs Python 3.12 or newer (CI's runner has it); skipped without.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { analyzePython } from '../src/python'
import { CORPUS } from './python-corpus'

const TRUTH = `
import ast, builtins, json, sys, symtable
B = set(dir(builtins))
def wrap(code):
    tree = ast.parse(code)
    fn = ast.FunctionDef(name='__ow_main', args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
                         body=tree.body or [ast.Pass()], decorator_list=[], type_params=[], lineno=1, col_offset=0)
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    return ast.unparse(module)
def free(table, out):
    for sym in table.get_symbols():
        if sym.is_referenced() and (sym.is_global() or sym.is_declared_global()) and sym.get_name() not in B:
            out.add(sym.get_name())
    for child in table.get_children():
        free(child, out)
result = []
for code in json.load(sys.stdin):
    out = set()
    for child in symtable.symtable(wrap(code), '<code>', 'exec').get_children():
        free(child, out)
    result.append(sorted(out))
print(json.dumps(result))
`

function python(): string | null {
  for (const bin of ['python3.12', 'python3']) {
    try {
      const version = execFileSync(bin, [
        '-c',
        'import sys; print(sys.version_info[:2] >= (3, 12))',
      ]).toString()
      if (version.trim() === 'True') return bin
    } catch {}
  }
  return null
}

const bin = python()

describe.skipIf(!bin)("analyzePython against Python's symtable", () => {
  it('finds exactly the names Python says each snippet reads', () => {
    const truth: string[][] = JSON.parse(
      execFileSync(bin!, ['-c', TRUTH], { input: JSON.stringify(CORPUS) }).toString(),
    )
    const found = CORPUS.map((code) => [...new Set(analyzePython(code).refs.map((r) => r.name))].sort())
    for (const [i, code] of CORPUS.entries()) expect(found[i], code).toEqual(truth[i])
  })
})

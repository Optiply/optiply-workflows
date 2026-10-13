import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { generatedPath, renderGeneratedStdlib } from '../scripts/bundle-stdlib'

it('the committed stdlib bundle is up to date (run `pnpm --filter @ow/sandbox bundle:stdlib`)', () => {
  expect(readFileSync(generatedPath, 'utf8') === renderGeneratedStdlib()).toBe(true)
})

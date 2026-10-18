import { blockClipSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import { MAX_CLIP_LENGTH, readClip } from './clipboard'

const clip = {
  ow: 'workflow-blocks',
  v: 1,
  blocks: [{ name: 'code1', type: 'code', config: { code: 'return 1' } }],
  edges: [],
  positions: {},
  functions: [],
}

describe('readClip', () => {
  it('reads blocks of its kind', () => {
    const read = readClip(JSON.stringify(clip), 'workflow-blocks', blockClipSchema)
    expect(read).toMatchObject({ ok: true, clip: { blocks: [{ name: 'code1' }] } })
  })

  it("leaves what isn't editor content to the browser", () => {
    expect(readClip('select 1', 'workflow-blocks', blockClipSchema)).toBeNull()
    expect(readClip('{not json', 'workflow-blocks', blockClipSchema)).toBeNull()
    expect(
      readClip(JSON.stringify({ ...clip, ow: 'app-components' }), 'workflow-blocks', blockClipSchema),
    ).toBeNull()
    expect(
      readClip(
        `{"ow":"workflow-blocks","pad":"${'x'.repeat(MAX_CLIP_LENGTH)}"}`,
        'workflow-blocks',
        blockClipSchema,
      ),
    ).toBeNull()
  })

  it('says so when it claims to be blocks but isn’t', () => {
    const bad = { ...clip, blocks: [{ name: 'code1', type: 'code', config: { code: 1 } }] }
    expect(readClip(JSON.stringify(bad), 'workflow-blocks', blockClipSchema)).toMatchObject({ ok: false })
  })
})

import { describe, expect, it } from 'vitest'
import { newChangeRequestUrl } from './git-links'

describe('newChangeRequestUrl (M31 review)', () => {
  it('opens GitHub’s compare view, or GitLab’s new merge request with both branches', () => {
    expect(
      newChangeRequestUrl(
        { webUrl: 'https://github.com/optiply/flows', branch: 'main', host: 'github' },
        'protect/a',
      ),
    ).toBe('https://github.com/optiply/flows/compare/main...protect/a')
    expect(
      newChangeRequestUrl(
        { webUrl: 'https://gitlab.com/optiply/data/flows', branch: 'main', host: 'gitlab' },
        'protect/a',
      ),
    ).toBe(
      'https://gitlab.com/optiply/data/flows/-/merge_requests/new?merge_request%5Bsource_branch%5D=protect%2Fa&merge_request%5Btarget_branch%5D=main',
    )
    expect(newChangeRequestUrl({ webUrl: null, branch: 'main', host: 'github' }, 'x')).toBeNull()
  })
})

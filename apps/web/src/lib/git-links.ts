/** The repo as `git.info` tells it: its web address, deploy branch and host. */
export interface GitLinkInfo {
  webUrl: string | null
  branch: string | null
  host: 'github' | 'gitlab'
}

/**
 * The host's page for opening a request from `branch` into the deploy branch by hand (when the instance couldn't):
 * GitHub's compare view, or GitLab's new merge request with both branches filled in (M31). Null without a web address.
 */
export function newChangeRequestUrl(git: GitLinkInfo, branch: string): string | null {
  if (!git.webUrl || !git.branch) return null
  if (git.host === 'gitlab') {
    const query = new URLSearchParams({
      'merge_request[source_branch]': branch,
      'merge_request[target_branch]': git.branch,
    })
    return `${git.webUrl}/-/merge_requests/new?${query}`
  }
  return `${git.webUrl}/compare/${encodeURI(git.branch)}...${encodeURI(branch)}`
}

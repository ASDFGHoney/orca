import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
/**
 * Mark or unmark a PR file as viewed via GitHub's GraphQL API.
 */
export async function setPRFileViewed(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  prRepo?: GitHubApiRepository | null
  pullRequestId: string
  path: string
  viewed: boolean
}): Promise<boolean> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    args.repoPath,
    args.prRepo,
    args.connectionId,
    args.localGitOptions
  )
  if (!ownerRepo) {
    return false
  }
  const mutation = args.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const query = `mutation($pullRequestId: ID!, $path: String!) {
    ${mutation}(input: { pullRequestId: $pullRequestId, path: $path }) {
      pullRequest { id }
    }
  }`
  await acquire()
  try {
    await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `pullRequestId=${args.pullRequestId}`,
        '-f',
        `path=${args.path}`
      ],
      ghOptions
    )
    return true
  } catch (err) {
    console.warn(`${mutation} failed:`, err)
    return false
  } finally {
    release()
  }
}

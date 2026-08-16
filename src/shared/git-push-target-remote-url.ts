function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const scpMatch = url.trim().match(/^git@(github\.com|ssh\.github\.com):([^/]+)\/([^/]+)$/i)
  if (scpMatch) {
    return { owner: scpMatch[2]!, repo: scpMatch[3]!.replace(/\.git$/i, '') }
  }
  try {
    const parsed = new URL(url.trim())
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(parsed.protocol.toLowerCase())) {
      return null
    }
    const protocol = parsed.protocol.toLowerCase()
    const host = (
      protocol === 'http:' || protocol === 'https:' ? parsed.host : parsed.hostname
    ).toLowerCase()
    if (host !== 'github.com' && host !== 'ssh.github.com') {
      return null
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return null
    }
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

export function sameGitHubRemoteUrl(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const parsedLeft = parseGitHubRemoteUrl(left)
  const parsedRight = parseGitHubRemoteUrl(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.owner.toLowerCase() === parsedRight.owner.toLowerCase() &&
    parsedLeft.repo.toLowerCase() === parsedRight.repo.toLowerCase()
  )
}

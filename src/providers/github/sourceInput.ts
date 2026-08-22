/**
 * GitHub's onboarding source-input grammar. Nothing like GitLab's: no `/-/`
 * separator, no numeric project ids, and organizations are named, not numbered.
 * Pure string parsing — visibility lookups are the connection's job.
 *
 * | Input                                   | Result                    |
 * | --------------------------------------- | ------------------------- |
 * | `https://github.com/acme/core`          | repo `acme/core`          |
 * | `https://github.com/acme/core/pull/12`  | repo `acme/core`          |
 * | `acme/core`                             | repo `acme/core`          |
 * | `https://github.com/orgs/acme`          | org `acme`                |
 * | `acme`                                  | org candidate `acme`      |
 * | anything else                           | invalid — never added     |
 */
export type GitHubSourceInput =
  | { shape: 'repo'; owner: string; repo: string }
  | { shape: 'org'; org: string }
  /** A bare name: an organization if the token can see one, otherwise no match. */
  | { shape: 'orgCandidate'; org: string }
  | { shape: 'invalid' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stripRepoSuffix(segments: readonly string[]): string[] {
  // `/pull/12`, `/tree/main/src`, `/blob/...`, `/issues/4` all hang off the repo.
  return segments.slice(0, 2);
}

export function parseGitHubSourceInput(raw: string): GitHubSourceInput {
  const input = raw.trim().replace(/\/+$/, '');
  if (input === '') return { shape: 'invalid' };

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { shape: 'invalid' };
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    } catch {
      return { shape: 'invalid' };
    }
    if (path === '') return { shape: 'invalid' };

    const segments = path.split('/').filter((segment) => segment !== '');

    if (segments[0] === 'orgs') {
      const org = segments[1] ?? '';
      return NAME.test(org) ? { shape: 'org', org } : { shape: 'invalid' };
    }
    // GHES serves the API under /api/v3; a pasted API URL is not a source.
    if (segments[0] === 'api') return { shape: 'invalid' };

    const [owner, repoRaw] = stripRepoSuffix(segments);
    if (owner === undefined) return { shape: 'invalid' };
    if (repoRaw === undefined) {
      return NAME.test(owner) ? { shape: 'orgCandidate', org: owner } : { shape: 'invalid' };
    }
    const repo = repoRaw.replace(/\.git$/, '');
    return NAME.test(owner) && NAME.test(repo)
      ? { shape: 'repo', owner, repo }
      : { shape: 'invalid' };
  }

  const segments = input.split('/').filter((segment) => segment !== '');
  if (segments.length === 1) {
    const org = segments[0] as string;
    return NAME.test(org) ? { shape: 'orgCandidate', org } : { shape: 'invalid' };
  }
  if (segments.length === 2) {
    const owner = segments[0] as string;
    const repo = (segments[1] as string).replace(/\.git$/, '');
    return NAME.test(owner) && NAME.test(repo)
      ? { shape: 'repo', owner, repo }
      : { shape: 'invalid' };
  }
  return { shape: 'invalid' };
}

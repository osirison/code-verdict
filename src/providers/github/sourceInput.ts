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
/**
 * Paths under a GitHub host that are the site's own, not an owner. Without
 * this, `https://github.com/settings/tokens` parses as the repository
 * `settings/tokens` and onboarding reports it "not visible with this token".
 */
const RESERVED_OWNERS = new Set([
  'settings', 'notifications', 'marketplace', 'explore', 'topics', 'collections',
  'sponsors', 'features', 'pricing', 'about', 'login', 'join', 'new', 'search',
  'apps', 'codespaces', 'account', 'organizations', 'dashboard', 'pulls',
  'issues', 'stars', 'watching', 'api',
]);

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

/**
 * @param expectedHost the connected instance's host. A URL pointing anywhere
 * else is rejected rather than resolved against this instance — without it a
 * pasted GitLab or enterprise URL silently resolves to a *different*
 * same-named repository on the connected host.
 */
export function parseGitHubSourceInput(raw: string, expectedHost?: string): GitHubSourceInput {
  const input = raw.trim().replace(/\/+$/, '');
  if (input === '') return { shape: 'invalid' };

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { shape: 'invalid' };
    }
    if (expectedHost !== undefined && !sameHost(url.host, expectedHost)) {
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

    const [owner, repoRaw] = stripRepoSuffix(segments);
    if (owner === undefined) return { shape: 'invalid' };
    // The site's own pages are not sources (this also covers GHES's /api/v3).
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return { shape: 'invalid' };
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
    return NAME.test(org) && !RESERVED_OWNERS.has(org.toLowerCase())
      ? { shape: 'orgCandidate', org }
      : { shape: 'invalid' };
  }
  if (segments.length === 2) {
    const owner = segments[0] as string;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return { shape: 'invalid' };
    const repo = (segments[1] as string).replace(/\.git$/, '');
    return NAME.test(owner) && NAME.test(repo)
      ? { shape: 'repo', owner, repo }
      : { shape: 'invalid' };
  }
  return { shape: 'invalid' };
}

/** `www.` is the only prefix GitHub treats as the same site. */
function sameHost(actual: string, expected: string): boolean {
  const strip = (host: string): string => host.toLowerCase().replace(/^www\./, '');
  const expectedHost = expected.includes('://') ? safeHost(expected) : expected;
  const a = strip(actual);
  const b = strip(expectedHost);
  if (a === b) return true;
  // github.com and api.github.com are one instance.
  return (a === 'api.github.com' && b === 'github.com') || (a === 'github.com' && b === 'api.github.com');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

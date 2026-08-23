import { describe, expect, it } from 'vitest';
import { parseGitHubSourceInput } from './sourceInput';

describe('GitHub source input', () => {
  it('reads a repository web URL, with or without a trailing path', () => {
    expect(parseGitHubSourceInput('https://github.com/acme/core')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
    expect(parseGitHubSourceInput('https://github.com/acme/core/pull/12')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
    expect(parseGitHubSourceInput('https://github.com/acme/core/tree/main/src')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
    expect(parseGitHubSourceInput('https://github.com/acme/core.git')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
    expect(parseGitHubSourceInput('https://github.com/acme/core/')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
  });

  it('reads an enterprise host the same way', () => {
    expect(parseGitHubSourceInput('https://ghe.example.test/acme/core/pull/9'))
      .toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
  });

  it('reads a bare owner/repo path', () => {
    expect(parseGitHubSourceInput('acme/core')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
    expect(parseGitHubSourceInput('  acme/core  ')).toEqual({ shape: 'repo', owner: 'acme', repo: 'core' });
  });

  it('reads an organization URL and a bare name as an organization', () => {
    expect(parseGitHubSourceInput('https://github.com/orgs/acme')).toEqual({ shape: 'org', org: 'acme' });
    expect(parseGitHubSourceInput('acme')).toEqual({ shape: 'orgCandidate', org: 'acme' });
    // A host-root URL names an owner, which may be an org.
    expect(parseGitHubSourceInput('https://github.com/acme')).toEqual({ shape: 'orgCandidate', org: 'acme' });
  });

  it('rejects what it does not recognise', () => {
    expect(parseGitHubSourceInput('')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('   ')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('a/b/c/d/e/f/g')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('not a url')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('https://github.com/api/v3/repos')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('!!!')).toEqual({ shape: 'invalid' });
  });

  it('does not read GitLab forms as GitHub ones', () => {
    // Numeric project ids and `group <id>` belong to GitLab's grammar.
    expect(parseGitHubSourceInput('group 4821')).toEqual({ shape: 'invalid' });
    expect(parseGitHubSourceInput('9102')).toEqual({ shape: 'orgCandidate', org: '9102' });
  });
});

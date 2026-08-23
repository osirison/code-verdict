/**
 * Read-only smoke check of the GitHub provider against the LIVE api.github.com.
 * Not part of the suite: it needs network and a token. Writes nothing.
 */
import { createGitHubProvider } from '../../src/providers/github/githubProvider';

const token = process.env.GH_TOKEN ?? '';
const REPO = process.env.GH_REPO ?? 'osirison/code-verdict';
const PR = process.env.GH_PR ?? '31';
const ORG = process.env.GH_ORG ?? 'github';
const conn = createGitHubProvider().connect({
  instanceUrl: 'https://github.com',
  credential: { kind: 'token', token },
});

function show(label: string, value: unknown): void {
  console.log(`  ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));
}

async function main(): Promise<void> {
  console.log('testConnection');
  const status = await conn.testConnection();
  show('ok', status.ok);
  show('username', status.username ?? '(none)');
  if (!status.ok) throw new Error(`connect failed: ${status.error?.message}`);

  console.log('resolveSource — repository URL');
  const repo = await conn.resolveSource(`https://github.com/${REPO}`);
  show('kind', repo.kind);
  if (repo.kind === 'repository') {
    show('id', repo.repo.id);
    show('path', repo.repo.path);
    show('webUrl', repo.repo.webUrl);
  }

  console.log('resolveSource — owner/repo shorthand');
  show('kind', (await conn.resolveSource(REPO)).kind);

  console.log('resolveSource — well-formed but invisible');
  show('result', await conn.resolveSource(`${REPO.split('/')[0]}/definitely-not-a-real-repo-xyz`));

  console.log('resolveSource — unparseable');
  show('result', await conn.resolveSource('this is not a source'));

  console.log('resolveSource — organization (bare name and /orgs/ URL)');
  for (const input of [ORG, `https://github.com/orgs/${ORG}`]) {
    const org = await conn.resolveSource(input);
    show(input, org.kind === 'group' ? `group ${org.group.id} "${org.group.name}"` : org.kind);
  }

  console.log('listGroupRepositories — paginates the whole organization');
  show('count', (await conn.listGroupRepositories(ORG)).length);

  console.log('listOpenChangeRequests');
  const crs = await conn.listOpenChangeRequests([REPO]);
  show('count', crs.length);
  for (const cr of crs.slice(0, 3)) {
    show('cr', {
      number: cr.ref.number, title: cr.title, state: cr.state,
      head: cr.headSha.slice(0, 8), branch: `${cr.sourceBranch} -> ${cr.targetBranch}`,
      author: cr.author.username, ci: cr.ci?.status, draft: cr.draft,
    });
  }

  console.log('listWorkItems (issues only, PRs filtered out)');
  const items = await conn.listWorkItems([REPO]);
  show('count', items.length);
  for (const item of items.slice(0, 3)) show('issue', { number: item.number, title: item.title });

  // A merged PR still has a diff and threads, so it exercises both read paths.
  const ref = { repoId: REPO, number: PR };
  console.log(`getChangeRequestDiff (PR #${PR})`);
  const diff = await conn.getChangeRequestDiff(ref);
  show('headSha', diff.headSha.slice(0, 8));
  show('fileCount', diff.files.length);
  show('anchorRefs', diff.anchorRefs);
  const withHunks = diff.files.filter((f) => f.diff !== '').length;
  show('filesWithHunks', withHunks);
  show('firstFile', diff.files[0] ? { newPath: diff.files[0].newPath, hunkChars: diff.files[0].diff.length } : null);

  console.log('listThreads (GraphQL)');
  const threads = await conn.listThreads(ref);
  show('count', threads.length);
  for (const t of threads.slice(0, 3)) {
    show('thread', {
      id: t.id.slice(0, 14), resolved: t.resolved, anchorPresent: t.anchorPresent,
      file: t.filePath, line: t.line, notes: t.notes.length,
      authors: t.notes.map((n) => n.author.username),
    });
  }

  console.log('listCiRuns');
  const runs = await conn.listCiRuns([REPO], 3);
  show('count', runs.length);
  for (const run of runs.slice(0, 3)) show('run', { id: run.id, status: run.status, ref: run.ref });
}

main().then(
  () => console.log('\nLIVE READ CHECK PASSED — nothing was written'),
  (e) => { console.error('\nFAILED:', e); process.exit(1); },
);

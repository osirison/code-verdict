import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { renderChangesetHtml, type ChangesetViewState } from './changesetHtml';

const state: ChangesetViewState = {
  vocabulary: GITLAB_VOCABULARY,
  id: 'trailer:1180',
  name: 'Key rotation, end to end',
  linkedIssue: '#1180',
  detectionDetail: 'Part-of: #1180 in every description',
  added: 812,
  removed: 247,
  reviewed: 1,
  pipelinesPassing: 4,
  crossRepoBlockers: undefined,
  members: [
    { repoId: '9102', number: '812', project: 'hve/platform/auth-service', refLabel: '!812', title: 'Rotate signing keys on schedule', ciStatus: 'success', reviewed: true, reason: 'declares the new TTL and key ids' },
    { repoId: '9101', number: '2841', project: 'hve/platform/core', refLabel: '!2841', title: 'Refactor token refresh', ciStatus: 'success', reviewed: false, reason: 'consumes the schema' },
    { repoId: '9103', number: '381', project: 'hve/platform/api-gateway', refLabel: '!381', title: 'Propagate rotated key ids', ciStatus: 'success', reviewed: false, reason: 'renames the response field' },
    { repoId: '9210', number: '1509', project: 'hve/web/console', refLabel: '!1509', title: 'Show key expiry banner', ciStatus: 'success', reviewed: false, reason: 'reads the renamed field' },
  ],
};

describe('changeset fidelity (spec §15)', () => {
  const html = renderChangesetHtml(state, 'nonce123');

  it('renders aggregate identity and readiness from live members', () => {
    expect(html).toContain('max-width: 900px');
    expect(html).toContain('Key rotation, end to end');
    expect(html).toContain('#1180');
    expect(html).toContain('4 merge requests · 4 projects · +812 −247');
    expect(html).toContain('4/4');
    expect(html).toContain('1/4');
    expect(html).toContain('<div class="metric-value ">—</div>');
  });

  it('renders each member in merge order and routes review actions', () => {
    expect(html).toContain('Rotate signing keys on schedule');
    expect(html).toContain('Show key expiry banner');
    expect(html).toContain('Review all 4 MRs together');
    expect(html).toContain("type: 'openMember'");
    expect(html).toContain("type: 'reviewTogether'");
  });

  // Handlers are delegated on `document` and matched with `closest()` (task
  // 7.1), so they survive a region patch that replaces this container's
  // innerHTML — a listener bound directly to a button would not. The
  // changeset id rides a `data-changeset-id` attribute read at click time
  // rather than a value baked into the script string, so a script that
  // outlives the state it was built from (once this screen patches instead
  // of reassigning the whole document) never answers with a stale id.
  it('carries the changeset id on a data attribute, escaped for the HTML context', () => {
    const html = renderChangesetHtml({ ...state, id: "trailer:'1180" }, 'nonce123');

    expect(html).toContain(`data-changeset-id="trailer:'1180"`);
    expect(html).toContain('document.querySelector(\'[data-changeset-id]\')');
    // The id itself never appears baked into the script as a literal — only
    // read back from the data attribute above.
    expect(html).not.toContain(`changesetId: "trailer:'1180"`);
    expect(html).not.toContain(`changesetId:"trailer:'1180"`);
  });

  it('omits the issue chip for branch-detected changesets and shows the remove link only for manual ones', () => {
    const branch = renderChangesetHtml({
      ...state,
      linkedIssue: undefined,
      detectionDetail: 'shared branch name chore/v1-sunset',
    }, 'n');
    expect(branch).not.toContain('class="issue"');
    expect(branch).toContain('shared branch name chore/v1-sunset');
    expect(branch).not.toContain('Remove changeset');

    const manual = renderChangesetHtml({ ...state, linkedIssue: undefined, manual: true }, 'n');
    expect(manual).toContain('Remove changeset');
    expect(manual).toContain("type: 'removeChangeset'");
  });

  it('renders cross-repo findings with both sides and their roles, wired to triage', () => {
    const html = renderChangesetHtml({
      ...state,
      crossRepoBlockers: 1,
      findings: [{
        id: 'cross_1',
        severity: 'blocker',
        title: 'Response field renamed in the gateway but still read in the console',
        confidence: 94,
        sides: [
          { project: 'api-gateway', location: 'src/routes/session.ts:88', role: 'renames the field' },
          { project: 'console', location: 'src/api/session.ts:41', role: 'still reads the old name' },
        ],
      }],
    }, 'n');

    expect(html).toContain('data-finding="cross_1"');
    expect(html).toContain('renames the field');
    expect(html).toContain('still reads the old name');
    expect(html).toContain('src/api/session.ts:41');
    expect(html).toContain('confidence 94%');
    expect(html).toContain("type: 'openFinding'");
    // The blockers metric now carries a real count.
    expect(html).not.toContain('<div class="metric-value ">—</div>');
    // The trap sentence names what green pipelines cannot see.
    expect(html).toContain('1 finding only exists between these repos — each MR is clean on its own.');
  });

  it('states the readiness trap per pipeline state', () => {
    const red = renderChangesetHtml({ ...state, pipelinesPassing: 3, findings: [] }, 'n');
    expect(red).toContain('One pipeline is still red. Cross-repo findings below hold regardless.');

    const cleanRun = renderChangesetHtml({ ...state, findings: [], crossRepoBlockers: 0 }, 'n');
    expect(cleanRun).toContain('found nothing that only exists between these repos');
    expect(cleanRun).toContain('<div class="metric-value ok">0</div>');

    const noRun = renderChangesetHtml(state, 'n');
    expect(noRun).toContain('No combined review has run yet');
  });

  it('keeps the spec label past tense only once a run has read the diffs', () => {
    // Spec §15 copy, verbatim, whenever findings exist — including a clean run.
    expect(renderChangesetHtml({ ...state, findings: [] }, 'n')).toContain('agent read all 4 diffs together');
    // Before any run the same label would claim one happened.
    const noRun = renderChangesetHtml(state, 'n');
    expect(noRun).toContain('agent reads all 4 diffs together');
    expect(noRun).not.toContain('agent read all 4 diffs together');
  });

  it('omits the reason line when there is no signal behind it', () => {
    const html = renderChangesetHtml({
      ...state,
      members: state.members.map((member) => ({ ...member, reason: undefined })),
    }, 'n');

    expect(html).not.toContain('class="reason"');
  });
});

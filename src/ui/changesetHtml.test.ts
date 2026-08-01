import { describe, expect, it } from 'vitest';
import { renderChangesetHtml, type ChangesetViewState } from './changesetHtml';

const state: ChangesetViewState = {
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
    { repoId: '9102', project: 'hve/platform/auth-service', refLabel: '!812', title: 'Rotate signing keys on schedule', ciStatus: 'success', reviewed: true, reason: 'declares the new TTL and key ids' },
    { repoId: '9101', project: 'hve/platform/core', refLabel: '!2841', title: 'Refactor token refresh', ciStatus: 'success', reviewed: false, reason: 'consumes the schema' },
    { repoId: '9103', project: 'hve/platform/api-gateway', refLabel: '!381', title: 'Propagate rotated key ids', ciStatus: 'success', reviewed: false, reason: 'renames the response field' },
    { repoId: '9210', project: 'hve/web/console', refLabel: '!1509', title: 'Show key expiry banner', ciStatus: 'success', reviewed: false, reason: 'reads the renamed field' },
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
    expect(html).toContain("type:'openMember'");
    expect(html).toContain("type:'reviewTogether'");
  });

  it('serializes the changeset id as a JavaScript string literal', () => {
    const html = renderChangesetHtml({ ...state, id: "trailer:'1180" }, 'nonce123');

    expect(html).toContain(`changesetId:"trailer:'1180"`);
    expect(html).not.toContain(`changesetId:'trailer:'1180'`);
  });
});
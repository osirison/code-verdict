import type { AgentReviewResponse, CandidateBucket } from '../domain/agentResponse';
import { AgentResponseError } from '../domain/agentResponse';
import { filterReason } from '../domain/criteria';
import { addedLines, diffStats } from '../domain/diffHunks';
import type { Criteria, ReviewItem } from '../domain/types';
import type { ChangeRequestDiff, ChangeRequestRef } from '../platform/types';
import { DEMO_AGENT_ID, DEMO_AGENT_LABEL, runDemoAgent, type DemoAgentResult } from './demoAgent';

export interface ChangesetAgentMember {
  ref: ChangeRequestRef;
  projectPath: string;
  diff: ChangeRequestDiff;
}

function compositeHead(members: readonly ChangesetAgentMember[]): string {
  return members.map((member) => `${member.ref.repoId}!${member.ref.number}:${member.diff.headSha}`).join('|');
}

function crossRepositoryFinding(members: readonly ChangesetAgentMember[]): ReviewItem | undefined {
  const gateway = members.find((member) => member.diff.files.some((file) => addedLines(file.diff).some((line) => line.text.includes('expires_at'))));
  const consoleMember = members.find((member) => member.diff.files.some((file) => addedLines(file.diff).some((line) => /\.expiry\b/.test(line.text))));
  if (!gateway || !consoleMember) return undefined;
  const gatewayFile = gateway.diff.files.find((file) => addedLines(file.diff).some((line) => line.text.includes('expires_at')));
  const consoleFile = consoleMember.diff.files.find((file) => addedLines(file.diff).some((line) => /\.expiry\b/.test(line.text)));
  const gatewayLine = gatewayFile && addedLines(gatewayFile.diff).find((line) => line.text.includes('expires_at'));
  const consoleLine = consoleFile && addedLines(consoleFile.diff).find((line) => /\.expiry\b/.test(line.text));
  if (!gatewayFile || !consoleFile || !gatewayLine || !consoleLine) return undefined;
  return {
    id: `cross_${gateway.ref.repoId}_${consoleMember.ref.repoId}_expiry`,
    repoId: consoleMember.ref.repoId,
    crNumber: consoleMember.ref.number,
    file: consoleFile.newPath,
    line: consoleLine.line,
    severity: 'blocker',
    category: 'apiContract',
    confidence: 94,
    title: 'Response field renamed in the gateway but still read in the console',
    body: 'One member publishes expires_at while another still reads expiry. Both can pass independently and fail when deployed together.',
    code: consoleLine.text.trim(),
    cross: true,
    spans: [
      { repoId: gateway.ref.repoId, location: `${gatewayFile.newPath}:${gatewayLine.line}`, role: 'renames the field' },
      { repoId: consoleMember.ref.repoId, location: `${consoleFile.newPath}:${consoleLine.line}`, role: 'still reads the old name' },
    ],
    suggestion: { old: consoleLine.text.trim(), new: consoleLine.text.replace(/\.expiry\b/, '.expires_at').trim() },
    answers: {
      explain: 'Each repository tests one side of the contract, so neither suite observes the mismatch.',
      fix: 'Read expires_at in the consumer, or publish both names for one compatibility release.',
      similar: 'Search changeset members for other reads of expiry and expires_at.',
      why: 'The combined diff contains a producer rename and a consumer that retains the old field.',
    },
  };
}

export function validateChangesetResponse(
  response: AgentReviewResponse,
  members: readonly ChangesetAgentMember[],
): AgentReviewResponse {
  for (const item of response.items) {
    const member = members.find((candidate) => candidate.ref.repoId === item.repoId && candidate.ref.number === item.crNumber);
    if (!member) throw new AgentResponseError(`item ${item.id} targets an unknown changeset member`);
    const file = member.diff.files.find((candidate) => candidate.newPath === item.file);
    if (!file) throw new AgentResponseError(`item ${item.id} targets a file outside its member diff`);
    const validLines = addedLines(file.diff);
    if (!validLines.some((line) => line.line === item.line)) {
      throw new AgentResponseError(`item ${item.id} targets a line outside its member diff`);
    }
    if (item.cross && (item.spans?.length ?? 0) < 2) {
      throw new AgentResponseError(`cross-repository item ${item.id} must name both sides`);
    }
    for (const span of item.spans ?? []) {
      if (!members.some((candidate) => candidate.ref.repoId === span.repoId)) {
        throw new AgentResponseError(`item ${item.id} span targets an unknown repository`);
      }
    }
  }
  return response;
}

export function runDemoChangesetAgent(
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
): DemoAgentResult {
  const items: ReviewItem[] = [];
  const candidates: CandidateBucket[] = [];
  const steps: string[] = [];
  let durationMs = 0;
  for (const member of members) {
    const result = runDemoAgent(member.diff, criteria);
    items.push(...result.response.items.map((item) => ({
      ...item,
      id: `${member.ref.repoId}_${member.ref.number}_${item.id}`,
      repoId: member.ref.repoId,
      crNumber: member.ref.number,
    })));
    candidates.push(...result.response.candidates);
    durationMs += result.response.stats?.durationMs ?? 0;
    if (steps.length === 0) steps.push(...result.steps);
  }
  const cross = crossRepositoryFinding(members);
  if (cross) {
    const reason = filterReason(cross, criteria);
    if (reason === null) items.push(cross);
    else candidates.push({ severity: cross.severity, category: cross.category, confidence: cross.confidence, reason, count: 1 });
  }
  const stats = diffStats(members.flatMap((member) => member.diff.files.map((file) => file.diff)));
  const response: AgentReviewResponse = {
    schemaVersion: '1',
    agentId: DEMO_AGENT_ID,
    agentLabel: DEMO_AGENT_LABEL,
    headSha: compositeHead(members),
    stats: { filesRead: members.reduce((count, member) => count + member.diff.files.length, 0), linesAdded: stats.added, linesRemoved: stats.removed, durationMs },
    items,
    candidates,
  };
  const finalSteps = [
    'Resolving agent from Copilot workspace…',
    `Indexing ${response.stats?.filesRead ?? 0} changed files across ${members.length} merge requests (+${stats.added} −${stats.removed})…`,
    'Cross-referencing contracts between repositories…',
    'Scoring findings against project criteria…',
    `${items.length} items ready`,
  ];
  return { response: validateChangesetResponse(response, members), steps: finalSteps };
}

export function changesetHeadSha(members: readonly ChangesetAgentMember[]): string {
  return compositeHead(members);
}

/**
 * The inverse of {@link changesetHeadSha}, kept beside it so the two formats
 * cannot drift. A segment is `<repoId>!<number>:<sha>`; anything without the
 * separator is not a composite head and is dropped rather than parsed into a
 * bogus key, which would read as "every member moved".
 */
export function parseChangesetHeadSha(headSha: string): Map<string, string> {
  return new Map(
    headSha.split('|').flatMap((part) => {
      const separator = part.lastIndexOf(':');
      if (separator < 0) return [];
      const [key, sha] = [part.slice(0, separator), part.slice(separator + 1)];
      return key && sha ? [[key, sha] as const] : [];
    }),
  );
}
/**
 * The block an attempt writes before it runs (`harnessPolicyTrace.ts`), covered where it is pure:
 * the three origins, the loud rejected line, the honest fallback when a host wired no settings
 * reader, and the marker rule every other trace line in this codebase is already held to.
 *
 * The "every settable key appears" drift assertion and the exact rendering for a real configuration
 * live in `../ui/harnessPolicyOptions.test.ts` instead — that is where the setting table, the
 * `package.json` defaults and the `inspect`-driven provenance reader all are, so a test that spans
 * them belongs there rather than behind a hand-written fixture here.
 */
import { describe, expect, it } from 'vitest';
import {
  formatSuppliedValue,
  renderAttemptConfiguration,
  writeAttemptConfiguration,
  type ResolvedHarnessSetting,
} from './harnessPolicyTrace';
import { withDecodedForms } from '../testing/secretScan';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

function sink(): { lines: string[]; appendLine: (line: string) => void } {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => lines.push(line) };
}

function snapshotFixture(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: 'run-cfg-1',
    lineageId: 'lineage-cfg-1',
    attempt: 1,
    createdAt: '2026-09-12T09:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: 'acme/widgets!42',
        providerId: 'github',
        instanceUrl: 'https://github.com',
        ref: { repoId: 'acme/widgets', number: '42' },
        baseSha: '1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d',
        baseRevisionKind: 'mergeBase',
        headSha: 'f0e9d8c7b6a5948372f0e9d8c7b6a5948372f0e9',
        investigationSource: { kind: 'localGit', contractVersion: '1', capabilitySignature: 'cap-sig' },
        providerCapabilitySignature: 'provider-sig',
        rootAgentsPolicy: { present: false },
        context: {
          autoContextEnabled: false,
          titleIncluded: false,
          descriptionIncluded: false,
          linkedItemIdsIncluded: [],
          attachments: [],
        },
      },
    ],
    agentId: 'agent:builtin/default',
    agentInstructions: 'You are a code review agent. Review ONLY the diffs below.',
    agentInstructionsDigest: 'agent-digest',
    personaLabel: 'Built-in reviewer',
    modelId: 'copilot:gpt-4o',
    modelCapability: { vendor: 'copilot', family: 'gpt-4o', maxInputTokens: 128_000 },
    effort: 'none',
    effortInstructionDigest: 'effort-digest',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'extra-digest',
    toolContractVersion: '1',
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
    ...overrides,
  };
}

const SAMPLE_SETTINGS: readonly ResolvedHarnessSetting[] = [
  { settingKey: 'maxModelTurnsPerAttempt', value: 64, origin: 'default' },
  { settingKey: 'maxPromptKilobytesPerTurn', value: 96, origin: 'setting' },
  { settingKey: 'retainedCheckpointsPerLineage', value: 3, origin: 'rejected', supplied: -3 },
];

describe('the attempt configuration block: every settable value, and where it came from', () => {
  it('states a default, a reviewer-set value, and a rejected one in three distinguishable ways under one grep-able head', () => {
    const lines = renderAttemptConfiguration({ snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS });

    expect(lines).toContain('[run-cfg-1#1] policy maxModelTurnsPerAttempt=64 (shipped default)');
    expect(lines).toContain('[run-cfg-1#1] policy maxPromptKilobytesPerTurn=96 (settings.json)');
    expect(lines).toContain(
      '[run-cfg-1#1] policy retainedCheckpointsPerLineage=3 — REJECTED: settings.json supplied -3, not used; the attempt runs on 3',
    );

    // The head is identical in all three states, which is what makes one grep answer "what did this
    // run actually use" regardless of where the value came from.
    for (const key of ['maxModelTurnsPerAttempt', 'maxPromptKilobytesPerTurn', 'retainedCheckpointsPerLineage']) {
      expect(lines.filter((line) => line.includes(`] policy ${key}=`))).toHaveLength(1);
    }
  });

  it('counts the origins on one summary line, so "is settings.json being read at all" is answerable before reading fifteen lines', () => {
    const lines = renderAttemptConfiguration({ snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS });
    expect(lines).toContain('[run-cfg-1#1] policy 3 setting(s): 1 from settings.json, 1 shipped default, 1 REJECTED');
  });

  it('omits the REJECTED clause from the summary when nothing was rejected', () => {
    const lines = renderAttemptConfiguration({
      snapshot: snapshotFixture(),
      settings: [{ settingKey: 'maxModelTurnsPerAttempt', value: 64, origin: 'default' }],
    });
    expect(lines).toContain('[run-cfg-1#1] policy 1 setting(s): 0 from settings.json, 1 shipped default');
  });

  it('names the attempt on every line, because two concurrent attempts interleave in one file', () => {
    const lines = renderAttemptConfiguration({
      snapshot: snapshotFixture({ runId: 'run-cfg-9', attempt: 3 }),
      settings: SAMPLE_SETTINGS,
    });
    expect(lines[0]).toBe('===== attempt run-cfg-9#3 resolved configuration =====');
    expect(lines[lines.length - 1]).toBe('===== end resolved configuration for run-cfg-9#3 =====');
    for (const line of lines.slice(1, -1)) expect(line.startsWith('[run-cfg-9#3] ')).toBe(true);
  });

  it('carries the attempt’s other resolved facts — model, investigation source, pinned revisions — in the same block', () => {
    const lines = renderAttemptConfiguration({ snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS });
    expect(lines).toContain('[run-cfg-1#1] lineage=lineage-cfg-1 target=cr agent=agent:builtin/default effort=none');
    expect(lines).toContain('[run-cfg-1#1] model=copilot:gpt-4o vendor=copilot family=gpt-4o maxInputTokens=128000');
    expect(lines).toContain(
      '[run-cfg-1#1] member acme/widgets!42 source=localGit base=1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d (mergeBase) head=f0e9d8c7b6a5948372f0e9d8c7b6a5948372f0e9',
    );
    expect(lines).toContain(`[run-cfg-1#1] contracts policyVersion=${HARNESS_POLICY_VERSION} toolContractVersion=1 snapshotSchema=1`);
  });

  it('says the agent calls no model rather than printing an empty model id', () => {
    const lines = renderAttemptConfiguration({
      snapshot: snapshotFixture({ modelId: undefined, modelCapability: undefined }),
      settings: SAMPLE_SETTINGS,
    });
    expect(lines).toContain('[run-cfg-1#1] model=(none — this agent calls no model)');
  });

  it('reads an absent baseRevisionKind/investigationSource through the domain’s own accessors rather than printing "undefined"', () => {
    const member = { ...snapshotFixture().members[0]! };
    delete (member as { baseRevisionKind?: unknown }).baseRevisionKind;
    delete (member as { investigationSource?: unknown }).investigationSource;
    const lines = renderAttemptConfiguration({ snapshot: snapshotFixture({ members: [member] }), settings: SAMPLE_SETTINGS });
    expect(lines.some((line) => line.includes('source=provider') && line.includes('(targetBranchTip)'))).toBe(true);
  });

  it('one line per member of a changeset', () => {
    const base = snapshotFixture();
    const second = { ...base.members[0]!, memberId: 'acme/tools!7', headSha: 'aaaabbbbccccddddeeeeffff0000111122223333' };
    const lines = renderAttemptConfiguration({
      snapshot: snapshotFixture({ targetKind: 'changeset', changesetId: 'cs-1', members: [base.members[0]!, second] }),
      settings: SAMPLE_SETTINGS,
    });
    expect(lines.filter((line) => line.includes('] member ')).length).toBe(2);
    expect(lines.some((line) => line.includes('target=changeset changeset=cs-1'))).toBe(true);
  });

  it('says plainly that no provenance is available rather than stopping after the member lines', () => {
    const lines = renderAttemptConfiguration({ snapshot: snapshotFixture(), settings: undefined });
    expect(lines).toContain(
      '[run-cfg-1#1] policy: this host wired no settings reader, so no value below can be attributed to settings.json',
    );
    expect(lines.some((line) => line.includes('] policy maxModelTurnsPerAttempt='))).toBe(false);
  });
});

describe('writing the block to the trace sink', () => {
  it('leads every line with the shared local time-of-day, so it lines up by eye against the request lines that follow', () => {
    const s = sink();
    const at = new Date(2026, 8, 12, 14, 30, 0, 500).getTime();
    writeAttemptConfiguration(s, () => at, { snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS });
    expect(s.lines.length).toBeGreaterThan(0);
    for (const line of s.lines) expect(line).toMatch(/^14:30:00\.500 /);
  });

  it('writes nothing at all when no sink was wired, and never throws when the sink does', () => {
    expect(() => writeAttemptConfiguration(undefined, () => 0, { snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS })).not.toThrow();
    const throwing = {
      appendLine: () => {
        throw new Error('channel disposed');
      },
    };
    expect(() => writeAttemptConfiguration(throwing, () => 0, { snapshot: snapshotFixture(), settings: SAMPLE_SETTINGS })).not.toThrow();
  });
});

/**
 * The same marker convention every other writer into this sink is held to (`agentTrace.test.ts`'s
 * own marker test, `harnessCheckpoint.test.ts`'s): plant a credential where one could reach the
 * block, walk every line, and search the decoded haystack — not just the raw bytes — for it.
 *
 * There is exactly one reviewer-controlled string in this block: whatever settings.json held for a
 * value normalization rejected. A numeric setting holding a pasted token is not a hypothetical —
 * settings.json is hand-edited text and every one of these keys sits next to `codeVerdict.*` keys
 * that are not numeric — and the line reporting the mistake must not be the thing that copies the
 * credential into a durable log.
 */
describe('the marker test: nothing secret rides a rejected value into the trace', () => {
  it('finds none of the planted markers anywhere in the block, raw or decoded, and keeps every line bounded', () => {
    const SECRET_MARKER = 'MARKER_SETTING_SECRET_8c4f1a2e';
    const ENCODED_MARKER = 'MARKER_SETTING_ENCODED_5b7d0e3a';
    const STRUCTURED_MARKER = 'MARKER_SETTING_STRUCTURED_2f6c9b1d';

    const s = sink();
    writeAttemptConfiguration(s, () => 0, {
      snapshot: snapshotFixture(),
      settings: [
        // A credential pasted into a numeric setting, under a key name the redactor recognizes.
        { settingKey: 'maxModelTurnsPerAttempt', value: 64, origin: 'rejected', supplied: `{"token":"${SECRET_MARKER}1234567890abcd"}` },
        // The same credential already encoded — a scan of raw bytes alone would pass here for the
        // wrong reason.
        {
          settingKey: 'maxToolRequestsPerAttempt',
          value: 256,
          origin: 'rejected',
          supplied: `Authorization: Basic ${Buffer.from(`oauth2:${ENCODED_MARKER}`, 'utf8').toString('base64')}`,
        },
        // A structured value: there is no legitimate object for any of these settings, so the shape
        // is printed and the contents never are.
        { settingKey: 'highRiskReservePercent', value: 20, origin: 'rejected', supplied: { token: STRUCTURED_MARKER } },
        // Far past `sanitizePublicText`'s 240-character bound, so survival would prove the bound was
        // not applied — the technique `harnessCheckpoint.test.ts`'s marker test uses.
        {
          settingKey: 'requireInspectionMinRisk',
          value: 'medium',
          origin: 'rejected',
          supplied: `${'nonsense level '.repeat(40)}${STRUCTURED_MARKER}`,
        },
      ],
    });

    const serialized = s.lines.join('\n');
    const decoded = withDecodedForms(serialized);
    // Keeps the decoder honest — without this a decoder that returned its input would make every
    // assertion below vacuous.
    expect(withDecodedForms(`x ${Buffer.from(`oauth2:${ENCODED_MARKER}`, 'utf8').toString('base64')} y`)).toContain(ENCODED_MARKER);

    // The rejected lines really were written, or the absences below would prove nothing. Matched on
    // the clause, not the bare word: the summary line carries "REJECTED" too, and counting it here
    // would let one missing setting line pass unnoticed.
    expect(s.lines.filter((line) => line.includes('— REJECTED: ')).length).toBe(4);

    for (const haystack of [serialized, decoded]) {
      expect(haystack).not.toContain(SECRET_MARKER);
      expect(haystack).not.toContain(ENCODED_MARKER);
      expect(haystack).not.toContain(STRUCTURED_MARKER);
    }
    expect(serialized).toContain('an object');

    // Structural, not "these four markers happened not to match a pattern": every line stays a
    // bounded metadata line, the same bound `agentTrace.test.ts` holds its own sink to.
    for (const line of s.lines) expect(line.length).toBeLessThan(500);
  });

  it('prints a number or a boolean verbatim — those are the whole point of the line and neither can carry a credential', () => {
    expect(formatSuppliedValue(-3)).toBe('-3');
    expect(formatSuppliedValue(10.5)).toBe('10.5');
    expect(formatSuppliedValue(Number.NaN)).toBe('NaN');
    expect(formatSuppliedValue(true)).toBe('true');
    expect(formatSuppliedValue(null)).toBe('null');
    expect(formatSuppliedValue([1, 2])).toBe('an array (2 item(s))');
    expect(formatSuppliedValue({})).toBe('an object');
    expect(formatSuppliedValue('medium')).toBe('"medium"');
  });
});

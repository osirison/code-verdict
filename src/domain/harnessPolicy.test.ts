import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy } from './harnessPolicy';

describe('HarnessPolicy defaults and normalization (task 2.6)', () => {
  it('matches the design defaults table when given nothing', () => {
    const policy = normalizeHarnessPolicy({});
    expect(policy).toEqual(DEFAULT_HARNESS_POLICY);
    expect(policy.globalConcurrency).toBe(3);
    expect(policy.maxElapsedMsPerAttempt).toBe(30 * 60 * 1000);
    expect(policy.maxModelTurnsPerAttempt).toBe(64);
    expect(policy.maxToolRequestsPerAttempt).toBe(256);
    expect(policy.maxToolRequestsPerTurn).toBe(8);
    expect(policy.maxToolResultBytes).toBe(64 * 1024);
    expect(policy.highRiskReservePercent).toBe(20);
    expect(policy.verificationReservePercent).toBe(15);
    expect(policy.checkpointCadenceToolCalls).toBe(10);
    expect(policy.retainedCheckpointsPerLineage).toBe(3);
    expect(policy.terminalAttemptHistoryCount).toBe(5);
    expect(policy.terminalAttemptHistoryMaxAgeDays).toBe(30);
  });

  it('falls back to the default with no configuration object at all', () => {
    expect(normalizeHarnessPolicy()).toEqual(DEFAULT_HARNESS_POLICY);
  });

  it('treats 0 as unlimited global concurrency rather than falling back', () => {
    expect(normalizeHarnessPolicy({ globalConcurrency: 0 }).globalConcurrency).toBe(0);
  });

  it('falls back per field on a negative, non-numeric, or absent value', () => {
    const policy = normalizeHarnessPolicy({
      maxModelTurnsPerAttempt: -1,
      maxToolRequestsPerAttempt: 'lots',
      manifestPageSize: undefined,
    });
    expect(policy.maxModelTurnsPerAttempt).toBe(DEFAULT_HARNESS_POLICY.maxModelTurnsPerAttempt);
    expect(policy.maxToolRequestsPerAttempt).toBe(DEFAULT_HARNESS_POLICY.maxToolRequestsPerAttempt);
    expect(policy.manifestPageSize).toBe(DEFAULT_HARNESS_POLICY.manifestPageSize);
  });

  it('does not let one unusable field corrupt the rest of the policy', () => {
    const policy = normalizeHarnessPolicy({ maxModelTurnsPerAttempt: -1, manifestPageSize: 250 });
    expect(policy.maxModelTurnsPerAttempt).toBe(DEFAULT_HARNESS_POLICY.maxModelTurnsPerAttempt);
    expect(policy.manifestPageSize).toBe(250);
  });

  it('clamps a reserve percentage outside 0-100 back to the default', () => {
    expect(normalizeHarnessPolicy({ highRiskReservePercent: 150 }).highRiskReservePercent).toBe(
      DEFAULT_HARNESS_POLICY.highRiskReservePercent,
    );
    expect(normalizeHarnessPolicy({ highRiskReservePercent: -5 }).highRiskReservePercent).toBe(
      DEFAULT_HARNESS_POLICY.highRiskReservePercent,
    );
    expect(normalizeHarnessPolicy({ highRiskReservePercent: 35 }).highRiskReservePercent).toBe(35);
  });

  it('falls back to the default on a non-boolean jitter value', () => {
    expect(normalizeHarnessPolicy({ backoffJitter: 'yes' }).backoffJitter).toBe(DEFAULT_HARNESS_POLICY.backoffJitter);
    expect(normalizeHarnessPolicy({ backoffJitter: false }).backoffJitter).toBe(false);
  });

  it('floors a fractional positive-integer field rather than rejecting it', () => {
    expect(normalizeHarnessPolicy({ manifestPageSize: 99.9 }).manifestPageSize).toBe(99);
  });
});

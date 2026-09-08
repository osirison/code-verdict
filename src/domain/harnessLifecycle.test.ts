import { describe, expect, it } from 'vitest';
import {
  isActiveLifecycle,
  isResultCompleteness,
  isRunLifecycle,
  isTerminalLifecycle,
  parseResultCompleteness,
  parseRunLifecycle,
  RESULT_COMPLETENESS_VALUES,
  RUN_LIFECYCLES,
} from './harnessLifecycle';

describe('harness lifecycle and completeness parsing (task 2.1)', () => {
  it('accepts every canonical lifecycle value', () => {
    for (const lifecycle of RUN_LIFECYCLES) {
      expect(isRunLifecycle(lifecycle)).toBe(true);
      expect(parseRunLifecycle(lifecycle)).toBe(lifecycle);
    }
  });

  it('excludes the running compatibility projection from the canonical lifecycle', () => {
    expect((RUN_LIFECYCLES as readonly string[]).includes('running')).toBe(false);
    expect(isRunLifecycle('running')).toBe(false);
  });

  it('fails closed on an unknown or malformed lifecycle value', () => {
    expect(parseRunLifecycle('bogus')).toBeUndefined();
    expect(parseRunLifecycle(undefined)).toBeUndefined();
    expect(parseRunLifecycle(null)).toBeUndefined();
    expect(parseRunLifecycle(42)).toBeUndefined();
  });

  it('accepts every result completeness value', () => {
    for (const completeness of RESULT_COMPLETENESS_VALUES) {
      expect(isResultCompleteness(completeness)).toBe(true);
      expect(parseResultCompleteness(completeness)).toBe(completeness);
    }
  });

  it('fails closed on an unknown or malformed completeness value', () => {
    expect(parseResultCompleteness('done')).toBeUndefined();
    expect(parseResultCompleteness(undefined)).toBeUndefined();
    expect(parseResultCompleteness(1)).toBeUndefined();
  });

  it('classifies active phases as the running compatibility projection', () => {
    expect(isActiveLifecycle('planning')).toBe(true);
    expect(isActiveLifecycle('investigating')).toBe(true);
    expect(isActiveLifecycle('verifying')).toBe(true);
    expect(isActiveLifecycle('completing')).toBe(true);
    expect(isActiveLifecycle('queued')).toBe(false);
    expect(isActiveLifecycle('waiting')).toBe(false);
    expect(isActiveLifecycle('paused')).toBe(false);
  });

  it('classifies terminal lifecycles, including interrupted', () => {
    expect(isTerminalLifecycle('succeeded')).toBe(true);
    expect(isTerminalLifecycle('failed')).toBe(true);
    expect(isTerminalLifecycle('cancelled')).toBe(true);
    expect(isTerminalLifecycle('interrupted')).toBe(true);
    expect(isTerminalLifecycle('queued')).toBe(false);
    expect(isTerminalLifecycle('resuming')).toBe(false);
  });
});

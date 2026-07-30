import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_COMMAND_IDS } from './commands';

interface PackageJson {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    keybindings: Array<{ command: string; when?: string }>;
  };
}

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as PackageJson;

describe('package.json contributions', () => {
  it('contributes exactly the 19 Verdict commands', () => {
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    expect(contributed).toEqual([...ALL_COMMAND_IDS].sort());
    expect(contributed).toHaveLength(19);
  });

  it('prefixes every command title with "Verdict:"', () => {
    for (const c of pkg.contributes.commands) {
      expect(c.title).toMatch(/^Verdict: /);
    }
  });

  it('scopes every keybinding under verdict.reviewFocus', () => {
    for (const kb of pkg.contributes.keybindings) {
      expect(kb.when).toBe('verdict.reviewFocus');
    }
  });
});

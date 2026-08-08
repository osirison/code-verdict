import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_COMMAND_IDS, ALL_INTERNAL_COMMAND_IDS, INTERNAL_COMMANDS } from './commands';
import { DIGEST_CADENCES, NOTIFICATION_EVENTS, NOTIFICATION_MODES } from './domain/notifications';
import { DEFAULT_TRAILER } from './app/changesets';

interface PackageJson {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    keybindings: Array<{ command: string; key: string; args?: unknown; when?: string }>;
    views: Record<string, Array<{ id: string; name: string; type?: string }>>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
    configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> };
  };
}

const pkg = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
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

  it('binds every key the triage map promises — A ⇧A R S J K U 1-4 ?', () => {
    const bound = new Map(pkg.contributes.keybindings.map((kb) => [`${kb.key}${kb.args ? `:${String(kb.args)}` : ''}`, kb.command]));
    expect([...bound.keys()].sort()).toEqual(
      [
        '1:blocker',
        '2:major',
        '3:minor',
        '4:nit',
        'a',
        'ctrl+enter',
        'j',
        'k',
        'r',
        's',
        'shift+/',
        'shift+a',
        'u',
      ].sort(),
    );
    // `A` applies the suggested fix; `⇧A` accepts comment-only (handoff §6).
    expect(bound.get('a')).toBe('codeVerdict.acceptItem');
    expect(bound.get('shift+a')).toBe(INTERNAL_COMMANDS.acceptCommentOnly);
    expect(bound.get('u')).toBe(INTERNAL_COMMANDS.undoVerdict);
    expect(bound.get('shift+/')).toBe(INTERNAL_COMMANDS.keyboardHelp);
  });

  it('binds keys and menus only to contributed or internal command ids', () => {
    const known = new Set<string>([...ALL_COMMAND_IDS, ...ALL_INTERNAL_COMMAND_IDS]);
    for (const kb of pkg.contributes.keybindings) expect(known).toContain(kb.command);
    for (const entries of Object.values(pkg.contributes.menus)) {
      for (const entry of entries) expect(known).toContain(entry.command);
    }
  });

  it('keeps internal ids out of the palette', () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const id of ALL_INTERNAL_COMMAND_IDS) expect(contributed).not.toContain(id);
  });

  it('puts the verdict actions on the in-diff comment thread', () => {
    const menu = pkg.contributes.menus['comments/commentThread/title'] ?? [];
    expect(menu.map((entry) => entry.command)).toEqual([
      'codeVerdict.acceptItem',
      'codeVerdict.rejectItem',
      'codeVerdict.skipItem',
    ]);
    // Scoped to Verdict's own controller — never another extension's threads.
    for (const entry of menu) expect(entry.when).toBe('commentController == codeVerdict.review');
  });

  it('declares the registered Verdict sidebar provider as a webview', () => {
    expect(pkg.contributes.views.verdict).toContainEqual({
      id: 'codeVerdict.sidebar',
      name: 'Verdict',
      type: 'webview',
    });
  });
});

// package.json cannot import the domain module, so agreement is enforced
// here — the same mechanism that pins the 19 commands above.
describe('notification settings contributions', () => {
  const properties = pkg.contributes.configuration.properties;

  it('contributes every event with the spec §11 default and the four modes', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const setting = properties[`codeVerdict.notifications.events.${event.key}`];
      expect(setting, event.key).toBeDefined();
      expect(setting?.enum).toEqual([...NOTIFICATION_MODES]);
      expect(setting?.default, event.key).toBe(event.defaultMode);
    }
  });

  it('contributes no event settings beyond the seven', () => {
    const contributed = Object.keys(properties).filter((key) =>
      key.startsWith('codeVerdict.notifications.events.'),
    );
    expect(contributed).toHaveLength(NOTIFICATION_EVENTS.length);
  });

  it('contributes the digest cadence and quiet mode with their defaults', () => {
    const cadence = properties['codeVerdict.notifications.digestCadence'];
    expect(cadence?.enum).toEqual([...DIGEST_CADENCES]);
    expect(cadence?.default).toBe('End of day');
    expect(properties['codeVerdict.notifications.quietMode']?.default).toBe(false);
  });
});

// Handoff §16: the trailer convention is a setting, with branch matching as
// a fallback that can be switched off. The code reads these through
// `changesetDetectionOptions` — the manifest must agree with its defaults.
describe('changeset settings contributions', () => {
  const properties = pkg.contributes.configuration.properties;

  it('contributes the trailer convention with the DEFAULT_TRAILER default', () => {
    expect(properties['codeVerdict.changesets.trailer']?.default).toBe(DEFAULT_TRAILER);
  });

  it('contributes the branch-fallback switch, on by default', () => {
    expect(properties['codeVerdict.changesets.branchDetection']?.default).toBe(true);
  });
});

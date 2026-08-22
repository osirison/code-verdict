/**
 * GitLab's onboarding source-input grammar (handoff §4): its `/-/` path
 * separator, its `groups/` URL prefix and its numeric project ids. This lives
 * inside the provider because it is GitLab's grammar, not a neutral one —
 * GitHub has none of these forms. Pure string parsing; visibility lookups are
 * the connection's job.
 *
 * | Input                                  | Result                       |
 * | -------------------------------------- | ---------------------------- |
 * | `https://gitlab.com/hve/platform/core` | path (origin, `/-/…`, `.git` stripped) |
 * | `9102`                                 | id (repo, or group if it matches one) |
 * | `group 4821` / `…/groups/hve/platform` | group id / group path        |
 * | anything else                          | invalid — never silently add |
 */
export type SourceInputShape =
  | { shape: 'path'; path: string }
  | { shape: 'id'; id: string }
  | { shape: 'groupId'; id: string }
  | { shape: 'groupPath'; path: string }
  | { shape: 'invalid' };

export function parseSourceInput(raw: string): SourceInputShape {
  const input = raw.trim();
  if (input === '') return { shape: 'invalid' };

  if (/^\d+$/.test(input)) return { shape: 'id', id: input };

  const groupPrefix = input.match(/^group[:\s]+(\d+)$/i);
  if (groupPrefix) return { shape: 'groupId', id: groupPrefix[1] as string };

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { shape: 'invalid' };
    }
    let path: string;
    try {
      // User-entered input: malformed percent-encoding must not throw.
      path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    } catch {
      return { shape: 'invalid' };
    }
    if (path === '') return { shape: 'invalid' };

    if (path.startsWith('groups/')) {
      const groupPath = path.slice('groups/'.length).split('/-/')[0] ?? '';
      return groupPath === '' ? { shape: 'invalid' } : { shape: 'groupPath', path: groupPath };
    }

    path = path.split('/-/')[0] ?? path;
    path = path.replace(/\.git$/, '');
    return path === '' ? { shape: 'invalid' } : { shape: 'path', path };
  }

  // A bare path like `hve/platform/core` is accepted too — it is what the
  // URL form reduces to.
  if (/^[\w.-]+(\/[\w.-]+)+$/.test(input)) {
    return { shape: 'path', path: input.replace(/\.git$/, '') };
  }

  return { shape: 'invalid' };
}

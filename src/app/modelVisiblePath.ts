export interface ModelVisibleWorkspaceRoot {
  name: string;
  path: string;
  /** Canonical host URI used for ownership checks, never rendered to the model. */
  sourceUri?: string;
}

export interface LabelledWorkspaceRoot extends ModelVisibleWorkspaceRoot {
  label: string;
}

function slashPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function labelBase(root: ModelVisibleWorkspaceRoot): string {
  const pathName = slashPath(root.path).split('/').filter(Boolean).at(-1) ?? 'workspace';
  return (root.name.trim() || pathName).replace(/[\\/]+/g, '_');
}

/** Assign deterministic, globally distinct labels without depending on workspace-folder order. */
export function labelledWorkspaceRoots(
  roots: readonly ModelVisibleWorkspaceRoot[],
): LabelledWorkspaceRoot[] {
  const bases = roots.map(labelBase);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const used = new Set(bases.filter((base) => counts.get(base) === 1));
  const labels = new Map<string, string>();
  const duplicates = roots
    .map((root, index) => ({ root, index, base: bases[index] as string }))
    .filter(({ base }) => (counts.get(base) ?? 0) > 1)
    .sort((left, right) => slashPath(left.root.path).localeCompare(slashPath(right.root.path)));
  for (const duplicate of duplicates) {
    let suffix = 1;
    let candidate = `${duplicate.base}-${suffix}`;
    while (used.has(candidate)) candidate = `${duplicate.base}-${++suffix}`;
    used.add(candidate);
    labels.set(`${duplicate.index}`, candidate);
  }
  return roots.map((root, index) => ({
    ...root,
    label: labels.get(`${index}`) ?? bases[index] as string,
  }));
}

/** Normalize only representation, never resolve `..` supplied by an untrusted response. */
export function normalizeModelVisiblePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** Root qualification is present only when the workspace actually has multiple roots. */
export function modelVisiblePath(relativePath: string, rootLabel?: string): string {
  const relative = normalizeModelVisiblePath(relativePath).replace(/^\//, '');
  return rootLabel ? `${rootLabel}/${relative}` : relative;
}

export function modelVisibleRootLabelForUri(
  uriPath: string,
  roots: readonly ModelVisibleWorkspaceRoot[],
): string | undefined {
  if (roots.length <= 1) return undefined;
  const target = slashPath(uriPath);
  const owner = labelledWorkspaceRoots(roots)
    .filter((root) => target === slashPath(root.path) || target.startsWith(`${slashPath(root.path)}/`))
    .sort((left, right) => slashPath(right.path).length - slashPath(left.path).length)[0];
  return owner?.label;
}

export function modelVisiblePathForUri(
  uriPath: string,
  workspaceRelativePath: string,
  roots: readonly ModelVisibleWorkspaceRoot[],
): string {
  return modelVisiblePath(workspaceRelativePath, modelVisibleRootLabelForUri(uriPath, roots));
}

/** Resolve a reviewed repository to a root only when its name/path identifies exactly one root. */
export function modelVisibleRootLabelForProject(
  projectIdentifiers: readonly (string | undefined)[],
  roots: readonly ModelVisibleWorkspaceRoot[],
): string | undefined {
  if (roots.length <= 1) return undefined;
  const owner = workspaceRootForProject(projectIdentifiers, roots);
  if (!owner) return undefined;
  const ownerIndex = roots.indexOf(owner);
  return labelledWorkspaceRoots(roots)[ownerIndex]?.label;
}

/** Resolve repository identity to exactly one host workspace root. */
export function workspaceRootForProject(
  projectIdentifiers: readonly (string | undefined)[],
  roots: readonly ModelVisibleWorkspaceRoot[],
): ModelVisibleWorkspaceRoot | undefined {
  const names = new Set(projectIdentifiers.flatMap((value) => {
    if (!value) return [];
    const normalized = slashPath(value).toLocaleLowerCase();
    return [normalized, normalized.split('/').at(-1) ?? normalized];
  }));
  const matches = roots.filter((root) => {
    const path = slashPath(root.path).toLocaleLowerCase();
    return names.has(root.name.toLocaleLowerCase())
      || names.has(path)
      || names.has(path.split('/').at(-1) ?? path);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function providerRelativePath(path: string, rootLabel?: string): string {
  const normalized = normalizeModelVisiblePath(path);
  return rootLabel && normalized.startsWith(`${rootLabel}/`)
    ? normalized.slice(rootLabel.length + 1)
    : normalized;
}
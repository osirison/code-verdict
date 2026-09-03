import type {
  AttachmentTarget,
  FileAttachmentTarget,
  SymbolAttachmentTarget,
} from './attachments';
import type { Attachment, AttachmentKind, AttachmentRange } from './reviewContext';

export type ContextReference =
  | { raw: string; kind: 'file'; name: string; range?: AttachmentRange }
  | { raw: string; kind: 'symbol'; name: string };

export interface ContextReferenceResolution {
  attachments: Attachment[];
  unresolved: string[];
}

export type ContextReferenceCache = Map<string, Attachment | null>;

export interface ContextReferenceDeps {
  findFile(name: string): Promise<FileAttachmentTarget | undefined>;
  findSymbol(name: string): Promise<SymbolAttachmentTarget | undefined>;
  resolveAttachment(kind: AttachmentKind, target: AttachmentTarget): Promise<Attachment>;
}

/** Shares identical in-flight resolutions while allowing newer text to supersede older work. */
export class ContextReferenceResolutionCoordinator {
  private sequence = 0;
  private pending?: { text: string; promise: Promise<void> };

  invalidate(): void {
    this.sequence += 1;
    this.pending = undefined;
  }

  resolve(
    text: string,
    operation: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.pending?.text === text) return this.pending.promise;
    const sequence = ++this.sequence;
    const pending = { text, promise: Promise.resolve() };
    pending.promise = operation(() => sequence === this.sequence).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending.promise;
  }
}

const FILE_REFERENCE = /#file:([A-Za-z0-9_./\\-]+)(?::(\d+)-(\d+))?(?=$|[\s,;!?()[\]{}])/g;
const SYMBOL_REFERENCE = /#sym:([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)/g;

/** Parse attachment references without rewriting or consuming the instruction text. */
export function parseContextReferences(text: string): ContextReference[] {
  const references: Array<ContextReference & { index: number }> = [];
  for (const match of text.matchAll(FILE_REFERENCE)) {
    const startLine = match[2] === undefined ? undefined : Number(match[2]);
    const endLine = match[3] === undefined ? undefined : Number(match[3]);
    if (startLine !== undefined && endLine !== undefined && (startLine < 1 || endLine < startLine)) continue;
    const range = startLine !== undefined && endLine !== undefined && startLine >= 1 && endLine >= startLine
      ? { startLine, endLine }
      : undefined;
    references.push({
      raw: match[0],
      kind: 'file',
      name: match[1] ?? '',
      ...(range ? { range } : {}),
      index: match.index,
    });
  }
  for (const match of text.matchAll(SYMBOL_REFERENCE)) {
    references.push({
      raw: match[0],
      kind: 'symbol',
      name: match[1] ?? '',
      index: match.index,
    });
  }
  const seen = new Set<string>();
  return references
    .sort((left, right) => left.index - right.index)
    .filter((reference) => {
      if (seen.has(reference.raw)) return false;
      seen.add(reference.raw);
      return true;
    })
    .map(({ index: _index, ...reference }) => reference);
}

/** Resolve parsed references through the same attachment resolver used by the picker. */
export async function resolveContextReferences(
  text: string,
  deps: ContextReferenceDeps,
  cache?: ContextReferenceCache,
): Promise<ContextReferenceResolution> {
  const attachments: Attachment[] = [];
  const unresolved: string[] = [];
  for (const reference of parseContextReferences(text)) {
    const cached = cache?.get(reference.raw);
    if (cached) {
      attachments.push(cached);
      continue;
    }
    if (cached === null) {
      unresolved.push(reference.raw);
      continue;
    }
    try {
      if (reference.kind === 'symbol') {
        const target = await deps.findSymbol(reference.name);
        if (!target) {
          unresolved.push(reference.raw);
          cache?.set(reference.raw, null);
          continue;
        }
        const attachment = await deps.resolveAttachment('symbol', target);
        cache?.set(reference.raw, attachment);
        attachments.push(attachment);
        continue;
      }
      const target = await deps.findFile(reference.name);
      if (!target) {
        unresolved.push(reference.raw);
        cache?.set(reference.raw, null);
        continue;
      }
      const attachment = await deps.resolveAttachment(
        reference.range ? 'selection' : 'file',
        reference.range ? { ...target, range: reference.range } : target,
      );
      cache?.set(reference.raw, attachment);
      attachments.push(attachment);
    } catch {
      unresolved.push(reference.raw);
      cache?.set(reference.raw, null);
    }
  }
  return { attachments, unresolved };
}

/** Persist changed instructions, then always resolve the exact text carried by Run. */
export async function prepareContextReferencesForRun(
  instructions: string,
  persistedInstructions: string,
  persist: (instructions: string) => Promise<void>,
  resolve: (instructions: string) => Promise<void>,
): Promise<void> {
  if (instructions !== persistedInstructions) await persist(instructions);
  await resolve(instructions);
}
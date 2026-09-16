/**
 * The per-turn prompt budget's arithmetic and its words.
 *
 * What is checked here is the part that has to be right before any of the wiring matters: that the
 * ceiling and the content allowance are two different numbers and stay that way, that a request is
 * admitted, deferred or refused outright on the correct one of them, and that the sentences the
 * model reads actually carry the figures it needs to choose again. The wiring — measuring a real
 * prompt, declining a real dispatch, holding the ceiling across a whole review — is
 * `../app/harnessModelSeam.test.ts` and `../app/harnessPromptBudget.assurance.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  admitContent,
  describeDeferral,
  describeExceedsAllowance,
  describeFramingOverrun,
  describePromptBudget,
  formatApproximateBytes,
  formatExactBytes,
  resolvePromptBudget,
} from './harnessPromptBudget';

describe('the two numbers', () => {
  it('subtracts the measured framing from the ceiling — never a fixed margin', () => {
    // The measured floor on a real review: 55 KB of prompt with zero tool-result bytes in it.
    const budget = resolvePromptBudget(196_608, 56_320);
    expect(budget.ceilingBytes).toBe(196_608);
    expect(budget.contentAllowanceBytes).toBe(196_608 - 56_320);
    expect(budget.framingOverrunBytes).toBe(0);
  });

  it('reports a framing that does not fit rather than pretending there is room', () => {
    const budget = resolvePromptBudget(100_000, 130_000);
    expect(budget.contentAllowanceBytes).toBe(0);
    expect(budget.framingOverrunBytes).toBe(30_000);
  });

  it('names both numbers and says which is which, so 140,196 cannot be read as a typo for 196,608', () => {
    const text = describePromptBudget(resolvePromptBudget(196_608, 56_412));
    expect(text).toContain('196,608');
    expect(text).toContain('140,196');
    expect(text).toContain('content allowance');
    expect(text).toContain('It is not the cap');
  });
});

describe('admitting one more result', () => {
  const allowanceBytes = 140_000;
  const exact = (bytes: number) => ({ kind: 'exact' as const, bytes });
  const atMost = (bytes: number) => ({ kind: 'atMost' as const, bytes });
  const unknown = { kind: 'unknown' as const };
  /**
   * The two cost inputs default to zero here so every case below reads as what it is about — the
   * room arithmetic — and the cases that are about the overhead and the reservation pass them
   * explicitly. Zero is also the honest default for the shapes that have neither: a turn whose
   * model sent no submissions reserves nothing, and `TurnContentBudget.overheadBytes` is a
   * measurement the caller supplies rather than a constant this module believes in.
   */
  const admit = (input: Parameters<typeof admitContent>[0] extends infer T ? Omit<T & object, 'overheadBytes' | 'reservedBytes'> & { overheadBytes?: number; reservedBytes?: number } : never) =>
    admitContent({ overheadBytes: 0, reservedBytes: 0, ...input });

  it('serves a known result that fits what is left', () => {
    expect(admit({ estimate: exact(20_000), remainingBytes: 60_000, allowanceBytes })).toEqual({ kind: 'serve' });
  });

  it('defers a known result larger than what is left, naming both numbers', () => {
    const admission = admit({ estimate: exact(47_000), remainingBytes: 12_000, allowanceBytes });
    expect(admission).toEqual({ kind: 'defer', knownBytes: 47_000, remainingBytes: 12_000, sizeIsUpperBound: false });
    const reason = describeDeferral({ knownBytes: 47_000, remainingBytes: 12_000, allowanceBytes });
    expect(reason).toContain('47,000');
    expect(reason).toContain('12,000');
    expect(reason).toContain('140,000');
    // The two facts that make it re-requestable rather than a dead end.
    expect(reason).toContain('nothing was spent');
    expect(reason).toContain('again next turn');
  });

  it('defers anything at all once nothing is left, including a result whose size it cannot know', () => {
    expect(admit({ estimate: unknown, remainingBytes: 0, allowanceBytes }).kind).toBe('defer');
    expect(admit({ estimate: unknown, remainingBytes: -5_000, allowanceBytes }).kind).toBe('defer');
  });

  it('serves a result with no byte bound at all while room remains — a details page is bounded by entries, not bytes', () => {
    expect(admit({ estimate: unknown, remainingBytes: 60_000, allowanceBytes })).toEqual({ kind: 'serve' });
  });

  it('reserves a page-bounded result its whole bound, so nothing is fetched that the turn cannot show', () => {
    // The search whose real size nobody knows until it answers. 64 KB of bound against 12 KB of
    // room used to be served anyway and dropped at assembly — evidence fetched, charged, unseen.
    const admission = admit({ estimate: atMost(64 * 1024), remainingBytes: 12_000, allowanceBytes });
    expect(admission).toEqual({ kind: 'defer', knownBytes: 64 * 1024, remainingBytes: 12_000, sizeIsUpperBound: true });
    // And the words say "may return up to", never "is about": the bound is a reservation, not a
    // measurement, and a model told the wrong one orders its next turn on a fiction.
    expect(describeDeferral({ knownBytes: 64 * 1024, remainingBytes: 12_000, allowanceBytes, sizeIsUpperBound: true })).toContain('may return up to 65,536 bytes');
    // Room for the whole bound and it goes straight out.
    expect(admit({ estimate: atMost(64 * 1024), remainingBytes: 100_000, allowanceBytes }).kind).toBe('serve');
  });

  it('serves any bound at all on a turn nothing has touched yet, because there is no room to protect', () => {
    // `diffOrFileReadPageBytes` is 256 KB at the shipped defaults, above a whole turn's allowance.
    // Without this rule a `readFile` would be deferred on every turn forever.
    expect(admit({ estimate: atMost(256 * 1024), remainingBytes: allowanceBytes, allowanceBytes }).kind).toBe('serve');
    // One byte spent and the reservation binds again.
    expect(admit({ estimate: atMost(256 * 1024), remainingBytes: allowanceBytes - 1, allowanceBytes }).kind).toBe('defer');
  });

  it('never calls an upper bound terminal, however large — only a size the host actually knows', () => {
    // A bound is what the request cannot exceed, not what it will be. Refusing a search forever on
    // a 256 KB page bound would remove the tool from every review at the shipped defaults.
    expect(admit({ estimate: atMost(900_000), remainingBytes: 10, allowanceBytes }).kind).toBe('defer');
  });

  it('refuses outright — never defers — a file larger than the whole allowance, because the allowance only shrinks', () => {
    // Deferring it would produce the identical refusal on every later turn: the ping-pong the
    // design forbids. The caller turns this into a terminal `tooLarge`.
    const admission = admit({ estimate: exact(300_000), remainingBytes: 140_000, allowanceBytes });
    expect(admission).toEqual({ kind: 'exceedsAllowance', knownBytes: 300_000, allowanceBytes });
    // And it is decided on the whole allowance, not what is left: a full turn answers the same way.
    expect(admit({ estimate: exact(300_000), remainingBytes: allowanceBytes, allowanceBytes }).kind).toBe('exceedsAllowance');
  });

  it('charges a result the overhead its envelope and map line really cost, not just its content', () => {
    // The measured defect, in one pair of assertions. A 50,000-byte diff with 50,200 bytes of room
    // used to be served, and the assembled prompt came out 255 bytes over the cap with the read
    // already marked inspected. The overhead the caller measured from this same turn's previous
    // result is what makes the second call answer honestly.
    expect(admit({ estimate: exact(50_000), remainingBytes: 50_200, allowanceBytes })).toEqual({ kind: 'serve' });
    expect(admit({ estimate: exact(50_000), remainingBytes: 50_200, allowanceBytes, overheadBytes: 455 })).toEqual({
      kind: 'defer',
      knownBytes: 50_000,
      remainingBytes: 49_745,
      sizeIsUpperBound: false,
    });
  });

  it('reports the room left as room for content, so the model can check it against the size column it was shown', () => {
    // The numbers in the sentence are the model's own units. Telling a model its 50,000-byte file
    // needed 50,455 bytes would contradict the map line the same prompt printed for that file.
    const admission = admit({ estimate: exact(50_000), remainingBytes: 50_200, allowanceBytes, overheadBytes: 455 });
    expect(admission.kind === 'defer' && admission.knownBytes).toBe(50_000);
    expect(admission.kind === 'defer' && admission.remainingBytes).toBe(49_745);
  });

  it('holds room back for submissions the same turn has not dispatched yet', () => {
    // Eight findings sent in the same message list as a read. They are never deferred — the work
    // is done — so the read is what has to yield. Without the reservation the turn assembled
    // 120,2xx bytes against a 120,000-byte cap.
    expect(admit({ estimate: exact(100_000), remainingBytes: 105_000, allowanceBytes }).kind).toBe('serve');
    expect(admit({ estimate: exact(100_000), remainingBytes: 105_000, allowanceBytes, reservedBytes: 8 * 1024 }).kind).toBe('defer');
  });

  it('keeps a reservation out of the terminal test, because a reservation belongs to one turn and a terminal refusal to the whole attempt', () => {
    // Same file, same allowance: deferred while this turn is committed elsewhere, and never
    // declared unservable on that basis — next turn has the whole allowance again.
    expect(admit({ estimate: exact(139_000), remainingBytes: allowanceBytes, allowanceBytes, reservedBytes: 8 * 1024 }).kind).toBe('defer');
    // The overhead, by contrast, is part of it: a file that cannot fit *with* its envelope cannot
    // be served on any turn, so it is refused terminally rather than deferred forever.
    expect(admit({ estimate: exact(139_800), remainingBytes: allowanceBytes, allowanceBytes, overheadBytes: 1024 })).toEqual({
      kind: 'exceedsAllowance',
      knownBytes: 139_800,
      allowanceBytes: 138_976,
    });
  });

  it('does not waive a size it knows on an untouched turn, so a read cannot outrun this turn\'s own commitments', () => {
    // The waiver exists for a bound nobody can measure (`diffOrFileReadPageBytes` is above a whole
    // turn's allowance). An exact size needs no waiver — it either fits or it does not — and
    // waiving it was how a 109,000-byte read went out on a turn that then submitted eight
    // findings. With nothing reserved the answer is unchanged.
    expect(admit({ estimate: exact(100_000), remainingBytes: allowanceBytes, allowanceBytes }).kind).toBe('serve');
    expect(admit({ estimate: atMost(256 * 1024), remainingBytes: allowanceBytes, allowanceBytes, reservedBytes: 8 * 1024 }).kind).toBe('serve');
  });

  it('tells the model that refusal is terminal and names the dial that would change it', () => {
    const reason = describeExceedsAllowance({ knownBytes: 300_000, allowanceBytes, ceilingBytes: 196_608 });
    expect(reason).toContain('300,000');
    expect(reason).toContain('140,000');
    expect(reason).toContain('No turn of this attempt can carry it');
    expect(describeFramingOverrun(resolvePromptBudget(196_608, 210_000))).toContain('codeVerdict.harness.maxPromptKilobytesPerTurn');
  });
});

describe('the figures as the model reads them', () => {
  it('groups the digits of an exact byte count', () => {
    expect(formatExactBytes(196_608)).toBe('196,608');
    expect(formatExactBytes(-1)).toBe('0');
  });

  it('rounds the map column to whole kilobytes and never prints a 0KB that could be read as unknown', () => {
    expect(formatApproximateBytes(47_104)).toBe('46KB');
    expect(formatApproximateBytes(12)).toBe('1KB');
    expect(formatApproximateBytes(0)).toBe('0KB');
  });
});

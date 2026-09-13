/**
 * The per-turn prompt byte budget: its two numbers, the arithmetic that keeps them apart, and the
 * exact words the model is told them in.
 *
 * **Why this exists, measured.** Prompt size was unbounded. Across one 40-call review against this
 * product's own 207-file change the assembled prompt swung between 55 KB and 426 KB, growing 21
 * times and shrinking 18 — it is rebuilt every turn rather than accumulated, so its size is decided
 * entirely by how much content the previous turn's tool calls returned. Two runs on a local model
 * died of it: 287 KB produced no output at all in 300 seconds, while the same model answered
 * 57-150 KB prompts in 90-280 seconds. Copilot absorbed 262 KB in 48 seconds, so this is not a
 * universal limit — but nothing in the harness promised anything about it either way.
 *
 * **Two numbers, and they must never be confused.**
 *
 * - The **ceiling** (`HarnessPolicy.maxPromptBytesPerTurn`) is on the assembled prompt: every byte
 *   a model is handed, framing and tool results together. That is the guarantee, and
 *   `../app/harnessModelSeam.ts`'s `sealPrompt` is the one gate every send goes through — a
 *   `runTurn` accepts only text that has been through it, so no path can assemble around it.
 * - The **content allowance** is what the model is told it may ask for. It is the ceiling minus
 *   everything else already composed for *that* turn, and it is not a constant: the smallest
 *   prompt in the measured review was 55 KB with zero tool-result bytes in it (27 KB of it the
 *   change-request description alone), and the investigation map grows as files are read. We
 *   assemble the prompt, so this is computed from the real bytes — never a hard-coded margin.
 *
 * Announcing the ceiling as if it were the allowance over-promises by at least 55 KB and breaches
 * on every large turn, which is why `describePromptBudget` below names both numbers and says which
 * is which.
 *
 * Pure and dependency-free like the rest of `src/domain`: it takes byte counts and returns byte
 * counts and strings. Whoever knows how to render a prompt does the measuring
 * (`../app/harnessModelSeam.ts`), and whoever dispatches tools does the serving
 * (`../app/harnessAttempt.ts`).
 */

export interface PromptBudget {
  /** `HarnessPolicy.maxPromptBytesPerTurn` — the cap on the whole assembled prompt. */
  readonly ceilingBytes: number;
  /** Everything in this turn's prompt that is not a tool result: persona, catalog, contract, map, phase framing. */
  readonly framingBytes: number;
  /** What the model may request: `ceilingBytes - framingBytes`, floored at 0. */
  readonly contentAllowanceBytes: number;
  /** How far the framing alone overshoots the ceiling; 0 when it fits. Non-zero is a condition to report, never to paper over. */
  readonly framingOverrunBytes: number;
}

export function resolvePromptBudget(ceilingBytes: number, framingBytes: number): PromptBudget {
  const slack = ceilingBytes - framingBytes;
  return {
    ceilingBytes,
    framingBytes,
    contentAllowanceBytes: Math.max(0, slack),
    framingOverrunBytes: Math.max(0, -slack),
  };
}

/**
 * How big the host believes one pending result will be, and how sure it is.
 *
 * The distinction is the whole point. `exact` is a number the host already holds — a whole-file
 * `readDiff`'s size is in the manifest — and it can therefore decide that a file is too big for
 * *any* turn. `atMost` is a ceiling the request cannot exceed even though its real size is
 * unknown: a search page is bounded by `searchResultPageBytes`, a file or cursored read by
 * `diffOrFileReadPageBytes`. `unknown` is the honest answer for everything else — a details
 * section, a manifest page, a resolved policy — whose pages are bounded by entry counts rather
 * than bytes and which are small in practice.
 *
 * An `atMost` bound is a reservation, never a claim, so it may only ever *defer*; a result whose
 * true size nobody knows must not be declared permanently unservable on a bound it would probably
 * have come in far under.
 */
export type ContentSizeEstimate =
  | { readonly kind: 'exact'; readonly bytes: number }
  | { readonly kind: 'atMost'; readonly bytes: number }
  | { readonly kind: 'unknown' };

/**
 * What one more tool result may do to a turn that is already part-served.
 *
 * **Content bytes are not the whole cost, and treating them as if they were is what dropped
 * already-fetched evidence.** A result costs the prompt its content *plus* its rendered envelope
 * (`[result N] tool=readDiff … sourceId= digest= (CITABLE)`) *plus* the investigation-map line
 * flipping from `not read` to `read` and gaining the held source id. Driven through the real
 * runtime on a two-file review at a 120,000-byte cap, that difference measured 455 bytes, and a
 * second read anywhere in the 455-byte window above the true fit was fetched, charged, and then
 * removed by the renderer — with the file marked inspected regardless. `overheadBytes` is that
 * cost, measured by the caller from this same turn's own results rather than guessed here, and
 * `reservedBytes` is what the rest of this turn has already committed to spend (candidate
 * submissions the model sent in the same message list, which used to be dispatched with no
 * accounting at all and widened the window to ~2,200 bytes).
 *
 * Both are subtracted from the room, never added to the reported size: every number this returns
 * for the model to read is the *content* figure the model can act on — "your diff is 50,000 bytes"
 * — because a model told its 50,000-byte file is 50,455 bytes cannot check that against the size
 * column it was shown.
 *
 * **`exceedsAllowance` is terminal, and only an `exact` size may reach it.** It is measured
 * against the *whole* allowance, not what is left, because a file larger than the whole allowance
 * can never be served in any turn: the allowance only shrinks as the map grows. Serving it in
 * order would produce an over-ceiling prompt; deferring it would produce the same refusal next
 * turn and the turn after — the ping-pong this budget must not create. `../app/harnessAttempt.ts`
 * answers it with a terminal `tooLarge`, which is the state the inventory already has for "too big
 * to read" and which the investigation map already renders as a file never to ask for again.
 * `reservedBytes` is deliberately *not* part of that test: a reservation belongs to this turn, and
 * a file refused terminally is refused for the whole attempt.
 *
 * **An untouched turn serves a request whose size nobody knows.** Once nothing has consumed any of
 * the allowance — `remainingBytes >= allowanceBytes` — an `atMost` or `unknown` request goes out
 * whatever its bound says. Without that rule a `readFile` (bounded at `diffOrFileReadPageBytes`,
 * which the shipped defaults set *above* a whole turn's allowance) could never be served at all,
 * and the model would re-ask it forever. An `exact` size is deliberately excluded from the waiver:
 * the host knows what that result weighs, so there is nothing to waive, and before this exclusion
 * a turn that opened with a 109,000-byte read and then submitted eight findings served the read on
 * the waiver and pushed the prompt 200 bytes past the cap. Excluding it changes nothing when no
 * reservation is pending — an exact size at or under the allowance fits an untouched turn by
 * definition — and defers exactly the case the reservation exists for.
 *
 * This is what closes the last way a paid-for result could be dropped at assembly. Serving an
 * unpredictable request whenever a single byte was left, and letting the renderer drop it if it
 * overshot, meant fetching evidence, spending it against the attempt's evidence budget, and then
 * showing the model none of it.
 */
export type ContentAdmission =
  | { readonly kind: 'serve' }
  | { readonly kind: 'defer'; readonly knownBytes: number; readonly remainingBytes: number; readonly sizeIsUpperBound: boolean }
  | { readonly kind: 'exceedsAllowance'; readonly knownBytes: number; readonly allowanceBytes: number };

export function admitContent(input: {
  readonly estimate: ContentSizeEstimate;
  /** `ceiling - the assembled prompt as it stands with everything served so far`, and genuinely negative once a turn has overshot. */
  readonly remainingBytes: number;
  /** The whole content allowance for this turn, measured before anything was served. */
  readonly allowanceBytes: number;
  /** What one result costs the prompt beyond its own content — envelope plus map transition. Measured by the caller from this turn's own results; see this function's own doc comment. */
  readonly overheadBytes: number;
  /** Bytes this turn has already committed to but not yet spent — the candidate submissions still ahead of this request in the same message list. */
  readonly reservedBytes: number;
}): ContentAdmission {
  const { estimate, remainingBytes, allowanceBytes } = input;
  const overheadBytes = Math.max(0, input.overheadBytes);
  const reservedBytes = Math.max(0, input.reservedBytes);
  // Room for *content*, which is the only figure the model is ever shown: the envelope and the map
  // line are the host's own cost of carrying the result and are nothing the model can shrink.
  const contentAllowance = allowanceBytes - overheadBytes;
  const contentRemaining = remainingBytes - overheadBytes - reservedBytes;
  if (estimate.kind === 'exact' && estimate.bytes > contentAllowance) {
    return { kind: 'exceedsAllowance', knownBytes: estimate.bytes, allowanceBytes: Math.max(0, contentAllowance) };
  }
  if (estimate.kind !== 'exact' && remainingBytes >= allowanceBytes && contentRemaining > 0) return { kind: 'serve' };
  const sizeIsUpperBound = estimate.kind === 'atMost';
  if (contentRemaining <= 0) {
    return { kind: 'defer', knownBytes: estimate.kind === 'unknown' ? 0 : estimate.bytes, remainingBytes: Math.max(0, contentRemaining), sizeIsUpperBound };
  }
  if (estimate.kind !== 'unknown' && estimate.bytes > contentRemaining) {
    return { kind: 'defer', knownBytes: estimate.bytes, remainingBytes: contentRemaining, sizeIsUpperBound };
  }
  return { kind: 'serve' };
}

// ---- Words ---------------------------------------------------------------------------

/** Grouped digits, so a six-figure byte count reads as one number rather than a smear. */
export function formatExactBytes(bytes: number): string {
  return Math.max(0, Math.round(bytes)).toLocaleString('en-US');
}

/**
 * The investigation map's size column: whole kilobytes, because the decision it feeds is "do eight
 * of these fit in 140 KB" and a byte-exact figure spends four more characters per line saying
 * nothing that changes the answer. A non-empty diff never prints `0KB` — a file whose size is
 * known to be small is still a file, and `0KB` reads as "unknown".
 */
export function formatApproximateBytes(bytes: number): string {
  if (bytes <= 0) return '0KB';
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * The budget section of the prompt, rendered only when the budget can actually bind (see
 * `renderModelPrompt`): a review whose whole unread diff fits the allowance is told nothing,
 * costs nothing, and stays byte-identical to what it was before this existed.
 *
 * Both numbers are named as what they are. A model told "you have 140,196 bytes" with a 196,608
 * setting visible elsewhere would reasonably read the smaller number as a mistake; the sentence
 * that separates them is the whole point of the section.
 */
export function describePromptBudget(budget: PromptBudget): string {
  return [
    '## This turn\'s size budget',
    `The whole prompt is capped at ${formatExactBytes(budget.ceilingBytes)} bytes. Everything in it`,
    `that is not a tool result — persona, host tools, protocol, the map above, this`,
    `turn's framing — costs ${formatExactBytes(budget.framingBytes)} of them, so the results of the tools you`,
    `request now may total at most ${formatExactBytes(budget.contentAllowanceBytes)} bytes. That second number is your`,
    'content allowance. It is not the cap, and it shrinks as the map grows.',
    'The KB figure beside an unread file is the exact size of the diff readDiff',
    'returns for it. Choose a set that fits: requests past the allowance are not',
    'served this turn, cost nothing, and stay available to ask for again.',
  ].join('\n');
}

/**
 * The reason on a request the budget deferred — the numbers included, so the next turn's choice
 * needs no round trip to calibrate.
 *
 * `sizeIsUpperBound` changes "is about N bytes" to "may return up to N bytes", because for a
 * search or a file read that number is the room reserved for it, not a measurement of it. Saying
 * "about" there would tell the model a 64 KB search result is waiting when the real page might be
 * 300 bytes, and the sentence's whole job is to let the model order its next turn correctly.
 */
export function describeDeferral(input: { readonly knownBytes: number; readonly remainingBytes: number; readonly allowanceBytes: number; readonly sizeIsUpperBound?: boolean }): string {
  const size =
    input.knownBytes <= 0
      ? 'Only '
      : input.sizeIsUpperBound
        ? `This result may return up to ${formatExactBytes(input.knownBytes)} bytes and only `
        : `This result is about ${formatExactBytes(input.knownBytes)} bytes and only `;
  return `Not served this turn: ${size}${formatExactBytes(input.remainingBytes)} bytes of this turn's ${formatExactBytes(input.allowanceBytes)}-byte content allowance were left. Nothing was read and nothing was spent — request it again next turn, when the whole allowance is free.`;
}

/** The reason on a file no turn can serve — stated as terminal, and naming the dial that would change that. */
export function describeExceedsAllowance(input: { readonly knownBytes: number; readonly allowanceBytes: number; readonly ceilingBytes: number }): string {
  return `This file's diff is about ${formatExactBytes(input.knownBytes)} bytes, larger than this turn's whole content allowance of ${formatExactBytes(input.allowanceBytes)} bytes (the prompt cap is ${formatExactBytes(input.ceilingBytes)}). No turn of this attempt can carry it, so it will not be served however it is asked for. Review the rest of the change and say in a finding or rationale that this file went unread.`;
}

/**
 * The line the prompt carries when the renderer itself had to drop results to hold the ceiling.
 *
 * This is the backstop, not the normal path — `harnessAttempt.ts` serves in request order against
 * the same allowance, charges each result its real envelope and map-line cost, and defers before
 * dispatching, so nothing is fetched that will not be shown. Reaching here means a size nothing
 * could have predicted (a provider that returned more than its own page bound or its own manifest
 * entry) or bytes added after the decision (a protocol repair instruction). It is stated to the
 * model and reported to the host as a defect rather than silently truncating the content, which is
 * the failure this whole budget exists to remove.
 *
 * The sentence says the file counts as unread because it does: a dropped `readDiff` has its
 * inspection and its ledger entry revoked (`harnessAttempt.ts`'s `withholdEvidence`), so the map
 * from the next turn on lists it as work still to do, and the completion gate refuses to call the
 * review complete over it. Telling the model only "ask again, fewer at a time" while the same
 * prompt's map said `read` was the contradiction that let a review finish over unread code.
 */
export function describeDroppedResults(droppedCount: number, ceilingBytes: number): string {
  return `(${droppedCount} result(s) from your previous turn are not shown: including them would have pushed this prompt past its ${formatExactBytes(ceilingBytes)}-byte cap. Nothing was read from them — the files they cover still count as unread and their evidence is not citable. Those requests remain available: ask for them again, fewer at a time.)`;
}

/** Reported when even an empty-result prompt is over the ceiling: nothing can be dropped, so the run says so. */
export function describeFramingOverrun(budget: PromptBudget): string {
  return `This review's own framing needs ${formatExactBytes(budget.framingBytes)} bytes per turn, ${formatExactBytes(budget.framingOverrunBytes)} over the ${formatExactBytes(budget.ceilingBytes)}-byte prompt cap, so no turn has room for any tool result at all. Raise codeVerdict.harness.maxPromptKilobytesPerTurn above ${Math.ceil(budget.framingBytes / 1024)} KB, or review a change request with a shorter description.`;
}

import type { ReviewItem } from '../domain/types';

export type AskPreset = 'explain' | 'fix' | 'similar' | 'why' | 'freeform';

const PRESET_QUESTION: Record<Exclude<AskPreset, 'freeform'>, string> = {
  explain: 'Explain the concrete risk this finding describes. What goes wrong, and under what conditions?',
  fix: 'Show the smallest change that removes this problem. Give the code, and say what it changes.',
  similar: 'Where else in this diff does the same problem appear? Quote each occurrence, or say none.',
  why: 'Why was this flagged at this severity and confidence? Say what would make it more or less serious.',
};

export function followUpQuestion(preset: AskPreset, text?: string): string {
  return preset === 'freeform' ? (text ?? '').trim() : PRESET_QUESTION[preset];
}

export function findingFollowUpPrompt(
  item: ReviewItem,
  question: string,
  hunk: string | undefined,
): string {
  return [
    'You are answering a reviewer\'s follow-up question about a single code review finding.',
    'Answer in plain prose, at most two short paragraphs. No JSON, no preamble.',
    '',
    `Finding: ${item.title}`,
    `Severity: ${item.severity} · confidence ${item.confidence}`,
    `Location: ${item.file}:${item.line}`,
    `Detail: ${item.body}`,
    item.code ? `Flagged code:\n${item.code}` : '',
    hunk ? `Surrounding diff:\n${hunk}` : '',
    '',
    `Question: ${question}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
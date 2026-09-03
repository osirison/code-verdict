import { describe, expect, it } from 'vitest';
import { CONTEXT_PICKER_CHOICES, CONTEXT_PICKER_PLACEHOLDER } from './contextPicker';

describe('context attachment picker', () => {
  it('uses the exact placeholder and offers every resolver kind', () => {
    expect(CONTEXT_PICKER_PLACEHOLDER).toBe('Search attachments');
    expect(CONTEXT_PICKER_CHOICES.map((choice) => choice.attachmentKind)).toEqual([
      'file', 'folder', 'selection', 'symbol', 'problems', 'pasted',
    ]);
  });
});
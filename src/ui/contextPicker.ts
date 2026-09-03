import type { AttachmentKind } from '../app/reviewContext';

export const CONTEXT_PICKER_PLACEHOLDER = 'Search attachments';

export interface ContextPickerChoice {
  attachmentKind: AttachmentKind;
  label: string;
  description: string;
}

export const CONTEXT_PICKER_CHOICES: readonly ContextPickerChoice[] = [
  { attachmentKind: 'file', label: 'File', description: 'Attach one workspace file' },
  { attachmentKind: 'folder', label: 'Folder', description: 'Attach readable files from one folder' },
  { attachmentKind: 'selection', label: 'Current editor selection', description: 'Attach only the selected lines' },
  { attachmentKind: 'symbol', label: 'Symbol', description: 'Attach a workspace symbol definition' },
  { attachmentKind: 'problems', label: 'Problems', description: 'Attach current diagnostics' },
  { attachmentKind: 'pasted', label: 'Pasted text', description: 'Attach text from the clipboard' },
];
/**
 * The 19 `Verdict:` commands, as specified in
 * `spec/specs/Code Verdict - naming & commands.md`. package.json must
 * contribute exactly this set — enforced by commands.test.ts.
 */
export const COMMANDS = {
  runReview: 'codeVerdict.runReview',
  openDashboard: 'codeVerdict.openDashboard',
  openReview: 'codeVerdict.openReview',
  nextItem: 'codeVerdict.nextItem',
  prevItem: 'codeVerdict.prevItem',
  acceptItem: 'codeVerdict.acceptItem',
  acceptItemApplyFix: 'codeVerdict.acceptItemApplyFix',
  rejectItem: 'codeVerdict.rejectItem',
  skipItem: 'codeVerdict.skipItem',
  askAgent: 'codeVerdict.askAgent',
  generateSummary: 'codeVerdict.generateSummary',
  submitReview: 'codeVerdict.submitReview',
  selectAgent: 'codeVerdict.selectAgent',
  editCriteria: 'codeVerdict.editCriteria',
  newPod: 'codeVerdict.newPod',
  switchPod: 'codeVerdict.switchPod',
  addProject: 'codeVerdict.addProject',
  refresh: 'codeVerdict.refresh',
  signIn: 'codeVerdict.signIn',
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS: readonly CommandId[] = Object.values(COMMANDS);

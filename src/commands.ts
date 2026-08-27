/**
 * The 21 `Verdict:` commands, as specified in
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
  deletePod: 'codeVerdict.deletePod',
  addProject: 'codeVerdict.addProject',
  refresh: 'codeVerdict.refresh',
  signIn: 'codeVerdict.signIn',
  showApiTrace: 'codeVerdict.showApiTrace',
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

export const ALL_COMMAND_IDS: readonly CommandId[] = Object.values(COMMANDS);

/**
 * Commands the naming doc's 21-command table does not reserve a palette entry
 * for. They are registered at runtime and reachable from keybindings, menus
 * and other screens — never contributed to `contributes.commands`, so the
 * palette keeps showing exactly the specified 21.
 */
export const INTERNAL_COMMANDS = {
  postedReviews: 'codeVerdict.internal.postedReviews',
  /** `⇧A` — accept without applying the agent's suggested diff. */
  acceptCommentOnly: 'codeVerdict.internal.acceptCommentOnly',
  /** `U` — take the verdict back off the current item. */
  undoVerdict: 'codeVerdict.internal.undoVerdict',
  /** `1`–`4` — jump to the first undecided item of a severity. */
  jumpSeverity: 'codeVerdict.internal.jumpSeverity',
  /** `?` — the keyboard overlay, from the status bar or the keybinding. */
  keyboardHelp: 'codeVerdict.internal.keyboardHelp',
  /** The status bar's `🔔 n` segment — list what is waiting, then clear it. */
  showNotifications: 'codeVerdict.internal.showNotifications',
} as const;

export type InternalCommandId = (typeof INTERNAL_COMMANDS)[keyof typeof INTERNAL_COMMANDS];

export const ALL_INTERNAL_COMMAND_IDS: readonly InternalCommandId[] =
  Object.values(INTERNAL_COMMANDS);

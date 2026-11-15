/**
 * Every frozen string in the app. No variants, no per-screen rewording.
 */

export const copy = {
  // Primary actions, exactly as specified.
  accept: 'Accept response',
  depart: 'Depart to scene',
  arrive: 'Mark on scene',
  complete: 'Complete response',

  // Secondary actions.
  navigate: 'Navigate',
  reportIssue: 'Report issue',
  requestBackup: 'Request backup',
  refresh: 'Refresh',
  settings: 'Settings',
  back: 'Back',
  close: 'Close',

  // Sending and conflict states.
  sending: 'Sending…',
  sendingRetry: 'Sending… retrying',
  updatedByDispatch: 'Updated by dispatch',
  reassigned: 'This response was reassigned',
  noLongerExists: 'This response no longer exists',

  // Pairing.
  unitCodePlaceholder: 'Unit code',
  pairHeading: 'Pair this unit',
  pairBody:
    'Enter the unit code dispatch issued for this vehicle. It is checked against dispatch before anything is stored on this device.',
  connect: 'Connect this unit',
  invalidUnitCode: "That unit code wasn't accepted",
  networkError: "Can't reach dispatch. Check the connection.",
  unitCodeExpired: 'This unit code is no longer valid.',

  // Home and queue.
  noActiveAssignment: 'No active assignment. Stay available.',
  noOtherResponses: 'No other responses for this unit.',
  contactingDispatch: 'Contacting dispatch…',

  // Acknowledgements. Backup wording is fixed by the service specification.
  dispatchNotified: 'Dispatch notified.',
  backupNotified: 'Dispatch has been notified.',

  // Offline banner.
  noConnection: 'No connection to dispatch',
  notSentYet: 'not sent yet',
  deliveryUnconfirmed: 'delivery not confirmed',
  lastUpdated: 'Last updated',

  // Sheets.
  completeConfirmTitle: 'Close this response?',
  completeConfirmBody: 'Dispatch will see it completed.',
  cancel: 'Cancel',
  reportIssueTitle: 'Report issue',
  reportIssueHint: 'Dispatch is notified. This response keeps its current status.',
  describeIssue: 'Describe the issue',
  describeIssuePlaceholder: 'What is stopping you?',
  backupTitle: 'Request backup',
  backupBody:
    'Dispatch receives a backup request for this response. Allocation is their decision, and this response keeps its current status.',
  backupNotePlaceholder: 'Optional note for dispatch',
  unpairTitle: 'Unpair this device',
  unpairBody: 'This clears the unit code and every queued update on this device.',
  unpair: 'Unpair this device',
  copyDestination: 'Copy destination',
  destinationCopied: 'Destination copied.',
  internalError: 'Internal error while sending this update.',
  illegalTransition: 'That action is not allowed from this state.',
  queueFull: 'The queue is full. Reconnect before taking another action.',
  noMapApp: 'No map app is available. Copy the destination instead.',
  noCoordinates: 'Dispatch has not sent coordinates for this response.',
  tripGone: 'This response is no longer on this unit.',

  // Settings labels.
  callSign: 'Call sign',
  vehicle: 'Vehicle',
  dispatchHost: 'Dispatch host',
  lastSync: 'Last sync',
  pendingUpdates: 'Pending updates',
  appVersion: 'App version',
  notSynced: 'Not synced yet',
  notPaired: 'Not paired',

  // Timeline and sections.
  timeline: 'Timeline',
  instructions: 'Instructions',
  noTimeline: 'No timeline entries yet.',

  // Sign in.
  signInHeading: 'Sign in to your unit',
  signInBody: 'Dispatch verifies the unit before anything is stored on this device.',
  callSignLabel: 'Call sign',
  callSignPlaceholder: 'MED-12',
  pinLabel: '4-digit PIN',
  pinPlaceholder: '••••',
  rememberUnit: 'Remember this unit',
  unlockFingerprint: 'Unlock with fingerprint',
  signIn: 'Sign in',
  signOut: 'Use another unit',
  wrongPin: 'That PIN does not match this device.',
  pinInvalid: 'The PIN is four digits.',
  callSignInvalid: 'Enter the call sign on the vehicle, for example MED-12.',
  lockedTitle: 'Locked',
  lockedBody: 'Enter the PIN for this unit to continue.',
  loading: 'Loading…',

  // Tabs and screens.
  history: 'History',
  historyBody: 'Every response this unit closed or lost, newest first.',
  noHistory: 'No finished responses yet.',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
  demoData: 'Demo data',
  duty: 'Duty',
  onDuty: 'On duty',
  available: 'Available for dispatch',
  endShift: 'End shift',
  shiftStarted: 'Shift started',
  responses: 'responses',
  onBreak: 'on break',
  ready: 'Ready',
  fuel: 'Fuel',
  checklist: 'Vehicle check',
  checklistReady: 'This unit is dispatch-ready.',
  checklistPending: 'items left before this unit is dispatch-ready.',
  finishCheck: 'Finish check',
  checklistSubtitle: 'Before shift · everything on board',
  profile: 'Profile',
  queue: 'Queue',
  thisShift: 'This shift',
  security: 'Security',
  dispatchSection: 'Dispatch',
  requirePin: 'Require PIN to complete',
  avgResponse: 'avg response',
  kmDriven: 'driven',

  // Availability.
  availAvailable: 'Available',
  availBreak: 'On break',
  availOff: 'Off shift',
  availSince: 'since',

  // Shift.
  shiftStartedNotice: 'Shift started',
  shiftEndedNotice: 'Shift ended',
  responseCompleted: 'Response completed',
  breakStartedNotice: 'Break started',
  breakEndedNotice: 'Break ended',
  endShiftTitle: 'End shift?',
  endShiftNow: 'End shift',
  takeBreak: 'Take a break',
  copySummary: 'Copy summary',
  viewHistory: 'View history',
  summaryCopied: 'Shift summary copied.',

  // Checks.
  checkTitle: 'Vehicle check',
  handoverTitle: 'Handover check',
  checkAllDone: 'All items checked',
  checkExpires: 'Check expires',
  checkExpired: 'Vehicle check expired',
  checkPassed: 'Vehicle check passed',
  handoverPassed: 'Handover check passed',
  checkNote: 'Note for dispatch (optional)',
  checkRemaining: 'items left to check',
  checkRequired: 'required items checked',

  // Activity and queue.
  activityTitle: 'Activity',
  activityEmpty: 'Nothing has happened yet.',
  outboxTitle: 'Queued updates',
  outboxEmpty: 'Nothing waiting to send.',
  sendNow: 'Send now',
  retryNotice: 'Delivery retried',
} as const;

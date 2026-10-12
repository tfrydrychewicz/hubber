// How large the synthetic world is and how it behaves: every number the generator draws by is a
// named field here, so that a test can change one of them and a reader can see what was assumed.
// NFR-6 gives the size of `full` (three years, 50 captures and 10 notes a day, 500 persons, about
// 300 active items); the rest are stated guesses about how a hub is used.

/** The shape of the trees that items form. */
export interface TreeShape {
  /** How many tasks sit directly under the top of a tree: from, to. */
  top: readonly [number, number];
  /**
   * The chance that a task at a level has tasks under it, by level: the first number is for the
   * tasks directly under the top. The last one is 0, so no tree is deeper than this list is long.
   */
  chance: readonly number[];
  /** How many tasks sit under a task that has any: from, to. */
  children: readonly [number, number];
}

/** A share of each of the three ways in which a change that was planned comes about. */
export interface Channels {
  /** The owner makes it by hand in the interface. */
  hand: number;
  /** The owner types it as a command beside the material. */
  command: number;
  /** The agent concludes it from the material and proposes it. */
  agent: number;
}

export interface Scale {
  name: string;

  // The history.
  /** Days of history, the last of which is the day of "now". */
  days: number;
  /** Captures a day that are no meeting notes. */
  capturesPerDay: number;
  /** Meeting notes a day. Until notes are a kind of source of their own, they are long text captures. */
  notesPerDay: number;

  // The directory of persons.
  /** Persons known on the first day, the owner among them, and on the last. */
  personsStart: number;
  personsEnd: number;
  /** Persons that were entered a second time under another spelling and merged later, in a year. */
  duplicatePersonsPerYear: number;

  // Projects, tasks and the trees they form.
  /** Projects open at any time. */
  activeProjects: number;
  /** Of those, the projects that never close. The first of them is the outlier. */
  flagshipProjects: number;
  /** Over how many days the tasks directly under a project arrive: from, to. */
  projectSpanDays: readonly [number, number];
  /** How long after its last task a project is closed, in days: from, to. */
  projectTailDays: readonly [number, number];
  /** Tasks that stand alone, created in a day. */
  looseTasksPerDay: number;
  /** The share of those that have a tree of their own. */
  looseTreeShare: number;
  projectTree: TreeShape;
  /** The one project with thousands of rows: the reads and the guard are measured where they cost most. */
  outlierTree: TreeShape;
  looseTree: TreeShape;
  /** The deepest a task sits under the top of its tree, also after it was moved. */
  maxDepth: number;
  /** How long after an item the items under it are created, in days: from, to. */
  childDelayDays: readonly [number, number];
  /** The share of tasks that are moved to another parent later, with everything under them. */
  moveShare: number;
  /** Of those moves, the share that stay within the tree of the task. */
  moveWithinTreeShare: number;
  /** How long after its creation a task is moved, in days: from, to. */
  moveDelayDays: readonly [number, number];
  /** Tasks that were entered a second time and merged into the first later, in a year. */
  duplicateItemsPerYear: number;
  /** How long a duplicate lives before it is merged, in days: from, to. */
  mergeDelayDays: readonly [number, number];

  // The fields of an item.
  /** The share of items of each importance: high, normal, low. */
  importanceShares: readonly [number, number, number];
  /** The share of items whose importance is changed later. */
  importanceChangeShare: number;
  /** The share of tasks whose health is assessed: most tasks have none. */
  assessedTaskShare: number;
  /** The share of assessed tasks that are first found in each health: green, yellow, red. */
  taskHealthShares: readonly [number, number, number];
  /** Of the assessed tasks, the share that get their health by a change after they were created; the others are created with it. */
  assessedLaterShare: number;
  /**
   * Of the assessed tasks, the share for which a later change of their health is planned. A change
   * that is planned for a day after the task was closed is not made. A change is to one of the
   * other two, and most tasks are green before it: after the changes a little over half of the
   * assessed tasks are green.
   */
  taskHealthChangeShare: number;
  /** The share of items that say what the owner's role in them is. */
  myRoleShare: number;
  /** The share of items that carry a key of the tracker. */
  externalKeyShare: number;
  /** The share of projects with a description. */
  descriptionShare: number;
  /** The share of tasks that end cancelled and not done. */
  cancelledShare: number;
  /** The share of tasks that stay open long after their day, and for how many days: from, to. */
  lingerShare: number;
  lingerDays: readonly [number, number];

  // The schedule of an item.
  /** The share of tasks that are milestones; a project never is one. */
  milestoneShare: number;
  /** The share of milestones that have no due day yet. */
  milestoneUndatedShare: number;
  /** The share of milestones that were tasks with a period first and were marked later. */
  markedLaterShare: number;
  /** The share of items with a due day. */
  dueShare: { project: number; task: number };
  /** The share of items that are no milestones and have a start; without a due day, the start stands alone. */
  startShare: { project: number; task: number };
  /** Of the items with both days, the share whose start is after the due day. */
  startAfterDueShare: number;
  /** The share of set days that carry a precision. */
  precisionShare: number;
  /** Of those, the share that are approximate; the others name a period. */
  approximateShare: number;
  /** How often each named period is drawn: week, month, quarter, half, year. */
  periodWeights: readonly [number, number, number, number, number];
  /** Of the items with both days, the share whose two days are the two ends of one named period. */
  samePeriodShare: number;
  /** In how many days after its creation an item is due: from, to. */
  taskDueDays: readonly [number, number];
  /** How long before its due day the work on an item starts, in days: from, to. */
  taskStartDays: readonly [number, number];
  /** How long after its day an item is closed, in days: from, to. */
  closeAfterDueDays: readonly [number, number];
  /**
   * The share of dated items for which a later change of their days is planned, and how many
   * such changes at most. A change that is planned for a day after the item was closed is not
   * made, and a task that is due within days is often closed by then: about a fifth of the
   * dated items come out with a day that was changed.
   */
  dateChangeShare: number;
  dateChangesMax: number;
  /** How long after the last change of its days an item's days change again, in days: from, to. */
  dateChangeGapDays: readonly [number, number];
  /** By how many days a day moves: from, to. */
  dateShiftDays: readonly [number, number];
  /** Of the changes of an item with a period, the share in which both days move together. */
  bothDaysMoveShare: number;

  // What a capture is and what the agent makes of it.
  /** The share of captures of each kind: a pasted thread, a screenshot, typed text, a thread with a remark, a dropped file. */
  captureShapes: readonly [number, number, number, number, number];
  /** The share of captures that are about 0, 1, 2, 3 and 4 items; a note is about 1 to 4. */
  itemsPerCapture: readonly [number, number, number, number, number];
  /** The share of captures' items that are the outlier project itself. */
  outlierShare: number;
  /** How many sentences of a thread state a fact about one item, by share: 0, 1, 2. A note has one more. */
  factsPerItem: readonly [number, number, number];
  /** The chance that the material says something about the status of an item it is about. */
  statusProposalShare: number;
  /** The chance that the material names a person's role in an item it is about. */
  rolePerCaptureShare: number;
  /** The chance that the agent asks whether two items are the same. */
  questionShare: number;
  /** The chance that the agent proposes a task that the owner does not want. */
  unwantedTaskShare: number;
  /** The chance that a new fact replaces an older one of the same item. */
  supersedeShare: number;
  /** The share of facts that name the persons they are about. */
  factPersonShare: number;
  /** The chance that a short name which several persons answer to is left as a question. */
  ambiguousMentionShare: number;
  /** The share of transcripts that the owner corrects by hand. */
  correctionShare: number;

  // The journal.
  /** The share of the agent's conclusions that it is not sure of. */
  lowConfidenceShare: number;
  /** The share of staged operations that fail the checks for good. */
  invalidShare: number;
  /** The share of proposals that the owner rejects. */
  rejectedShare: number;
  /** The share of operations that failed the checks which the owner throws away when the card is decided. */
  rejectedInvalidShare: number;
  /** The share of accepted proposals that the owner changed before accepting. */
  amendedShare: number;
  /** The share of operations that were applied at once and are undone a little later. */
  undoneShare: number;
  /** The share of tasks that the agent proposed whose creation is undone with what followed it. */
  undoneCreationShare: number;
  /** The median of the time between a card and its decision, in hours. */
  decisionMedianHours: number;
  /** How long before "now" the cards are still undecided, in hours. */
  openCardHours: number;
  /** The share of older cards that were never decided. */
  forgottenCardShare: number;
  /** How planned changes come about. */
  creationChannels: Channels;
  closingChannels: Channels;
  dateChannels: Channels;
  /** The share of new persons that the agent proposes; the others are entered by hand. */
  personProposedShare: number;

  // Work in progress.
  /** The share of first attempts at a capture that are interrupted and repeated. */
  interruptedShare: number;
  /** The share of captures whose processing fails for good. */
  failedShare: number;
  /** The share of captures that are processed a second time on request. */
  reprocessedShare: number;
  /** Changes the owner makes by hand in a day, besides the planned ones. */
  userEditsPerDay: number;
  /** Summaries of items that are written again in a day. */
  summariesPerDay: number;
}

/** What the three scales have in common: how items look and how the journal moves. */
const HABITS = {
  maxDepth: 8,
  looseTreeShare: 0.2,
  moveShare: 0.03,
  moveWithinTreeShare: 0.85,
  importanceShares: [0.15, 0.7, 0.15],
  importanceChangeShare: 0.05,
  assessedTaskShare: 0.1,
  taskHealthShares: [0.6, 0.3, 0.1],
  assessedLaterShare: 0.5,
  taskHealthChangeShare: 0.25,
  myRoleShare: 0.75,
  externalKeyShare: 0.3,
  descriptionShare: 0.5,
  cancelledShare: 0.15,
  lingerShare: 0.004,
  milestoneShare: 0.1,
  milestoneUndatedShare: 0.1,
  markedLaterShare: 0.02,
  dueShare: { project: 0.7, task: 0.85 },
  startShare: { project: 0.6, task: 0.45 },
  startAfterDueShare: 0.01,
  precisionShare: 0.125,
  approximateShare: 0.5,
  periodWeights: [0.22, 0.45, 0.22, 0.06, 0.05],
  samePeriodShare: 0.03,
  dateChangeShare: 0.3,
  dateChangesMax: 3,
  bothDaysMoveShare: 0.6,
  captureShapes: [0.44, 0.22, 0.11, 0.2, 0.03],
  itemsPerCapture: [0.12, 0.58, 0.22, 0.06, 0.02],
  outlierShare: 0.12,
  factsPerItem: [0.3, 0.5, 0.2],
  statusProposalShare: 0.12,
  rolePerCaptureShare: 0.12,
  questionShare: 0.06,
  unwantedTaskShare: 0.02,
  supersedeShare: 0.04,
  factPersonShare: 0.6,
  ambiguousMentionShare: 0.5,
  correctionShare: 0.02,
  lowConfidenceShare: 0.2,
  invalidShare: 0.005,
  rejectedShare: 0.07,
  rejectedInvalidShare: 0.97,
  amendedShare: 0.1,
  undoneShare: 0.02,
  undoneCreationShare: 0.01,
  decisionMedianHours: 3,
  openCardHours: 24,
  creationChannels: { hand: 0.4, command: 0.1, agent: 0.5 },
  closingChannels: { hand: 0.7, command: 0.1, agent: 0.2 },
  dateChannels: { hand: 0.7, command: 0, agent: 0.3 },
  personProposedShare: 0.6,
  interruptedShare: 0.03,
  failedShare: 0.012,
  reprocessedShare: 0.05,
} as const satisfies Partial<Scale>;

export const SCALES = {
  /** A few days of a small hub, in well under a tenth of a second: unit tests, and the database kept for the tests of later migrations. */
  tiny: {
    ...HABITS,
    name: "tiny",
    days: 5,
    capturesPerDay: 3,
    notesPerDay: 1,
    personsStart: 8,
    personsEnd: 10,
    duplicatePersonsPerYear: 0,
    activeProjects: 2,
    flagshipProjects: 1,
    projectSpanDays: [2, 4],
    projectTailDays: [1, 2],
    looseTasksPerDay: 0.4,
    projectTree: { top: [2, 3], chance: [0.4, 0.3, 0], children: [1, 2] },
    outlierTree: { top: [4, 4], chance: [0.6, 0.4, 0.2, 0], children: [1, 2] },
    looseTree: { top: [1, 2], chance: [0.3, 0], children: [1, 1] },
    childDelayDays: [1, 2],
    moveDelayDays: [1, 3],
    duplicateItemsPerYear: 0,
    mergeDelayDays: [1, 2],
    lingerDays: [3, 5],
    taskDueDays: [1, 4],
    taskStartDays: [0, 2],
    closeAfterDueDays: [-1, 1],
    dateChangeGapDays: [1, 2],
    dateShiftDays: [1, 5],
    forgottenCardShare: 0,
    userEditsPerDay: 1,
    summariesPerDay: 1,
  },
  /** A month of a quiet team, in under a second: tests that need a database with rows in every state. */
  small: {
    ...HABITS,
    name: "small",
    days: 30,
    capturesPerDay: 12,
    notesPerDay: 3,
    personsStart: 40,
    personsEnd: 48,
    duplicatePersonsPerYear: 24,
    activeProjects: 5,
    flagshipProjects: 2,
    projectSpanDays: [8, 22],
    projectTailDays: [2, 6],
    looseTasksPerDay: 1,
    projectTree: { top: [3, 6], chance: [0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0], children: [1, 3] },
    outlierTree: { top: [8, 8], chance: [0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0], children: [1, 3] },
    looseTree: { top: [1, 3], chance: [0.4, 0.3, 0.2, 0], children: [1, 3] },
    childDelayDays: [1, 4],
    moveDelayDays: [1, 10],
    duplicateItemsPerYear: 24,
    mergeDelayDays: [2, 6],
    lingerDays: [20, 40],
    taskDueDays: [2, 12],
    taskStartDays: [0, 8],
    closeAfterDueDays: [-2, 3],
    dateChangeGapDays: [1, 6],
    dateShiftDays: [2, 10],
    forgottenCardShare: 0.004,
    userEditsPerDay: 2,
    summariesPerDay: 5,
  },
  /** NFR-6 read literally, at its upper bound on every calendar day of three years. */
  full: {
    ...HABITS,
    name: "full",
    days: 1095,
    capturesPerDay: 50,
    notesPerDay: 10,
    personsStart: 120,
    personsEnd: 500,
    duplicatePersonsPerYear: 20,
    activeProjects: 26,
    flagshipProjects: 3,
    projectSpanDays: [150, 420],
    projectTailDays: [10, 40],
    looseTasksPerDay: 0.35,
    projectTree: { top: [8, 25], chance: [0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0], children: [1, 4] },
    outlierTree: { top: [60, 60], chance: [0.8, 0.6, 0.5, 0.4, 0.35, 0.3, 0.25, 0], children: [2, 4] },
    looseTree: { top: [1, 3], chance: [0.4, 0.3, 0.2, 0], children: [1, 3] },
    childDelayDays: [1, 20],
    moveDelayDays: [1, 14],
    duplicateItemsPerYear: 25,
    mergeDelayDays: [2, 10],
    lingerDays: [60, 200],
    taskDueDays: [3, 30],
    taskStartDays: [0, 30],
    closeAfterDueDays: [-3, 6],
    dateChangeGapDays: [2, 20],
    dateShiftDays: [3, 21],
    forgottenCardShare: 0.001,
    userEditsPerDay: 2,
    summariesPerDay: 25,
  },
} as const satisfies Record<string, Scale>;

export type ScaleName = keyof typeof SCALES;

// Exit codes of everything that is started from a terminal: the server, the development
// runner and the scripts. Each code means the same everywhere, so that whatever started the
// process can tell a bad setting from a failed run.

/** What was asked for could not be done: a taken port, a missing build, a shutdown that hung. */
export const EXIT_FAILURE = 1;
/** A setting cannot be used as given: a variable or an option with a bad value. Nothing was started. */
export const EXIT_USAGE = 2;

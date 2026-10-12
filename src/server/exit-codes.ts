// Exit codes of everything that is started from a terminal: the server, the development
// runner and the scripts. Each code means the same everywhere, so that whatever started the
// process can tell a bad setting from a failed run.

/** What was asked for could not be done: a taken port, a missing build, a shutdown that hung. */
export const EXIT_FAILURE = 1;
/** A setting cannot be used as given: a variable or an option with a bad value. Nothing was started. */
export const EXIT_USAGE = 2;
/**
 * The workspace stayed closed because of its pin: the endpoint named by the environment is not
 * the one the workspace was created for, or its configuration file and its database name
 * different ones. A code of its own, so that a test or a wrapper can tell this refusal from a
 * mistyped setting and from every other failed start.
 */
export const EXIT_PIN = 3;
/**
 * A measurement could not be taken: the machine was too busy for its numbers to mean anything.
 * A code of its own, so that whoever runs the performance command can tell "try again" from a
 * budget that was exceeded, which is a failed run.
 */
export const EXIT_INCONCLUSIVE = 4;

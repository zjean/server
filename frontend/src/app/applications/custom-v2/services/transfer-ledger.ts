/** Anything with a task id. Kept structural so the ledger has no Angular imports. */
interface Identified {
  id: string
}

/**
 * Which finished tasks the dock is still entitled to announce.
 *
 * The dock reads `store.filesEndedTasks`, and that list is NOT a record of what
 * happened while the page was open: `FilesTasksService.loadAll` seeds it from
 * `GET /files/tasks` at login, and the server keeps every finished task in its cache
 * for a day (`CACHE_TASK_TTL`, 86400s). So a user who deleted a folder yesterday
 * evening opens the app this morning and the dock rises out of the corner to tell them
 * about it — and closing it did not help either, because the old dock only emptied the
 * client's copy of the list. Everything came back on the next load, for up to 24 hours.
 *
 * Two rules fix that, and both are about identity rather than about time:
 *
 *  • **A transfer is announceable only if this client watched it run.** An entry that
 *    was already finished the first time we saw it is history, not an event. That is
 *    the discriminator the server cannot give us and a timestamp cannot either — a
 *    task finished on another device thirty seconds ago is still someone else's news,
 *    while an upload started before a page reload is legitimately still ours (it
 *    reappears as ACTIVE, so it gets watched, and its completion is announced).
 *  • **Dismissal is per task id.** The old dock kept one boolean, so a re-reported
 *    batch reopened it; and it cleared the shared store, which erased the classic
 *    UI's task history as a side effect of closing a v2 panel.
 *
 * Both sets are per page load. They do not need to persist: the first rule already
 * covers the reload case, and it covers it better than a persisted dismissal would —
 * that would only silence what the user had explicitly closed, leaving the dock free
 * to reopen over yesterday's tasks for anyone who had simply navigated away.
 *
 * Deliberately not an Angular service: it is two sets and three set operations, and
 * keeping it free of `signal`/`inject` is what lets it be tested directly instead of
 * through an injection context that has to fake `toSignal`.
 */
export class TransferLedger {
  private readonly watched = new Set<string>()
  private readonly dismissed = new Set<string>()

  /**
   * Record every task in an ACTIVE emission as one we are watching.
   *
   * Called from a plain subscription to `store.filesActiveTasks` rather than from an
   * `effect`, and that is load-bearing: a BehaviorSubject delivers every intermediate
   * value synchronously, while an effect coalesces and would see only the last one.
   * A small upload can go active→ended inside a single change-detection pass, and an
   * effect that missed its active value would file it away as history and never
   * mention it.
   */
  watch(tasks: readonly Identified[]): void {
    for (const task of tasks) this.watched.add(task.id)
  }

  /** Close a finished batch: these ids never reopen the dock, however often they are re-reported. */
  dismiss(tasks: readonly Identified[]): void {
    for (const task of tasks) this.dismissed.add(task.id)
  }

  /** The finished tasks the dock may show, in the order given. */
  announceable<T extends Identified>(ended: readonly T[]): T[] {
    return ended.filter((task) => this.watched.has(task.id) && !this.dismissed.has(task.id))
  }
}

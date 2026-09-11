/**
 * ThreadSettledScriptsReactor - Stops long-running project actions on settle.
 *
 * Reacts to thread.settled domain events and interrupts the actions that opted
 * into `stopOnThreadSettle`, so a dev server or watcher does not outlive the
 * work that started it.
 *
 * @module ThreadSettledScriptsReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadSettledScriptsReactorShape - Service API for settle-time action cleanup.
 */
export interface ThreadSettledScriptsReactorShape {
  /**
   * Start reacting to thread.settled orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves once every thread.settled at or before the supplied event sequence
   * has been handed to the worker and the worker is empty and idle.
   */
  readonly drainThrough: (sequence: number) => Effect.Effect<void>;
}

/**
 * ThreadSettledScriptsReactor - Service tag for settle-time action cleanup.
 */
export class ThreadSettledScriptsReactor extends Context.Service<
  ThreadSettledScriptsReactor,
  ThreadSettledScriptsReactorShape
>()("t3/orchestration/Services/ThreadSettledScriptsReactor") {}

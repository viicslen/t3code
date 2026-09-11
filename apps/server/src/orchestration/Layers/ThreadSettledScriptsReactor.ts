import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  projectScriptTerminalId,
  resolveProjectScripts,
  scriptsStoppedOnThreadSettle,
  TERMINAL_INTERRUPT_SEQUENCE,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadSettledScriptsReactor,
  type ThreadSettledScriptsReactorShape,
} from "../Services/ThreadSettledScriptsReactor.ts";

type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  /**
   * Interrupting is best effort: the action may never have run in this thread,
   * so a missing or already-exited terminal is the common case, not a fault.
   */
  const stopScript = (threadId: ThreadId, scriptId: string) =>
    terminalManager
      .write({
        threadId,
        terminalId: projectScriptTerminalId(scriptId),
        data: TERMINAL_INTERRUPT_SEQUENCE,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logDebug("settled thread left an action terminal untouched", {
                threadId,
                scriptId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  const processThreadSettled = Effect.fn("processThreadSettled")(function* (
    event: ThreadSettledEvent,
  ) {
    const { threadId } = event.payload;
    const thread = yield* snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrNull));
    if (thread === null) return;
    const project = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrNull));
    if (project === null) return;
    const settings = yield* settingsService.getSettings;
    const scripts = scriptsStoppedOnThreadSettle(resolveProjectScripts(settings, project));
    yield* Effect.forEach(scripts, (script) => stopScript(threadId, script.id), { discard: true });
  });

  const processThreadSettledSafely = (event: ThreadSettledEvent) =>
    processThreadSettled(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("settled thread action cleanup failed", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processThreadSettledSafely);

  // Highest event sequence the subscriber has handed to the worker, so a drain
  // cannot report "done" for a settlement still in flight to the subscriber.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadSettledScriptsReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          // Events that landed before the subscription are not replayed, so
          // start the watermark at the current head instead of zero.
          Stream.onStart(orchestrationEngine.latestSequence.pipe(Effect.flatMap(noteSeen))),
        ),
        (event) =>
          (event.type === "thread.settled" ? worker.enqueue(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
      ),
    );
  });

  const drainThrough: ThreadSettledScriptsReactorShape["drainThrough"] = Effect.fn(
    "ThreadSettledScriptsReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return { start, drainThrough } satisfies ThreadSettledScriptsReactorShape;
});

export const ThreadSettledScriptsReactorLive = Layer.effect(ThreadSettledScriptsReactor, make);

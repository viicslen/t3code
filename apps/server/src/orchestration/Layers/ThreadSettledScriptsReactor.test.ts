import {
  CommandId,
  CorrelationId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  type OrchestrationEvent,
  type ProjectScript,
  TerminalNotRunningError,
  ThreadId,
} from "@t3tools/contracts";
import { TERMINAL_INTERRUPT_SEQUENCE } from "@t3tools/shared/projectScripts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadSettledScriptsReactor } from "../Services/ThreadSettledScriptsReactor.ts";
import { ThreadSettledScriptsReactorLive } from "./ThreadSettledScriptsReactor.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-settled-scripts");
const projectId = ProjectId.make("project-settled-scripts");

function script(id: string, overrides: Partial<ProjectScript> = {}): ProjectScript {
  return {
    id,
    name: id,
    command: `run ${id}`,
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  };
}

const settledEvent = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-settled-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.settled",
  occurredAt: now,
  commandId: CommandId.make(`cmd-settled-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`cmd-settled-${sequence}`),
  metadata: {},
  payload: { threadId, settledAt: now, updatedAt: now },
});

/**
 * Drives one settlement through the reactor and reports the terminals it wrote
 * to. `writeFails` stands in for an action that never ran in this thread.
 */
function runSettlement(input: {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly writeFails?: boolean;
}) {
  return Effect.gen(function* () {
    const writes: Array<{ terminalId: string; data: string }> = [];
    const engine = {
      streamDomainEvents: Stream.make(settledEvent(1)),
      // Head before the subscription: the watermark must only reach 1 once the
      // event itself has been handed to the worker, or the drain proves nothing.
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineService["Service"];
    const snapshots = {
      getThreadShellById: () => Effect.succeed(Option.some({ id: threadId, projectId })),
      getProjectShellById: () => Effect.succeed(Option.some({ id: projectId, scripts: [] })),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const settings = {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        projectScriptOverrides: { [projectId]: input.scripts },
      }),
    } as unknown as ServerSettings.ServerSettingsService["Service"];
    const terminalManager = {
      write: (write: { terminalId: string; data: string }) => {
        if (input.writeFails) {
          return Effect.fail(
            new TerminalNotRunningError({ threadId, terminalId: write.terminalId }),
          );
        }
        writes.push({ terminalId: write.terminalId, data: write.data });
        return Effect.void;
      },
    } as unknown as TerminalManager.TerminalManager["Service"];

    const layer = ThreadSettledScriptsReactorLive.pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
      Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
      Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ThreadSettledScriptsReactor;
        yield* reactor.start();
        yield* reactor.drainThrough(1);
      }),
    ).pipe(Effect.provide(layer));

    return writes;
  });
}

describe("ThreadSettledScriptsReactor", () => {
  effectIt.effect("interrupts the actions that opted in", () =>
    Effect.gen(function* () {
      const writes = yield* runSettlement({
        scripts: [
          script("dev", { stopOnThreadSettle: true }),
          script("test"),
          script("lint", { stopOnThreadSettle: true }),
        ],
      });

      expect(writes.map((write) => write.terminalId)).toEqual(["script-dev", "script-lint"]);
      expect(new Set(writes.map((write) => write.data))).toEqual(
        new Set([TERMINAL_INTERRUPT_SEQUENCE]),
      );
    }),
  );

  effectIt.effect("leaves actions that run several instances alone", () =>
    Effect.gen(function* () {
      const writes = yield* runSettlement({
        scripts: [
          script("dev", { stopOnThreadSettle: true, allowMultipleInstances: true }),
          script("watch", { stopOnThreadSettle: true }),
        ],
      });

      expect(writes.map((write) => write.terminalId)).toEqual(["script-watch"]);
    }),
  );

  effectIt.effect("settles cleanly when the action never ran in this thread", () =>
    Effect.gen(function* () {
      const writes = yield* runSettlement({
        scripts: [script("dev", { stopOnThreadSettle: true })],
        writeFails: true,
      });

      expect(writes).toEqual([]);
    }),
  );
});

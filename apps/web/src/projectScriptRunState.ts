import type { ProjectScript } from "@t3tools/contracts";
import { projectScriptTerminalId } from "@t3tools/shared/projectScripts";

const NO_PENDING: ReadonlySet<string> = new Set();

/**
 * Actions whose pinned terminal currently has a child process.
 *
 * The server detects subprocesses by polling `ps` once a second, so a freshly
 * launched action reads as idle for up to a poll interval. `pendingScriptIds`
 * covers that gap: without it the button stays on "run" right after a click and
 * a second click writes the command into the shell a second time.
 */
export function selectRunningProjectScriptIds(input: {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly pendingScriptIds?: ReadonlySet<string>;
}): ReadonlySet<string> {
  const pending = input.pendingScriptIds ?? NO_PENDING;
  const running = new Set(input.runningTerminalIds);
  const result = new Set<string>();
  for (const script of input.scripts) {
    // Several terminals, so no single session to report on or stop.
    if (script.allowMultipleInstances) continue;
    if (pending.has(script.id) || running.has(projectScriptTerminalId(script.id))) {
      result.add(script.id);
    }
  }
  return result;
}

/**
 * Pending entries the server has now confirmed, so they can be dropped from the
 * optimistic set. Returns null when nothing changed, letting callers skip a
 * re-render.
 */
export function clearConfirmedPendingScriptIds(
  pendingScriptIds: ReadonlySet<string>,
  runningTerminalIds: ReadonlyArray<string>,
): ReadonlySet<string> | null {
  if (pendingScriptIds.size === 0) return null;
  const running = new Set(runningTerminalIds);
  const next = new Set<string>();
  for (const scriptId of pendingScriptIds) {
    if (!running.has(projectScriptTerminalId(scriptId))) next.add(scriptId);
  }
  return next.size === pendingScriptIds.size ? null : next;
}

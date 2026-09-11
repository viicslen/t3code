import type { ProjectScript } from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { projectScriptTerminalId } from "@t3tools/shared/projectScripts";
import { describe, expect, it } from "vite-plus/test";

import {
  clearConfirmedPendingScriptIds,
  selectRunningProjectScriptIds,
} from "./projectScriptRunState";

function script(id: string): ProjectScript {
  return { id, name: id, command: `run ${id}`, icon: "play", runOnWorktreeCreate: false };
}

const SCRIPTS = [script("dev"), script("test")];

describe("selectRunningProjectScriptIds", () => {
  it("marks an action running from its pinned terminal", () => {
    expect([
      ...selectRunningProjectScriptIds({
        scripts: SCRIPTS,
        runningTerminalIds: [projectScriptTerminalId("dev")],
      }),
    ]).toEqual(["dev"]);
  });

  it("ignores busy terminals that belong to no action", () => {
    expect(
      selectRunningProjectScriptIds({
        scripts: SCRIPTS,
        runningTerminalIds: ["term-1", "setup-dev", "script-other"],
      }).size,
    ).toBe(0);
  });

  it("treats a just-launched action as running before the poll confirms it", () => {
    expect([
      ...selectRunningProjectScriptIds({
        scripts: SCRIPTS,
        runningTerminalIds: [],
        pendingScriptIds: new Set(["test"]),
      }),
    ]).toEqual(["test"]);
  });
});

describe("clearConfirmedPendingScriptIds", () => {
  it("drops only the entries the server now reports as running", () => {
    expect([
      ...(clearConfirmedPendingScriptIds(new Set(["dev", "test"]), [
        projectScriptTerminalId("dev"),
      ]) ?? []),
    ]).toEqual(["test"]);
  });

  it("returns null when nothing is confirmed, so callers can skip a re-render", () => {
    expect(clearConfirmedPendingScriptIds(new Set(["dev"]), ["term-1"])).toBeNull();
    expect(clearConfirmedPendingScriptIds(new Set(), [])).toBeNull();
  });
});

describe("pinned terminal ids", () => {
  // The allocator must never hand out an id an action has claimed.
  it("cannot collide with allocator output", () => {
    const pinned = SCRIPTS.map((entry) => projectScriptTerminalId(entry.id));
    expect(pinned).not.toContain(nextTerminalId(pinned));
  });
});

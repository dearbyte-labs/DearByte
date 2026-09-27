import { expect, test } from "vitest";
import { isAgentCommand } from "../src/commands.ts";

test("a command runs the agent; nothing, or only flags, runs the companion", () => {
  for (const c of ["status", "wechat", "imessage", "help", "approve"]) expect(isAgentCommand(c)).toBe(true);
  for (const c of [undefined, "--draft", "--chat", "companion"]) expect(isAgentCommand(c)).toBe(false);
});

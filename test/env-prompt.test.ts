import { test } from "node:test";
import assert from "node:assert/strict";
import { environmentBlock } from "../src/kernel/forge-agent.js";

test("environmentBlock：提示 POSIX sh + 工作目录", () => {
  const b = environmentBlock("/home/u/proj");
  assert.match(b, /\/bin\/sh/);
  assert.match(b, /POSIX/);
  assert.match(b, /\/home\/u\/proj/);
  assert.match(b, /read_file/); // 引导优先用工具
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { environmentBlock } from "../src/kernel/forge-agent.js";

test("win32：提示 PowerShell 语法 + 工作目录 + 避坑要点", () => {
  const b = environmentBlock("C:/proj", "win32");
  assert.match(b, /PowerShell/);
  assert.match(b, /C:\/proj/);
  assert.match(b, /\$env:NAME/); // 环境变量写法
  assert.match(b, /不支持 `&&`/); // 命令连接
  assert.match(b, /read_file/); // 引导优先用工具
});

test("非 win32：提示 POSIX sh", () => {
  const b = environmentBlock("/home/u/proj", "linux");
  assert.match(b, /\/bin\/sh/);
  assert.match(b, /POSIX/);
  assert.match(b, /\/home\/u\/proj/);
  assert.doesNotMatch(b, /PowerShell/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeToolArgs, readFileResultLine } from "../src/ui/render.js";

test("summarizeToolArgs read_file：标出读取行范围 / 全文", () => {
  assert.equal(summarizeToolArgs("read_file", { path: "src/a.ts" }), "src/a.ts · full");
  assert.equal(summarizeToolArgs("read_file", { path: "src/a.ts", offset: 10 }), "src/a.ts · L10+");
  assert.equal(summarizeToolArgs("read_file", { path: "src/a.ts", offset: 10, limit: 20 }), "src/a.ts · L10–29");
});

test("summarizeToolArgs：code-intel / LSP 工具显示干净摘要（非截断 JSON）", () => {
  assert.equal(summarizeToolArgs("outline", { path: "src/a.py" }), "src/a.py");
  assert.equal(summarizeToolArgs("repo_map", {}), ".");
  assert.equal(summarizeToolArgs("repo_map", { path: "src" }), "src");
  assert.equal(summarizeToolArgs("references", { path: "pg.py", symbol: "hybrid_search" }), "hybrid_search · pg.py");
  assert.equal(summarizeToolArgs("definition", { symbol: "foo" }), "foo");
  assert.equal(summarizeToolArgs("diagnostics", { path: "a.py" }), "a.py");
  assert.equal(summarizeToolArgs("diagnostics", {}), "(整项目 tsc)");
});

test("summarizeToolArgs bash：命令最多 140 字符（路径+范围看得见）", () => {
  const cmd = "Get-Content " + "C:/x".repeat(60); // 远超 140
  const out = summarizeToolArgs("bash", { cmd });
  assert.ok(out.length <= 141, `应≤141，实际 ${out.length}`);
  assert.ok(out.startsWith("Get-Content C:/x"), "应保留命令开头");
  // 短命令完整保留
  assert.equal(summarizeToolArgs("bash", { cmd: "ls -la" }), "ls -la");
});

test("readFileResultLine：显示读取行数与范围", () => {
  assert.equal(readFileResultLine({ path: "a.ts", lines: 50, from: 1 }), "read 50 lines (L1–50)");
  assert.equal(readFileResultLine({ path: "a.ts", lines: 30, from: 100 }), "read 30 lines (L100–129)");
});

test("readFileResultLine：截断标记说明中段已省略", () => {
  const line = readFileResultLine({ path: "a.ts", lines: 5, from: 1, truncated: true });
  assert.match(line!, /read 5 lines \(L1–5\)/);
  assert.match(line!, /middle omitted/); // 明确不是行尾截断
  assert.match(line!, /offset/);
});

test("readFileResultLine：缺 details 返回 null（回退默认预览）", () => {
  assert.equal(readFileResultLine(undefined), null);
  assert.equal(readFileResultLine({ path: "a.ts" }), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCode, langForPath, normalizeLang } from "../src/ui/highlight.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// 某段明文片段被某色号包裹？（38;5;CODE … 39）
const colored = (out: string, code: number, text: string) =>
  new RegExp(`\\x1b\\[38;5;${code}m[^]*?${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(out);

test("strip 后明文与输入一致（不改变可见字符）", () => {
  const src = `def foo(x):  # hi\n    return "ok"`;
  assert.equal(strip(highlightCode(src, "py")), src);
});

test("token 上色：关键字(176)/字符串(114)/数字(179)/注释(245)", () => {
  const out = highlightCode(`const n = 42 // note`, "ts");
  assert.ok(colored(out, 176, "const"), "const 应为关键字色");
  assert.ok(colored(out, 179, "42"), "42 应为数字色");
  assert.ok(colored(out, 245, "// note"), "注释应为浅灰");
  const s = highlightCode(`x = "hello"`, "py");
  assert.ok(colored(s, 114, '"hello"'), "字符串应为绿");
});

test("调用位标识符(220)与大写类型(81)分色，普通标识符不上色", () => {
  const out = highlightCode(`foo(Bar)`, "ts");
  assert.ok(colored(out, 220, "foo"), "foo( 应为函数色");
  assert.ok(colored(out, 81, "Bar"), "大写 Bar 应为类型色");
  // 普通小写非调用标识符：原样无色
  assert.equal(highlightCode("plain", "ts"), "plain");
});

test("常量上色：true/None 等(214)", () => {
  assert.ok(colored(highlightCode("ok = True", "py"), 214, "True"));
  assert.ok(colored(highlightCode("let v = null", "ts"), 214, "null"));
});

test("text 语言：原样返回，不插任何 ANSI", () => {
  const tree = "├── attachments/   ← 源文件";
  assert.equal(highlightCode(tree, "text"), tree);
});

test("langForPath / normalizeLang 映射", () => {
  assert.equal(langForPath("src/a.tsx"), "ts");
  assert.equal(langForPath("x.py"), "py");
  assert.equal(langForPath("Makefile"), "generic"); // 无后缀
  assert.equal(langForPath("data.unknown"), "generic");
  assert.equal(normalizeLang("python"), "py");
  assert.equal(normalizeLang("bash"), "sh");
  assert.equal(normalizeLang(""), "text"); // 无标注
  assert.equal(normalizeLang("brainfuck"), "text"); // 未知语言 → text（不高亮）
});

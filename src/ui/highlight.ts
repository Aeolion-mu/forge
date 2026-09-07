/**
 * 轻量语法高亮（无第三方依赖）：把源码按 token 切成 注释/字符串/数字/关键字/常量/函数/类型 分色。
 * 供 diff 渲染与 Markdown 代码块共用。
 *
 * 逐行扫描（不跨行追踪多行字符串/块注释 —— diff 逐行喂入的场景足够）。所有 token 一律用
 * `\x1b[38;5;Nm … \x1b[39m`（**仅重置前景**，绝不用 `\x1b[0m`），以便叠加在 diff 行的背景色带之上
 * 而不抹掉背景。
 */

const E = "\x1b[";
const fg = (code: number, s: string) => `${E}38;5;${code}m${s}${E}39m`;

// token 配色（256 色，暖色为主、少量冷色提升可读性）
const COL = {
  comment: 245, // 浅灰（不再用会被压暗的 dim 属性）
  string: 114, // 绿
  number: 179, // 暖黄
  keyword: 176, // 紫
  konst: 214, // 琥珀：true/false/null/None/self/this…
  func: 220, // 金：调用位的标识符
  type: 81, // 青：大写开头标识符（类/类型）
  attr: 208, // 橙：@装饰器
};

interface LangCfg {
  line: string[]; // 行注释前缀
  block: [string, string] | null; // 块注释定界
  triple: boolean; // 三引号字符串（py）
  template: boolean; // 反引号模板串（js/ts）
  keywords: Set<string>;
  consts: Set<string>;
  none?: boolean; // text：原样返回，不高亮
}

const KW: Record<string, string> = {
  js: "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
  cpp: "auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long namespace new nullptr operator override private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while",
  java: "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record return sealed static strictfp super switch synchronized this throw throws transient try var void volatile while",
  sh: "if then elif else fi for while until do done case esac function in select return break continue local export readonly declare",
};
const CONSTS: Record<string, string> = {
  js: "true false null undefined NaN Infinity this super",
  py: "True False None self cls __name__ __init__",
  go: "true false nil iota",
  rust: "true false None Some Ok Err self Self",
  json: "true false null",
  default: "true false null nil None True False",
};
const set = (s: string) => new Set(s ? s.split(" ") : []);
const mk = (line: string[], block: [string, string] | null, triple: boolean, template: boolean, kw: string, ks: string): LangCfg => ({
  line,
  block,
  triple,
  template,
  keywords: set(kw),
  consts: set(ks),
});

function cfg(lang: string): LangCfg {
  switch (lang) {
    case "ts":
    case "js":
      return mk(["//"], ["/*", "*/"], false, true, KW.js, CONSTS.js);
    case "py":
      return mk(["#"], null, true, false, KW.py, CONSTS.py);
    case "go":
      return mk(["//"], ["/*", "*/"], false, true, KW.go, CONSTS.go);
    case "rust":
      return mk(["//"], ["/*", "*/"], false, false, KW.rust, CONSTS.rust);
    case "java":
      return mk(["//"], ["/*", "*/"], false, false, KW.java, CONSTS.js);
    case "c":
      return mk(["//"], ["/*", "*/"], false, false, KW.c, CONSTS.js);
    case "cpp":
      return mk(["//"], ["/*", "*/"], false, false, KW.cpp, CONSTS.js);
    case "sh":
      return mk(["#"], null, false, false, KW.sh, CONSTS.default);
    case "json":
      return mk([], null, false, false, "", CONSTS.json);
    case "yaml":
    case "toml":
      return mk(["#"], null, false, false, "", CONSTS.default);
    case "css":
      return mk([], ["/*", "*/"], false, false, "", CONSTS.default);
    case "text":
      return { ...mk([], null, false, false, "", ""), none: true };
    default: // generic：js+py 关键字并集，兼顾大多数脚本
      return mk(["//", "#"], ["/*", "*/"], false, true, `${KW.js} ${KW.py}`, CONSTS.default);
  }
}

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isId = (c: string) => /[\w$]/.test(c);

/** 高亮单行源码（不跨行）。 */
function highlightLine(line: string, c: LangCfg): string {
  if (c.none) return line;
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    // 空白：原样
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out += line.slice(i, j);
      i = j;
      continue;
    }
    // 行注释：到行尾
    if (c.line.some((p) => line.startsWith(p, i))) {
      out += fg(COL.comment, line.slice(i));
      break;
    }
    // 块注释：到闭合或行尾
    if (c.block && line.startsWith(c.block[0], i)) {
      const end = line.indexOf(c.block[1], i + c.block[0].length);
      const stop = end < 0 ? n : end + c.block[1].length;
      out += fg(COL.comment, line.slice(i, stop));
      i = stop;
      continue;
    }
    // 装饰器 @name
    if (ch === "@" && i + 1 < n && isIdStart(line[i + 1])) {
      let j = i + 1;
      while (j < n && isId(line[j])) j++;
      out += fg(COL.attr, line.slice(i, j));
      i = j;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || (c.template && ch === "`")) {
      if (c.triple && (ch === '"' || ch === "'") && line.startsWith(ch.repeat(3), i)) {
        const q = ch.repeat(3);
        const end = line.indexOf(q, i + 3);
        const stop = end < 0 ? n : end + 3;
        out += fg(COL.string, line.slice(i, stop));
        i = stop;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      out += fg(COL.string, line.slice(i, j));
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch) || (ch === "." && i + 1 < n && /[0-9]/.test(line[i + 1]))) {
      let j = i;
      if (ch === "0" && (line[i + 1] === "x" || line[i + 1] === "X")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(line[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(line[j])) j++;
        if (line[j] === ".") {
          j++;
          while (j < n && /[0-9_]/.test(line[j])) j++;
        }
        if (line[j] === "e" || line[j] === "E") {
          j++;
          if (line[j] === "+" || line[j] === "-") j++;
          while (j < n && /[0-9]/.test(line[j])) j++;
        }
      }
      while (j < n && /[fFlLnujU]/.test(line[j])) j++; // 后缀 1.0f / 10L / 1n
      out += fg(COL.number, line.slice(i, j));
      i = j;
      continue;
    }
    // 标识符
    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && isId(line[j])) j++;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k++;
      const isCall = line[k] === "(";
      let color: number | null = null;
      if (c.keywords.has(word)) color = COL.keyword;
      else if (c.consts.has(word)) color = COL.konst;
      else if (isCall) color = COL.func;
      else if (/^[A-Z]/.test(word) && word.length > 1) color = COL.type;
      out += color == null ? word : fg(color, word);
      i = j;
      continue;
    }
    // 其余（运算符/标点）：默认色
    out += ch;
    i++;
  }
  return out;
}

/** 高亮多行源码（逐行）。lang 取自 langForPath / normalizeLang；未知语言走 generic。 */
export function highlightCode(code: string, lang: string): string {
  const c = cfg(lang);
  return code.split("\n").map((l) => highlightLine(l, c)).join("\n");
}

const EXT: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  json: "json", sh: "sh", bash: "sh", zsh: "sh",
  yml: "yaml", yaml: "yaml", toml: "toml",
  css: "css", scss: "css", less: "css",
};

/** 由文件路径后缀推断语言；未知后缀走 generic。 */
export function langForPath(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? EXT[m[1].toLowerCase()] ?? "generic" : "generic";
}

const NAME: Record<string, string> = {
  ts: "ts", typescript: "ts", tsx: "ts",
  js: "js", javascript: "js", jsx: "js", node: "js",
  py: "py", python: "py",
  go: "go", golang: "go", rs: "rust", rust: "rust",
  java: "java", c: "c", "c++": "cpp", cpp: "cpp", cxx: "cpp",
  json: "json", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  yaml: "yaml", yml: "yaml", toml: "toml", css: "css", scss: "css",
};

/** 由 Markdown ``` 围栏的语言标注推断语言；无标注/未知走 text（不高亮，原样亮色）。 */
export function normalizeLang(hint: string): string {
  return NAME[hint.toLowerCase()] ?? "text";
}

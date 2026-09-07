import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

/**
 * 代码大纲（code outline）—— tree-sitter 抽取「符号 + 起止行」元数据。
 *
 * 目的：让模型「先看结构再按行精准读」，而不是整文件读几百上千行
 * （业内标准：Aider repo map / AFT / Zed / Claude Code 的 LSP documentSymbol 都这么做，
 * 对 DeepSeek 这类非顶尖模型尤其能省上下文、降幻觉）。
 *
 * 解析用 web-tree-sitter（WASM，无原生编译，Windows 友好）+ tree-sitter-wasms 预编译语法。
 */

export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "enum" | "type" | "struct" | "trait" | "constructor";

export interface CodeSymbol {
  kind: SymbolKind;
  name: string;
  /** 最近的外层符号名（方法 → 所属类）。 */
  container?: string;
  /** 1-based 起止行。 */
  startLine: number;
  endLine: number;
  /** 定义首行（含签名/参数），已 trim。 */
  signature: string;
}

interface LangConfig {
  /** tree-sitter-wasms/out 下的 grammar 文件名（不含 .wasm）。 */
  wasm: string;
  /** 视为「定义」的节点类型 → 符号种类。 */
  defs: Record<string, SymbolKind>;
}

const JS: LangConfig = {
  wasm: "tree-sitter-javascript",
  defs: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    method_definition: "method",
  },
};
const TS_DEFS: Record<string, SymbolKind> = {
  ...JS.defs,
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
};
const TS: LangConfig = { wasm: "tree-sitter-typescript", defs: TS_DEFS };
const TSX: LangConfig = { wasm: "tree-sitter-tsx", defs: TS_DEFS };

/** 扩展名 → 语言配置。新增语言只要 tree-sitter-wasms 里有对应 wasm 即可加一行。 */
const LANGS: Record<string, LangConfig> = {
  ".py": { wasm: "tree-sitter-python", defs: { function_definition: "function", class_definition: "class" } },
  ".js": JS, ".jsx": JS, ".mjs": JS, ".cjs": JS,
  ".ts": TS, ".tsx": TSX, ".mts": TS, ".cts": TS,
  ".go": {
    wasm: "tree-sitter-go",
    defs: { function_declaration: "function", method_declaration: "method", type_spec: "type" },
  },
  ".rs": {
    wasm: "tree-sitter-rust",
    defs: { function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait" },
  },
  ".java": {
    wasm: "tree-sitter-java",
    defs: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      method_declaration: "method",
      constructor_declaration: "constructor",
    },
  },
};

/** 该路径是否有支持的语言。 */
export function langKeyForPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return LANGS[ext] ? ext : undefined;
}

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
const langCache = new Map<string, Promise<Parser.Language>>();

async function getParser(langKey: string): Promise<Parser> {
  if (!initPromise) {
    const wtsDir = dirname(require.resolve("web-tree-sitter"));
    initPromise = Parser.init({ locateFile: (name: string) => join(wtsDir, name) });
  }
  await initPromise;
  const cfg = LANGS[langKey];
  let langP = langCache.get(langKey);
  if (!langP) {
    langP = Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${cfg.wasm}.wasm`));
    langCache.set(langKey, langP);
  }
  const parser = new Parser();
  parser.setLanguage(await langP);
  return parser;
}

/**
 * 解析源码，返回符号大纲（按起止行排序）。langKey 为扩展名（如 ".py"）。
 * 不支持的语言抛错，调用方应先用 langKeyForPath 判定。
 */
export async function outlineSource(source: string, langKey: string): Promise<CodeSymbol[]> {
  const cfg = LANGS[langKey];
  if (!cfg) throw new Error(`不支持的语言：${langKey}`);
  const parser = await getParser(langKey);
  const tree = parser.parse(source);
  const lines = source.split("\n");
  const out: CodeSymbol[] = [];

  const TYPE_KINDS = new Set<SymbolKind>(["class", "interface", "struct", "trait", "enum"]);

  const walk = (node: Parser.SyntaxNode, parent: { name: string; kind: SymbolKind } | undefined): void => {
    let next = parent;
    const kind = cfg.defs[node.type];
    if (kind) {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        const startLine = node.startPosition.row + 1;
        // 裸 function 落在 class/interface/struct 内 → 视为 method
        const realKind: SymbolKind = kind === "function" && parent && TYPE_KINDS.has(parent.kind) ? "method" : kind;
        out.push({
          kind: realKind,
          name,
          container: parent?.name,
          startLine,
          endLine: node.endPosition.row + 1,
          signature: (lines[startLine - 1] ?? "").trim(),
        });
        next = { name, kind: realKind };
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, next);
    }
  };
  walk(tree.rootNode, undefined);
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

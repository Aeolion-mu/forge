/**
 * LaTeX → Unicode/纯文本 近似渲染。终端没有 MathJax，只能把常见 TeX 记号转成可读形式：
 *   \(...\) \[...\] $...$ $$...$$ 定界符剥离；\frac→a/b；上下标→Unicode；\pi→π；\boxed 解包等。
 * 覆盖 LLM 数学解答的常见子集，未知命令保持原样（不强行破坏）。
 */

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const OPS: Record<string, string> = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", simeq: "≃", cong: "≅",
  equiv: "≡", propto: "∝", ll: "≪", gg: "≫", doteq: "≐",
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕", otimes: "⊗",
  sum: "∑", prod: "∏", int: "∫", oint: "∮", coprod: "∐",
  to: "→", rightarrow: "→", longrightarrow: "⟶", Rightarrow: "⇒", implies: "⟹", leftarrow: "←",
  Leftarrow: "⇐", leftrightarrow: "↔", Leftrightarrow: "⇔", iff: "⟺", mapsto: "↦", uparrow: "↑", downarrow: "↓",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅", setminus: "∖",
  cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", backslash: "\\",
  prime: "′", Re: "ℜ", Im: "ℑ", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", deg: "°", angle: "∠", perp: "⊥", parallel: "∥",
};
const CMD: Record<string, string> = { ...GREEK, ...OPS };

const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", ".": "·",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ",
  m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};
const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ",
  r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

/** 整段映射成上/下标；任一字符无对应则返回 null（交给调用方退化处理）。 */
function mapAll(s: string, table: Record<string, string>): string | null {
  let out = "";
  for (const ch of s) {
    const m = table[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
}
function toSup(s: string): string {
  return mapAll(s, SUP) ?? (s.length > 1 ? `^(${s})` : `^${s}`);
}
function toSub(s: string): string {
  return mapAll(s, SUB) ?? (s.length > 1 ? `_(${s})` : `_${s}`);
}
/** 分子/分母含运算符或空格时加括号，避免 a+b/c 这类歧义。 */
function fracWrap(x: string): string {
  const t = x.trim();
  return /[+\-*/=\s]/.test(t) ? `(${t})` : t;
}

/** 把一段 TeX 数学式转成 Unicode/纯文本近似。 */
export function texToUnicode(input: string): string {
  let s = input;
  // 间距命令
  s = s.replace(/\\[,!:]/g, "").replace(/\\;/g, " ").replace(/\\ /g, " ").replace(/\\quad/g, "  ").replace(/\\qquad/g, "    ");
  // 换行 / 对齐符
  s = s.replace(/\\\\/g, " ").replace(/&/g, " ");
  // \left \right（含 \left. \right.）
  s = s.replace(/\\left\s*\./g, "").replace(/\\right\s*\./g, "").replace(/\\left\s*/g, "").replace(/\\right\s*/g, "");
  // 带花括号参数的命令：循环到稳定（每轮先消最内层的 {…}）
  for (let k = 0; k < 30; k++) {
    const before = s;
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a, b) => `${fracWrap(a)}/${fracWrap(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, a) => `√(${a})`)
      .replace(/\\(?:boxed|text|mathrm|mathbf|mathbb|mathcal|mathsf|mathtt|operatorname|mathit|hat|bar|vec|tilde|overline|underline)\s*\{([^{}]*)\}/g, (_m, a) => a)
      .replace(/\^\{([^{}]*)\}/g, (_m, a) => toSup(a))
      .replace(/_\{([^{}]*)\}/g, (_m, a) => toSub(a));
    if (s === before) break;
  }
  // 单字符上下标（^2 / _n）
  s = s.replace(/\^([^\s{}\\])/g, (_m, c) => toSup(c)).replace(/_([^\s{}\\])/g, (_m, c) => toSub(c));
  // 命令符号（希腊字母 / 运算符），未知命令原样保留
  s = s.replace(/\\([A-Za-z]+)/g, (m, name) => CMD[name] ?? m);
  // 转义符号
  s = s.replace(/\\([{}%$#&_ ])/g, "$1");
  // 残留分组花括号
  s = s.replace(/[{}]/g, "");
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** 内部像数学（含反斜杠 / 上下标 / 花括号）才转，避免误伤 "$5 和 $10" 这类货币。 */
function looksMath(s: string): boolean {
  return /[\\^_{}]/.test(s);
}

/** 处理一行文本里的行内公式：\(...\) \[...\] $$...$$ $...$。 */
export function convertInlineMath(text: string): string {
  let t = text.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => texToUnicode(inner));
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => texToUnicode(inner));
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_m, inner) => texToUnicode(inner));
  t = t.replace(/\$([^$\n]+)\$/g, (m, inner) => (looksMath(inner) ? texToUnicode(inner) : m));
  return t;
}

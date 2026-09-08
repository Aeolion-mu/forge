import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
// 0.85 起 pi-ai 根入口不再导出这些函数；/compat 是官方临时 shim（签名不变）。
import { getEnvApiKey, getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_RMB_PER_M, type Rate } from "./kernel/pricing.js";
import { defaultWritePaths, defaultReadDeny, expandHomePaths, type SandboxPolicy } from "./sandbox/policy.js";
import { buildCustomModel, type CustomModelEntry } from "./kernel/models.js";

/** forge.config.json 里的一条可选模型。 */
export interface ModelEntry {
  ref: string; // "provider/modelId"
  label: string;
}

/** 压缩触发设置（喂给库的 shouldCompact / compact）。 */
export interface CompactionConfig {
  /** 摘要提示 + 输出预留的 token。 */
  reserveTokens: number;
  /** 压缩后约保留多少最近上下文 token。 */
  keepRecentTokens: number;
}

/**
 * 模型请求重试 / 超时。透传给库的 streamOptions → DeepSeek 经 openai-completions →
 * OpenAI SDK 的内置退避重试（对 429/5xx/网络错误指数退避，尊重 Retry-After）。
 * 重试只在单次 HTTP 请求层做（安全）；整轮不重试，避免已执行的工具副作用被重放。
 */
export interface StreamConfig {
  /** 单请求最大重试次数（SDK 默认 2，这里默认 4 = 共 5 次尝试）。 */
  maxRetries: number;
  /** 服务端要求等待超过此上限即抛错（交上层带可见性处理）。默认 60s。 */
  maxRetryDelayMs: number;
  /** 单请求超时（不设则用 SDK 默认 10min；reasoning 模型可能跑很久）。 */
  timeoutMs?: number;
}

/** 运行时配置：当前模型 + 可切换清单 + 工作目录 + skills/会话/压缩。 */
export interface ForgeConfig {
  modelRef: string;
  provider: string;
  modelId: string;
  model: Model<Api>;
  /** 当前模型对应 provider 是否有 key（LIVE-only：无 key 启动即报错）。 */
  live: boolean;
  /** 思考强度：reasoning 模型默认 xhigh（DeepSeek → reasoning_effort:max），否则 off。 */
  thinkingLevel: ThinkingLevel;
  models: ModelEntry[];
  workdir: string;
  /** skills 目录（递归扫描 SKILL.md / 根级 .md）。 */
  skillsDirs: string[];
  /** JSONL 会话树存储根目录。 */
  sessionsDir: string;
  /** 审计日志路径。 */
  auditPath: string;
  /** 压缩设置。 */
  compaction: CompactionConfig;
  /** 模型请求重试 / 超时。 */
  stream: StreamConfig;
  /** 自建/内网 OpenAI 兼容端点（forge.config.json customModels）。 */
  customModels: CustomModelEntry[];
  /** 子 Agent / flash 分类器用的模型 ref；缺省跟随主模型（旧版写死 deepseek-v4-flash，
   *  key 失效时子 Agent 全空转、Convergent 验收静默变橡皮图章——已改为跟随主模型）。 */
  subagentModel: string;
  /** 每百万 token 定价（人民币）：内置默认 ⊕ forge.config.json 的 pricing 覆盖/扩充。 */
  pricing: Record<string, Rate>;
  /** 只读越界：允许 read_file/list_dir/glob/grep 读 workdir 外的绝对路径（写仍锁死 workdir）。默认 false。 */
  allowReadOutsideWorkdir: boolean;
  /** 虚拟上下文窗口上限（token）：设了就用它替代真实 contextWindow 算压缩触发(0.9)与保留(0.2)。
   *  用途：DeepSeek 1M 窗口压测太贵，降到如 200000 可低成本验证压缩质量。不设=用真实窗口。 */
  maxContextTokens?: number;
  /** 飞行记录仪：全量事件流落 JSONL（默认开，FORGE_FLIGHT_LOG=0 关）。 */
  flightLog: FlightLogConfig;
  /** SSH 连接档案（forge.config.json `ssh`）。非空才注册 ssh_run 工具——模型只能连声明过的 host。 */
  ssh: Record<string, SshProfile>;
  /** Linux 硬沙箱策略（bwrap+cgroups）。enabled 但无 bwrap/非 Linux 时自动降级为原软沙箱。 */
  sandbox: SandboxPolicy;
}

/** 一个 SSH 连接档案（forge.config.json 的 ssh.<name>）。模型只能连这里声明过的 host = 显式授权。 */
export interface SshProfile {
  /** 主机名 / IP（必填）。 */
  host: string;
  /** 登录用户名（可选；不填用 ssh 默认）。 */
  user?: string;
  /** 端口（可选，默认 22）。 */
  port?: number;
  /** 私钥路径（可选；支持 ~ 展开）。公网/不可信网络用这个。 */
  key?: string;
  /**
   * 明文密码（可选；走 SSH_ASKPASS 非交互喂入）。**仅限可信内网**——明文存配置文件、
   * 会被读进 agent 上下文；公网请用 key。设了 password 即走密码认证（不与 key 同用）。
   */
  password?: string;
}

/** 飞行记录仪配置。 */
export interface FlightLogConfig {
  /** 是否开启（默认 true）。 */
  enabled: boolean;
  /** 落盘目录（每次运行一个文件 <ts>-<sessionId>.jsonl）。 */
  dir: string;
  /** context 记录粒度：summary=增量流+压缩点快照（默认）；full=每轮整条 dump（最高保真，体积大）。 */
  contextMode: "summary" | "full";
}

interface ForgeFile {
  defaultModel?: string;
  models?: ModelEntry[];
  customModels?: CustomModelEntry[];
  subagentModel?: string;
  reserveTokens?: number;
  keepRecentTokens?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  maxContextTokens?: number;
  allowReadOutsideWorkdir?: boolean;
  pricing?: Record<string, Rate>;
  ssh?: Record<string, SshProfile>;
  sandbox?: Partial<SandboxPolicy>;
}

const BUILTIN: Required<Pick<ForgeFile, "defaultModel" | "models">> = {
  defaultModel: "deepseek/deepseek-v4-pro",
  models: [
    { ref: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro（默认）" },
    { ref: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

/** 极简 .env 加载器（不引第三方依赖）：把 .env 里的键值灌进 process.env。 */
/** 全局配置目录（机器级兜底：~/.forge；FORGE_GLOBAL_DIR 可覆盖——测试/多套环境用）。 */
export function globalConfigDir(): string {
  return process.env.FORGE_GLOBAL_DIR || join(homedir(), ".forge");
}

/** 解析一段 .env 文本并入 env（已存在的值不覆盖；`#` 注释与无等号行跳过）。导出供单测。 */
export function applyDotEnvText(text: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key && (env[key] === undefined || env[key] === "")) env[key] = val;
  }
}

// 全局安装（npm link 后在任意目录 `forge`）时，启动目录里往往没有 .env/forge.config.json——
// 机器级兜底 ~/.forge/（API key、ssh 档案这类「跟着机器走」的配置放这里）。
// 优先级：启动目录 > ~/.forge/；.env 逐文件叠加且不覆盖已有值 → 先到先得。
function loadDotEnv(): void {
  for (const file of [resolve(process.cwd(), ".env"), join(globalConfigDir(), ".env")]) {
    if (!existsSync(file)) continue;
    applyDotEnvText(readFileSync(file, "utf8"));
  }
}

/**
 * 校验 forge.config.json 的解析结果。已知字段类型不对就抛错（带具体问题），
 * 而非旧实现的 catch→{} 静默吞掉。未知字段忽略（前向兼容）。
 */
export function validateConfigFile(parsed: unknown, file = "forge.config.json"): ForgeFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}：顶层应是一个 JSON 对象。`);
  }
  const o = parsed as Record<string, unknown>;
  const out: ForgeFile = {};
  const issues: string[] = [];

  if (o.defaultModel !== undefined) {
    if (typeof o.defaultModel === "string" && o.defaultModel.trim()) out.defaultModel = o.defaultModel;
    else issues.push("defaultModel 应为非空字符串");
  }
  if (o.subagentModel !== undefined) {
    if (typeof o.subagentModel === "string" && o.subagentModel.trim()) out.subagentModel = o.subagentModel;
    else issues.push("subagentModel 应为非空字符串（provider/model 形式）");
  }
  if (o.customModels !== undefined) {
    if (!Array.isArray(o.customModels)) {
      issues.push("customModels 应为数组（OpenAI 兼容自建端点）");
    } else {
      const customs: CustomModelEntry[] = [];
      o.customModels.forEach((m, i) => {
        const mm = m as Record<string, unknown>;
        const bad = (why: string) => issues.push(`customModels[${i}] ${why}`);
        if (!mm || typeof mm !== "object") return bad("应为对象");
        if (!(typeof mm.ref === "string" && mm.ref.includes("/"))) return bad("ref 应为 \"provider/modelId\" 形式");
        if (!(typeof mm.baseUrl === "string" && /^https?:\/\//.test(mm.baseUrl))) return bad("baseUrl 应为 http(s) URL");
        if (!(typeof mm.contextWindow === "number" && Number.isFinite(mm.contextWindow) && mm.contextWindow > 0)) {
          return bad("contextWindow 应为正数");
        }
        // 未知字段报错（与 ssh 段同规矩：避免「配了却静默失效」）。
        const KNOWN = new Set(["ref", "label", "baseUrl", "contextWindow", "maxTokens", "reasoning", "apiKeyEnv", "compat"]);
        const unknown = Object.keys(mm).filter((k) => !KNOWN.has(k));
        if (unknown.length) return bad(`未知字段 ${unknown.join(", ")}`);
        if (mm.compat !== undefined && (typeof mm.compat !== "object" || mm.compat === null || Array.isArray(mm.compat))) {
          return bad("compat 应为对象（openai-completions 兼容层覆盖）");
        }
        customs.push({
          ref: mm.ref,
          ...(typeof mm.label === "string" ? { label: mm.label } : {}),
          baseUrl: mm.baseUrl,
          contextWindow: mm.contextWindow,
          ...(typeof mm.maxTokens === "number" ? { maxTokens: mm.maxTokens } : {}),
          ...(typeof mm.reasoning === "boolean" ? { reasoning: mm.reasoning } : {}),
          ...(typeof mm.apiKeyEnv === "string" ? { apiKeyEnv: mm.apiKeyEnv } : {}),
          ...(mm.compat ? { compat: mm.compat as Record<string, unknown> } : {}),
        });
      });
      out.customModels = customs;
    }
  }
  for (const k of ["reserveTokens", "keepRecentTokens", "maxRetries", "maxRetryDelayMs", "timeoutMs", "maxContextTokens"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    else issues.push(`${k} 应为非负数字`);
  }
  if (o.allowReadOutsideWorkdir !== undefined) {
    if (typeof o.allowReadOutsideWorkdir === "boolean") out.allowReadOutsideWorkdir = o.allowReadOutsideWorkdir;
    else issues.push("allowReadOutsideWorkdir 应为布尔值");
  }
  if (o.pricing !== undefined) {
    if (typeof o.pricing !== "object" || o.pricing === null || Array.isArray(o.pricing)) {
      issues.push("pricing 应为对象（modelRef → {cacheHit, miss, output}）");
    } else {
      const pricing: Record<string, Rate> = {};
      for (const [ref, v] of Object.entries(o.pricing as Record<string, unknown>)) {
        const r = v as Record<string, unknown>;
        const nums = ["cacheHit", "miss", "output"] as const;
        if (r && nums.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= 0)) {
          pricing[ref] = { cacheHit: r.cacheHit as number, miss: r.miss as number, output: r.output as number };
        } else {
          issues.push(`pricing["${ref}"] 应含非负数字字段 cacheHit / miss / output`);
        }
      }
      out.pricing = pricing;
    }
  }
  if (o.ssh !== undefined) {
    if (typeof o.ssh !== "object" || o.ssh === null || Array.isArray(o.ssh)) {
      issues.push("ssh 应为对象（profileName → {host, user?, port?, key?}）");
    } else {
      const ssh: Record<string, SshProfile> = {};
      const KNOWN_SSH_FIELDS = new Set(["host", "user", "port", "key", "password"]);
      for (const [name, v] of Object.entries(o.ssh as Record<string, unknown>)) {
        const p = v as Record<string, unknown>;
        if (!p || typeof p.host !== "string" || !p.host.trim()) {
          issues.push(`ssh["${name}"].host 应为非空字符串`);
          continue;
        }
        if (p.user !== undefined && typeof p.user !== "string") issues.push(`ssh["${name}"].user 应为字符串`);
        if (p.key !== undefined && typeof p.key !== "string") issues.push(`ssh["${name}"].key 应为字符串`);
        if (p.password !== undefined && typeof p.password !== "string") issues.push(`ssh["${name}"].password 应为字符串`);
        if (p.port !== undefined && !(typeof p.port === "number" && Number.isInteger(p.port) && p.port > 0 && p.port < 65536)) {
          issues.push(`ssh["${name}"].port 应为 1-65535 的整数`);
        }
        // 未知字段**报错**而非静默忽略——避免「配了却静默失效」（曾把 password 静默丢弃误导排查）。
        const unknown = Object.keys(p).filter((k) => !KNOWN_SSH_FIELDS.has(k));
        if (unknown.length) issues.push(`ssh["${name}"]：未知字段 ${unknown.join(", ")}（仅支持 host/user/port/key/password）`);
        ssh[name] = {
          host: p.host,
          ...(typeof p.user === "string" ? { user: p.user } : {}),
          ...(typeof p.port === "number" ? { port: p.port } : {}),
          ...(typeof p.key === "string" ? { key: p.key } : {}),
          ...(typeof p.password === "string" ? { password: p.password } : {}),
        };
      }
      out.ssh = ssh;
    }
  }
  if (o.sandbox !== undefined) {
    if (typeof o.sandbox !== "object" || o.sandbox === null || Array.isArray(o.sandbox)) {
      issues.push("sandbox 应为对象（enabled?/network?/writePaths?/memMax?/pidsMax?）");
    } else {
      const s = o.sandbox as Record<string, unknown>;
      const sb: Partial<SandboxPolicy> = {};
      if (s.enabled !== undefined) {
        if (typeof s.enabled === "boolean") sb.enabled = s.enabled;
        else issues.push("sandbox.enabled 应为布尔值");
      }
      if (s.network !== undefined) {
        if (typeof s.network === "boolean") sb.network = s.network;
        else issues.push("sandbox.network 应为布尔值");
      }
      if (s.memMax !== undefined) {
        if (typeof s.memMax === "string") sb.memMax = s.memMax;
        else issues.push('sandbox.memMax 应为字符串（如 "2G"，空串=不限）');
      }
      if (s.pidsMax !== undefined) {
        if (typeof s.pidsMax === "number" && Number.isInteger(s.pidsMax) && s.pidsMax >= 0) sb.pidsMax = s.pidsMax;
        else issues.push("sandbox.pidsMax 应为非负整数（0=不限）");
      }
      if (s.writePaths !== undefined) {
        if (Array.isArray(s.writePaths) && s.writePaths.every((p) => typeof p === "string")) sb.writePaths = s.writePaths as string[];
        else issues.push("sandbox.writePaths 应为字符串数组（绝对路径）");
      }
      if (s.readDeny !== undefined) {
        if (Array.isArray(s.readDeny) && s.readDeny.every((p) => typeof p === "string")) sb.readDeny = s.readDeny as string[];
        else issues.push("sandbox.readDeny 应为字符串数组（绝对路径，支持 ~）");
      }
      if (s.excluded !== undefined) {
        if (Array.isArray(s.excluded) && s.excluded.every((p) => typeof p === "string")) sb.excluded = s.excluded as string[];
        else issues.push("sandbox.excluded 应为字符串数组（命令头 token，如 brew）");
      }
      out.sandbox = sb;
    }
  }
  if (o.models !== undefined) {
    if (!Array.isArray(o.models)) {
      issues.push("models 应为数组");
    } else {
      const models: ModelEntry[] = [];
      o.models.forEach((m, i) => {
        const mm = m as Record<string, unknown>;
        if (mm && typeof mm.ref === "string" && typeof mm.label === "string") models.push({ ref: mm.ref, label: mm.label });
        else issues.push(`models[${i}] 应含字符串字段 ref 与 label`);
      });
      out.models = models;
    }
  }

  if (issues.length) throw new Error(`${file} 配置无效：\n- ${issues.join("\n- ")}`);
  return out;
}

function readConfigFile(): ForgeFile {
  // 启动目录优先；没有再看机器级 ~/.forge/forge.config.json（ssh 档案/默认模型等）
  const local = resolve(process.cwd(), "forge.config.json");
  const file = existsSync(local) ? local : join(globalConfigDir(), "forge.config.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`forge.config.json 不是合法 JSON：${(e as Error).message}`);
  }
  return validateConfigFile(parsed, "forge.config.json");
}

/** 自定义模型（customModels）配置，loadConfig 时填充；resolveModel/hasKey 用。 */
let activeCustomModels: CustomModelEntry[] = [];

/** 该 provider 当前是否有可用 key（自定义模型：keyless 端点恒 true；配了 apiKeyEnv 看 env）。 */
export function hasKey(provider: string): boolean {
  const custom = activeCustomModels.find((e) => e.ref.split("/")[0] === provider);
  if (custom) return custom.apiKeyEnv ? Boolean(process.env[custom.apiKeyEnv]) : true;
  return Boolean(getEnvApiKey(provider));
}

/** 把 "provider/modelId" 解析成具体 Model 对象（先查 customModels，再查 pi-ai 内置目录）。 */
export function resolveModel(ref: string): { provider: string; modelId: string; model: Model<Api> } {
  const slash = ref.indexOf("/");
  if (slash < 0) throw new Error(`模型 ref 需要 "provider/model" 形式，收到：${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const custom = activeCustomModels.find((e) => e.ref === ref);
  if (custom) return { provider, modelId, model: buildCustomModel(custom) };
  // getModel 泛型要求字面量；运行时是字符串，这里收口为一次断言。
  // 注意：getModel 对未知 provider/model 返回 undefined（不抛错），需自行校验。
  const model = getModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!model) throw new Error(`未知模型：${ref}（provider 或 modelId 不在 pi-ai 内置目录中，也不是 customModels）`);
  return { provider, modelId, model };
}

export function loadConfig(): ForgeConfig {
  loadDotEnv();
  const file = readConfigFile();

  activeCustomModels = file.customModels ?? [];
  const models = file.models?.length ? file.models : BUILTIN.models;
  // 优先级：环境变量 FORGE_MODEL > 配置文件 defaultModel > 内置默认
  const modelRef = process.env.FORGE_MODEL?.trim() || file.defaultModel || BUILTIN.defaultModel;
  const { provider, modelId, model } = resolveModel(modelRef);

  const workdir = resolve(process.cwd(), process.env.FORGE_WORKDIR || ".");

  return {
    modelRef,
    provider,
    modelId,
    model,
    live: hasKey(provider),
    customModels: activeCustomModels,
    subagentModel: process.env.FORGE_SUBAGENT_MODEL?.trim() || file.subagentModel || modelRef,
    // 默认把 reasoning 模型拉满（xhigh→DeepSeek reasoning_effort:max）；非 reasoning 模型关掉。
    thinkingLevel: (process.env.FORGE_THINKING as ThinkingLevel) || (model.reasoning ? "xhigh" : "off"),
    models,
    workdir,
    skillsDirs: [resolve(workdir, ".forge", "skills")],
    sessionsDir: resolve(process.cwd(), ".forge", "sessions"),
    auditPath: resolve(process.cwd(), ".forge", "audit.jsonl"),
    compaction: {
      // 默认对齐库的 DEFAULT_COMPACTION_SETTINGS；阈值按真实 model.contextWindow 判定，
      // 故不会出现「8000 窗口 + 16384 reserve 恒触发」的死循环。
      reserveTokens: Number(process.env.FORGE_RESERVE_TOKENS || file.reserveTokens || 16384),
      keepRecentTokens: Number(process.env.FORGE_KEEP_RECENT_TOKENS || file.keepRecentTokens || 20000),
    },
    stream: {
      maxRetries: Number(process.env.FORGE_MAX_RETRIES ?? file.maxRetries ?? 4),
      maxRetryDelayMs: Number(process.env.FORGE_MAX_RETRY_DELAY_MS ?? file.maxRetryDelayMs ?? 60000),
      ...(process.env.FORGE_TIMEOUT_MS || file.timeoutMs
        ? { timeoutMs: Number(process.env.FORGE_TIMEOUT_MS ?? file.timeoutMs) }
        : {}),
    },
    // 内置定价 ⊕ 配置覆盖（配置同 ref 优先）
    pricing: { ...DEFAULT_RMB_PER_M, ...file.pricing },
    allowReadOutsideWorkdir: process.env.FORGE_ALLOW_READ_OUTSIDE === "1" || file.allowReadOutsideWorkdir || false,
    ...(process.env.FORGE_MAX_CONTEXT_TOKENS || file.maxContextTokens
      ? { maxContextTokens: Number(process.env.FORGE_MAX_CONTEXT_TOKENS ?? file.maxContextTokens) }
      : {}),
    flightLog: {
      enabled: process.env.FORGE_FLIGHT_LOG !== "0", // 默认开，仅显式 "0" 关
      dir: resolve(process.cwd(), ".forge", "flight"),
      contextMode: process.env.FORGE_FLIGHT_CONTEXT === "full" ? "full" : "summary",
    },
    ssh: file.ssh ?? {}, // 仅来自 forge.config.json；非空才注册 ssh_run 工具
    sandbox: {
      // 默认开（Linux→bwrap / macOS→sandbox-exec，无后端大声降级）；FORGE_SANDBOX=0 一键关。
      enabled: process.env.FORGE_SANDBOX === "0" ? false : file.sandbox?.enabled ?? true,
      // D1：默认联网（npm/pip/git）；FORGE_SANDBOX_NET=0 或配置断网。
      network: process.env.FORGE_SANDBOX_NET === "0" ? false : file.sandbox?.network ?? true,
      // D2：只读根之外的可写口；默认 /tmp + HOME 常用缓存（**不含 ~/.config**——收紧旧默认）。
      writePaths: expandHomePaths(file.sandbox?.writePaths ?? defaultWritePaths()),
      // 读隐藏：默认禁读 ~/.ssh、~/.aws、~/.gnupg（防「读 key 走网络外传」）。
      readDeny: expandHomePaths(file.sandbox?.readDeny ?? defaultReadDeny()),
      // D3：资源限额（仅 Linux：systemd-run cgroup 优先，无 systemd 只隔离不限内存；macOS 无机制）。
      memMax: process.env.FORGE_SANDBOX_MEM ?? file.sandbox?.memMax ?? "2G",
      pidsMax: Number(process.env.FORGE_SANDBOX_PIDS ?? file.sandbox?.pidsMax ?? 512),
      // 豁免名单：沙箱内不可嵌套沙箱（brew/swift test 等）——命中则不沙箱执行 + 警告。
      excluded: file.sandbox?.excluded ?? (process.env.FORGE_SANDBOX_EXCLUDED ? process.env.FORGE_SANDBOX_EXCLUDED.split(",").map((s) => s.trim()).filter(Boolean) : []),
    },
  };
}

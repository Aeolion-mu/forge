import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEnvApiKey, getModel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_RMB_PER_M, type Rate } from "./kernel/pricing.js";

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
  /** 每百万 token 定价（人民币）：内置默认 ⊕ forge.config.json 的 pricing 覆盖/扩充。 */
  pricing: Record<string, Rate>;
  /** 只读越界：允许 read_file/list_dir/glob/grep 读 workdir 外的绝对路径（写仍锁死 workdir）。默认 false。 */
  allowReadOutsideWorkdir: boolean;
  /** 关闭 bash 写边界守卫（FORGE_ALLOW_WRITE_OUTSIDE=1）。默认 false（守卫开启）。 */
  allowWriteOutside: boolean;
  /** 虚拟上下文窗口上限（token）：设了就用它替代真实 contextWindow 算压缩触发(0.9)与保留(0.2)。
   *  用途：DeepSeek 1M 窗口压测太贵，降到如 200000 可低成本验证压缩质量。不设=用真实窗口。 */
  maxContextTokens?: number;
  /** 飞行记录仪：全量事件流落 JSONL（默认开，FORGE_FLIGHT_LOG=0 关）。 */
  flightLog: FlightLogConfig;
  /** SSH 连接档案（forge.config.json `ssh`）。非空才注册 ssh_run 工具——模型只能连声明过的 host。 */
  ssh: Record<string, SshProfile>;
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
  reserveTokens?: number;
  keepRecentTokens?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  maxContextTokens?: number;
  allowReadOutsideWorkdir?: boolean;
  pricing?: Record<string, Rate>;
  ssh?: Record<string, SshProfile>;
}

const BUILTIN: Required<Pick<ForgeFile, "defaultModel" | "models">> = {
  defaultModel: "deepseek/deepseek-v4-pro",
  models: [
    { ref: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro（默认）" },
    { ref: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

/** 极简 .env 加载器（不引第三方依赖）：把 .env 里的键值灌进 process.env。 */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key && (process.env[key] === undefined || process.env[key] === "")) process.env[key] = val;
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
  const file = resolve(process.cwd(), "forge.config.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`forge.config.json 不是合法 JSON：${(e as Error).message}`);
  }
  return validateConfigFile(parsed, "forge.config.json");
}

/** 该 provider 当前是否有可用 key。 */
export function hasKey(provider: string): boolean {
  return Boolean(getEnvApiKey(provider));
}

/** 把 "provider/modelId" 解析成具体 Model 对象。 */
export function resolveModel(ref: string): { provider: string; modelId: string; model: Model<Api> } {
  const slash = ref.indexOf("/");
  if (slash < 0) throw new Error(`模型 ref 需要 "provider/model" 形式，收到：${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  // getModel 泛型要求字面量；运行时是字符串，这里收口为一次断言。
  // 注意：getModel 对未知 provider/model 返回 undefined（不抛错），需自行校验。
  const model = getModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!model) throw new Error(`未知模型：${ref}（provider 或 modelId 不在 pi-ai 内置目录中）`);
  return { provider, modelId, model };
}

export function loadConfig(): ForgeConfig {
  loadDotEnv();
  const file = readConfigFile();

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
    allowWriteOutside: process.env.FORGE_ALLOW_WRITE_OUTSIDE === "1",
    ...(process.env.FORGE_MAX_CONTEXT_TOKENS || file.maxContextTokens
      ? { maxContextTokens: Number(process.env.FORGE_MAX_CONTEXT_TOKENS ?? file.maxContextTokens) }
      : {}),
    flightLog: {
      enabled: process.env.FORGE_FLIGHT_LOG !== "0", // 默认开，仅显式 "0" 关
      dir: resolve(process.cwd(), ".forge", "flight"),
      contextMode: process.env.FORGE_FLIGHT_CONTEXT === "full" ? "full" : "summary",
    },
    ssh: file.ssh ?? {}, // 仅来自 forge.config.json；非空才注册 ssh_run 工具
  };
}

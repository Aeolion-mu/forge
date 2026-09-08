#!/usr/bin/env node
/**
 * 按 skills/vendors/skills.lock.json 拉取/更新上游 skills 快照到 skills/vendors/<name>/。
 *   npm run skills:fetch              # 全量
 *   npm run skills:fetch -- --vendor geak   # 单刷一个
 * 行为：git clone --depth 1 --branch <ref> 到临时目录 → 只拷 <subpath>（缺省整仓，去掉 .git）
 *       → 覆盖 vendors/<name>/，并在其中落 .vendor-meta.json（repo / 解析到的 commit / 时间）。
 * 网络操作只在 main 里；parseLock / planFetch 是纯逻辑（test/skills-fetch.test.ts 覆盖）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LockEntry {
  repo: string;
  ref: string;
  license: string;
  subpath?: string;
}

export type VendorLock = Record<string, LockEntry>;

const ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]);

/** 解析并校验 lock 文本（未知 vendor 字段报错、协议白名单、subpath 不许绝对路径/穿越）。 */
export function parseLock(text: string, file = "skills.lock.json"): VendorLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${(e as Error).message}`);
  }
  const root = parsed as { vendors?: unknown };
  if (typeof parsed !== "object" || parsed === null || !root.vendors || typeof root.vendors !== "object") {
    throw new Error(`${file} 应含 vendors 对象（vendorName → {repo, ref, license, subpath?}）`);
  }
  const out: VendorLock = {};
  const KNOWN = new Set(["repo", "ref", "license", "subpath"]);
  for (const [name, v] of Object.entries(root.vendors as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    const bad = (why: string): never => { throw new Error(`${file}：vendors["${name}"] ${why}`); };
    if (!e || typeof e !== "object") bad("应为对象");
    const unknown = Object.keys(e).filter((k) => !KNOWN.has(k));
    if (unknown.length) bad(`未知字段 ${unknown.join(", ")}`);
    if (typeof e.repo !== "string" || !/^https?:\/\/.+\.(git)?$|^https?:\/\/.+\/.+/.test(e.repo)) bad("repo 应为 http(s) Git URL");
    if (typeof e.ref !== "string" || !e.ref.trim()) bad("ref 应为非空字符串（分支/标签名）");
    if (typeof e.license !== "string" || !ALLOWED_LICENSES.has(e.license)) {
      bad(`license 须为 ${[...ALLOWED_LICENSES].join("/")} 之一（协议纪律：非标协议内容不得 vendor）`);
    }
    if (e.subpath !== undefined) {
      if (typeof e.subpath !== "string" || !e.subpath.trim()) bad("subpath 应为非空字符串");
      if (isAbsolute(e.subpath) || e.subpath.includes("..")) bad("subpath 不允许绝对路径或 .. 穿越");
    }
    out[name] = {
      repo: e.repo,
      ref: e.ref,
      license: e.license,
      ...(e.subpath ? { subpath: e.subpath } : {}),
    };
  }
  return out;
}

export interface FetchPlanItem {
  name: string;
  repo: string;
  ref: string;
  subpath?: string;
  /** 落盘目标（vendors 根由调用方给，便于测试注入临时目录）。 */
  dest: string;
}

/** 计算拉取计划（--vendor 过滤；目标 = vendorsRoot/<name>）。 */
export function planFetch(lock: VendorLock, vendorsRoot: string, only?: string): FetchPlanItem[] {
  const names = Object.keys(lock).sort();
  const selected = only ? names.filter((n) => n === only) : names;
  if (only && !selected.length) throw new Error(`lock 里没有 vendor「${only}」（可选：${names.join(", ") || "（空）"}）`);
  return selected.map((name) => {
    const e = lock[name]!;
    return { name, repo: e.repo, ref: e.ref, ...(e.subpath ? { subpath: e.subpath } : {}), dest: join(vendorsRoot, name) };
  });
}

const VENDORS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/vendors");

function sh(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}

async function main(): Promise<void> {
  const only = process.argv.includes("--vendor") ? process.argv[process.argv.indexOf("--vendor") + 1] : undefined;
  const lockFile = join(VENDORS_ROOT, "skills.lock.json");
  if (!existsSync(lockFile)) throw new Error(`未找到 ${lockFile}`);
  const lock = parseLock(readFileSync(lockFile, "utf8"));
  const plan = planFetch(lock, VENDORS_ROOT, only);
  for (const item of plan) {
    const tmp = mkdtempSync(join(tmpdir(), "forge-vendor-"));
    try {
      process.stdout.write(`→ ${item.name}：clone ${item.repo}@${item.ref}…\n`);
      sh("git", ["clone", "--depth", "1", "--branch", item.ref, item.repo, tmp]);
      const sha = sh("git", ["rev-parse", "HEAD"], tmp);
      const src = item.subpath ? join(tmp, item.subpath) : tmp;
      if (!existsSync(src)) throw new Error(`源仓里没有 subpath：${item.subpath}`);
      rmSync(item.dest, { recursive: true, force: true });
      cpSync(src, item.dest, { recursive: true });
      rmSync(join(item.dest, ".git"), { recursive: true, force: true });
      writeFileSync(join(item.dest, ".vendor-meta.json"), `${JSON.stringify({ repo: item.repo, ref: item.ref, commit: sha, license: lock[item.name]!.license }, null, 2)}\n`, "utf8");
      process.stdout.write(`  ✓ ${item.name} @ ${sha.slice(0, 10)} → ${item.dest}\n`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  process.stdout.write(plan.length ? `完成：${plan.length} 个 vendor 已更新。\n` : "lock 为空，无事可做。\n");
}

// 直接运行（被 import 时不执行网络操作）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}

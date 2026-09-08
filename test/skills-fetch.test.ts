import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLock, planFetch } from "../scripts/skills-fetch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("仓库真实 skills.lock.json 可解析（协议白名单内、URL/ref 合法）", () => {
  const lock = parseLock(readFileSync(join(REPO_ROOT, "skills/vendors/skills.lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), [
    "amd-skills", "flagos-skills", "geak", "kernelflow-cuda-optimizer", "metax-tileops", "tensormux-kernel-skills",
  ]);
  assert.equal(lock.geak!.subpath, "perf_knowledge/expert_skills");
});

test("parseLock：坏 JSON / 缺 vendors / 未知字段 / 协议白名单 / subpath 穿越 → 报错", () => {
  assert.throws(() => parseLock("{"), /不是合法 JSON/);
  assert.throws(() => parseLock("{}"), /应含 vendors 对象/);
  assert.throws(() => parseLock(JSON.stringify({ vendors: { x: { repo: "https://a/b", ref: "main", license: "MIT", oops: 1 } } })), /未知字段 oops/);
  assert.throws(() => parseLock(JSON.stringify({ vendors: { x: { repo: "https://a/b", ref: "main", license: "CANN-OSL" } } })), /license 须为/);
  assert.throws(() => parseLock(JSON.stringify({ vendors: { x: { repo: "https://a/b", ref: "main", license: "MIT", subpath: "../up" } } })), /穿越/);
  assert.throws(() => parseLock(JSON.stringify({ vendors: { x: { repo: "not-a-url", ref: "main", license: "MIT" } } })), /repo 应为/);
});

test("planFetch：全量排序、--vendor 过滤、未知 vendor 报错、dest 拼接", () => {
  const lock = {
    b: { repo: "https://x/b", ref: "main", license: "MIT" },
    a: { repo: "https://x/a", ref: "v1", license: "Apache-2.0", subpath: "skills" },
  };
  const all = planFetch(lock, "/vendors");
  assert.deepEqual(all.map((p) => p.name), ["a", "b"]); // name 排序（确定性）
  assert.equal(all[0]!.dest, "/vendors/a");
  assert.equal(all[0]!.subpath, "skills");
  assert.equal(all[1]!.subpath, undefined);

  const one = planFetch(lock, "/vendors", "b");
  assert.equal(one.length, 1);
  assert.equal(one[0]!.name, "b");

  assert.throws(() => planFetch(lock, "/vendors", "nope"), /没有 vendor「nope」/);
});

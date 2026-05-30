import { loadSkills } from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const toPosix = (p: string) => p.replace(/\\/g, "/");
const baseName = (p: string) => toPosix(p).replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * 跨平台 skills 加载。
 *
 * 背景：pi-agent-core@0.75.4 的 `loadSkills` 内部用纯 `/` 字符串算相对路径
 * （skills.js 的 relativeEnvPath / dirnameEnvPath），但 NodeExecutionEnv 在
 * Windows 上经 path.resolve 返回 `\` 路径。结果 relativeEnvPath 削不掉根前缀，
 * 把绝对路径当相对路径传给 `ignore`，后者严格拒绝绝对路径并 throw：
 *   `Fatal: path should be a path.relative()'d string`
 *
 * 这里给 env 包一层 Proxy，把它返回的所有 path 归一成 `/`（Node 在 Windows 上
 * 同样接受正斜杠，fs 操作不受影响），库内部的相对路径计算便能正常工作。
 * 同一个 `/`-only 假设还坑了 NodeExecutionEnv：fileInfoFromStats 用
 * `path.split("/").pop()` 取 basename，Windows 反斜杠路径切不开，`entry.name`
 * 退化成完整路径，导致 `entry.name !== "SKILL.md"` 永真、子目录 skill 永不被识别。
 * 故 wrapper 同时按归一后的路径重算 `name`。
 *
 * POSIX 平台上 toPosix / baseName 都是恒等行为，零副作用。
 */
export function loadSkillsCrossPlatform(env: NodeExecutionEnv, dirs: string[]) {
  const wrapped = new Proxy(env, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      switch (prop) {
        case "fileInfo":
          return async (p: string) => {
            const r = await orig.call(target, p);
            if (!r.ok) return r;
            const path = toPosix(r.value.path);
            return { ...r, value: { ...r.value, path, name: baseName(path) } };
          };
        case "listDir":
          return async (...a: unknown[]) => {
            const r = await orig.call(target, ...a);
            if (!r.ok) return r;
            return {
              ...r,
              value: r.value.map((e: { path: string }) => {
                const path = toPosix(e.path);
                return { ...e, path, name: baseName(path) };
              }),
            };
          };
        case "canonicalPath":
          return async (...a: unknown[]) => {
            const r = await orig.call(target, ...a);
            return r.ok ? { ...r, value: toPosix(r.value) } : r;
          };
        default:
          return orig.bind(target);
      }
    },
  });
  return loadSkills(wrapped, dirs.map(toPosix));
}

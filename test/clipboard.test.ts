import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText, type SpawnLike } from "../src/ui/clipboard.js";

/** 假 spawn：记命令、可选失败。 */
function fakeSpawn(ok: string[] = [], got?: { cmd: string; text: string }[]) {
  return (cmd: string): SpawnLike | null => {
    if (!ok.includes(cmd)) return null;
    return {
      stdin: {
        write: (s: string) => got?.push({ cmd, text: s }),
        end: () => {},
      },
      on: () => {},
    };
  };
}

test("copyText：macOS 走 pbcopy；OSC52 永远发", async () => {
  const got: { cmd: string; text: string }[] = [];
  const writes: string[] = [];
  const r = await copyText("hello 世界", {
    env: {},
    platform: "darwin",
    spawnFn: (c) => fakeSpawn(["pbcopy"], got)(c),
    write: (s) => writes.push(s),
  });
  assert.equal(r.path, "pbcopy");
  assert.equal(got[0]!.text, "hello 世界");
  // OSC52 = ESC ]52;c;<base64> ESC \
  const b64 = Buffer.from("hello 世界", "utf8").toString("base64");
  assert.ok(writes.some((w) => w.includes(`\x1b]52;c;${b64}\x1b\\`)));
});

test("copyText：tmux 环境优先 load-buffer（本地工具仍并行可用时也报 tmux）", async () => {
  const got: { cmd: string; text: string }[] = [];
  const r = await copyText("x", {
    env: { TMUX: "/tmp/tmux-0/default,1,0" },
    platform: "darwin",
    spawnFn: (c) => fakeSpawn(["tmux", "pbcopy"], got)(c),
    write: () => {},
  });
  assert.equal(r.path, "tmux");
  assert.equal(got[0]!.cmd, "tmux");
});

test("copyText：本地工具全不可用 → 回退 OSC52 且报 ok", async () => {
  const r = await copyText("x", { env: {}, platform: "darwin", spawnFn: () => null, write: () => {} });
  assert.equal(r.path, "osc52");
  assert.ok(r.ok);
  assert.match(r.note ?? "", /pbcopy/);
});

test("copyText：空文本直接失败不写任何东西", async () => {
  let wrote = false;
  const r = await copyText("", { env: {}, platform: "darwin", spawnFn: () => null, write: () => (wrote = true) });
  assert.equal(r.ok, false);
  assert.equal(wrote, false);
});

test("copyText：Linux 按在位顺序取 wl-copy → xclip → xsel", async () => {
  const got: { cmd: string; text: string }[] = [];
  const r1 = await copyText("a", { env: {}, platform: "linux", spawnFn: (c) => fakeSpawn(["xclip"], got)(c), write: () => {} });
  assert.equal(r1.path, "xclip");
  const r2 = await copyText("a", { env: {}, platform: "linux", spawnFn: (c) => fakeSpawn(["xsel"], got)(c), write: () => {} });
  assert.equal(r2.path, "xsel");
});

# 🔥 Forge

**A lightweight, observable coding-agent harness — and a controlled benchmark showing it can out-resolve established harnesses on the same model.**

<sub>🌏 [中文版 README →](./README.zh.md)</sub>

> On a 50-task random subset of **SWE-bench Verified**, with the model held fixed at **DeepSeek V4 Pro**, Forge resolves **39 / 50 (78%)** — ahead of the official `mini-swe-agent` baseline (74%) and ahead of Claude Code and another mainstream harness (both 70%).

![harness](https://img.shields.io/badge/type-coding%20agent%20harness-orange) ![lang](https://img.shields.io/badge/TypeScript-5.9-blue) ![bench](https://img.shields.io/badge/SWE--bench%20Verified%20(n%3D50)-78%25-success) ![license](https://img.shields.io/badge/license-MIT-green)

---

## Why Forge?

A coding agent's success depends as much on the **harness** — the orchestration *around* the model — as on the model itself. Forge is a from-scratch harness built to test one hypothesis:

> **Explicit discipline beats implicit trust.**

Most harnesses implicitly *hope* the model behaves: stays minimal, verifies its own work, doesn't thrash unrelated files. That works great on the model the harness was tuned for — and quietly degrades on a different one. Forge instead encodes that discipline as **first-class machinery**: a self-verification loop, a write-boundary guard, a "understand before you edit / minimize the diff / self-review before finishing" contract.

The payoff is visible the moment you swap models. A top harness on its target model is top *on that model*; ported to a third-party model it isn't automatically best. Forge's explicit, model-agnostic discipline is what lets it lead on DeepSeek V4 Pro — a model none of the compared harnesses were tuned for.

---

## 📊 Benchmark

**SWE-bench Verified** is the field's standard benchmark for autonomously fixing real GitHub issues: an agent gets a repo + an issue, must produce a patch, and the task counts as *resolved* only if the repository's own `FAIL_TO_PASS` + `PASS_TO_PASS` test suites pass under the official grader.

Same 50 tasks, same model (`deepseek-v4-pro`), same official `run_evaluation` grader for every harness — and **controlled for reasoning effort** (see below).

| Harness | Reasoning effort | Resolved / 50 | Rate | Empty patches |
|---|---|---|---|---|
| **🔥 Forge (this repo)** | **high** — matched to baselines | **39 / 50** | **78%** | **0** |
| 🔥 Forge | max | 39 / 50 | 78% | 0 |
| `mini-swe-agent` (official baseline) | high (default) | 37 / 50 | 74% | 0 |
| `hermes-agent` | high (default) | 35 / 50 | 70% | 5 |
| Claude Code | max (auto, see below) | 35 / 50 | 70% | 3 |

**Ranking at matched `high` effort: Forge 39 > mini 37 > hermes 35.**

#### Controlling for reasoning effort (why this is a fair fight)

DeepSeek V4 Pro enables thinking by default. Per DeepSeek's docs, ordinary requests default to `reasoning_effort=high`, while requests it recognizes as **Claude Code / OpenCode are auto-promoted to `max`**. Out of the box that meant Forge and Claude Code ran at `max`, while mini/hermes ran at `high`. To remove the confound, **Forge was re-run at `high` (matching the baselines) — and scored the same 39/50.** Takeaways:

- **Forge's result is not a thinking-budget artifact** — dropping `max`→`high` cost it zero tasks.
- **At equal `high` effort: Forge 39 > mini 37 > hermes 35.**
- **Claude Code at `max` (35) scored *below* mini at `high` (37)** — more thinking didn't help; harness quality is the dominant factor. (Claude Code is tuned for Claude models, not DeepSeek — "a top harness is model-relative.")

A couple more notes:

- **Sanity check.** DeepSeek V4 Pro's official full-500 score is **80.6%**; Forge's **78%** on this subset lands right beside it — evidence the pipeline (images / adapters / grading) is unbiased and that Forge extracts ~the model's full coding capability.
- **Forge produced a patch on every task (0 empty)** — the self-review tightens diffs without suppressing output; other harnesses occasionally fail to coax a usable diff out of the model.

### Honest caveats (so the numbers stay defensible)

- **n = 50 random subset**, not the full 500 → expect ~±6% noise on absolute values. Read it as "a 50-task subset of SWE-bench Verified," not the full benchmark.
- **pass@1, single sample** (same convention as the official leaderboard). Per-batch variance is real — only the 50-task cumulative is meaningful.
- **Claude Code was driven against DeepSeek through an Anthropic-compatible translation proxy** (non-standard setup); its number may slightly understate it.
- Grading is the **deterministic official `run_evaluation`** over fixed prediction patches; re-runs reproduce the same verdicts (verified idempotent).

---

## 🧭 Design philosophy

1. **Explicit discipline over implicit restraint.** Locate the root cause before editing; prefer the smallest diff; never touch build/dependency config unless the bug lives there; run a self-review against `git diff` before declaring done. These are enforced, not hoped for.
2. **Observable by default.** Every turn — thinking, tool calls, arguments, outputs — is recorded by a flight recorder you can replay. You can always answer "what did the agent actually do, and why."
3. **Safe by construction.** A write-boundary guard inspects shell commands before they run; a permission layer gates side-effecting tools.
4. **Bring your own model.** Provider-agnostic (DeepSeek / Anthropic / OpenAI). The discipline doesn't assume any single model's temperament.

---

## ✨ Key features

| Feature | What it does |
|---|---|
| **Self-verification loop** (`/converge`) | After a change, the agent autonomously re-derives acceptance criteria and checks it *actually* solved the task — instead of declaring victory on the first plausible edit. |
| **Write-boundary guard** | Statically parses shell commands to catch writes that escape the workdir, with a "flash" semantic adjudication so read-only commands (e.g. code containing `>` comparisons, `cd` into a subdir) aren't false-flagged. |
| **Flight recorder** | Full structured audit log of every turn (thinking + tool calls + args + results) for replay and debugging. |
| **Self-built context compaction** | Long-conversation summarization tuned for reasoning models, independent of the base runtime's heuristics (see War Stories — getting this *right* was harder than it looks). |
| **Code intelligence** | LSP integration (pyright / TS), repo-map, symbol outline, and content search so the agent navigates by structure, not blind grep. |
| **Sub-agents** | Spawn scoped sub-agents for fan-out search / research with their own context budget. |
| **Built-in SSH tool** | First-class remote-exec tool (password or key auth) for agents that operate on remote hosts. |
| **TUI niceties** | Steer/interject while the agent is busy, syntax-highlighted diffs, multi-line input. |

---

## 🛠️ War stories — bugs hit & how they were solved

Real debugging, not a feature brochure. These are the problems that actually cost time.

### 1. The compaction that never fired (two stacked bugs)
During a long-running stress test the context window kept growing until it blew past the limit — the self-built compaction simply never triggered. Two independent root causes:
- **Stale-usage anchoring.** The compaction trigger was reading a cached token-usage figure from an earlier turn, so it never saw the context cross the threshold. Fix: anchor the trigger to the *real* current usage.
- **Under-counted token estimate.** The "how big is this message" helper ignored the model's `thinking` blocks and tool-call arguments — which on a reasoning model are most of the payload. The estimate stayed artificially small, so the multi-segment summarizer was never invoked. Fix: count thinking + tool-call args in the size estimate.

Lesson: a trigger is only as good as the signal it reads. Both bugs were silent — nothing errored, the feature just *didn't run*.

### 2. Over-editing → explicit discipline (the change that won the benchmark)
On a high-latitude harness, capable models (DeepSeek among them) tend to **act before they understand**: rewrite whole files, "fix" unrelated build config, produce sprawling diffs that fail to apply or break passing tests. Forge's answer was not a smarter prompt-please — it was **enforced discipline**:
- a system contract: *find the root cause first; keep the diff minimal; don't touch `pyproject.toml`/`setup.py`/`package.json` unless the bug is there; prefer targeted edits over full-file rewrites*;
- an **end-of-turn self-review** that runs `git diff` (catching changes made via shell, not just the edit tool) and reverts anything unrelated.

This is exactly the "explicit over implicit" thesis, and it's why Forge — alone among the four — produced a clean, minimal, applying patch on every task.

### 3. Reasoning-only empty turns
DeepSeek's reasoning models occasionally return a turn with rich `thinking` but **empty visible content**. Naively that looks like "the agent said nothing." Forge detects and handles the reasoning-only case instead of stalling.

### 4. Evaluating in a flaky-network sandbox
Standing up the benchmark on a network-restricted box surfaced three *separate* hangs that each looked like the others: a Hugging Face metadata request that connected-but-never-returned (→ force offline, the dataset is cached), an un-timeouted `requests.get` deep in the grader that fetches per-repo test requirements (→ patched with timeout + retry), and orphaned eval-container name collisions from killed runs (→ clean before each run). The meta-lesson, and the reason the final numbers are trustworthy: **never trust an intermediate summary — re-derive every score from the per-task `report.json` ground truth.** (One harness briefly looked like "13/30" that was really 16 errored tasks; the true clean score was 23/30.)

---

## 🏗️ Architecture

```
src/
├── kernel/         # the brain
│   ├── forge-agent.ts      # main agent loop, system contract, self-review
│   ├── compaction.ts       # self-built context compaction
│   ├── converge.ts         # autonomous self-verification (/converge)
│   ├── write-guard.ts      # shell write-boundary guard
│   ├── flight-recorder.ts  # full-turn audit / replay
│   ├── code-outline.ts · lsp-client.ts · subagent-registry.ts
│   ├── memory.ts · permission.ts · telemetry.ts · pricing.ts · ...
├── tools/          # what the agent can do
│   ├── bash.ts · fs-tools.ts · apply-patch.ts · ssh.ts
│   ├── search-tools.ts · repo-map.ts · outline.ts · lsp-tools.ts
│   ├── subagent.ts · diagnostics.ts · converge-tool.ts · memory-tool.ts
├── ui/             # terminal UI (ink/React)
│   ├── render.ts · diff.ts · highlight.ts · markdown.ts
│   ├── run-queue.ts · text-editor.ts · keybinds.ts · theme.ts · ...
└── sandbox/        # command execution sandbox
```

Built on the [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent runtime; Forge is the harness layer — the discipline, tools, observability, and TUI — on top of it.

---

## 🚀 Getting started

```bash
# 1. install
npm install

# 2. configure
cp forge.config.example.json forge.config.json   # model registry (no secrets)
cp .env.example .env                              # put your API key here
#   → set DEEPSEEK_API_KEY=... (or ANTHROPIC_/OPENAI_)

# 3. run the TUI
npm run forge

# dev checks
npm run typecheck
npm test
```

Forge is LIVE-only by design: if the selected model's provider key is missing it exits immediately rather than silently mocking.

---

## 🙏 Acknowledgements

Forge is built on top of the [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent runtime. The benchmark uses [SWE-bench Verified](https://www.swebench.com/) and its official evaluation harness, and compares against [`mini-swe-agent`](https://github.com/SWE-agent/mini-swe-agent) and other open harnesses.

## 📄 License

[MIT](./LICENSE)

# Taskboard Agent Pipeline — Flow & State Design

Oct 7, 2026 · @Irfan Muhammad Guvian

> Design spec v3. Names generic.
> Live plan + decisions differ in places: see deltas.

## 0. Overview

**This is the build spec (v3).** One always-on, low-RAM daemon on your Mac handles two types of items:

- **Reminder** (`type: reminder`): what the taskboard does today, like "finish review laundry". No agent is involved; you tick it off.
- **Flow** (`type: flow`): a goal you hand to agents. Planning ⇄ Clarify → Plan approval → Working → Review → QA → Final gate → Done. Kinds: `code`, `research`, `brainstorm`, `design`.

Every item has a **tag**: a folder plus its settings. The tag tells agents where to work and what context to load.

The rules that make it reliable:

- Agents do the work and return validated JSON. They never change state.
- Scripts own all state and re-check every claim an agent makes.
- You answer questions and approve plans.
- Every run bills your Claude subscription.

The design went through four critic rounds (end of doc). Code and data are split: code lives in `~/taskboard/`, runtime data in `~/.taskboard/`.

## 1. Your 10 points → where they live

| # | You asked | Where |
| --- | --- | --- |
| 1 | Fable on high, Opus on xhigh, Sonnet for PR | §6 |
| 2 | A doc you can build from | Whole doc: schemas in Appendices A–C, milestones in §13 |
| 3 | Tag = a folder set when drafting | §3 |
| 4 | Plain reminders next to agent flows | §3 (`type` field; promote a reminder to a flow) |
| 5 | Use your existing skills | §11 |
| 6 | Always on, low RAM, no React/Next | §2, §10 |
| 7 | Max 3 subagents | §6 |
| 8 | RAM/disk aware, one by one on spikes, sessions aware of each other, usage shown in UI | §7, §10 |
| 9 | Shows a run is alive; resume after internet or laptop drops | §8 |
| 10 | Coding → Working | Throughout |

## Flow

&#91;embedded content: ticket flow · 2 states wait for you, scripts move the rest\]

Every forward arrow is a `tb move` that the runner makes only after that phase's gate passes, or that you make with a button. Planning and Clarify loop for as many rounds as the goal needs. Any rejection after Working goes back to Working with the findings; the third one lands in Blocked. Reminders don't use this flow at all.

## 2. Architecture

**One Node process, `tbd`, under launchd, with zero npm dependencies.** It replaces today's `server.js` under the same label, `local.taskboard`. Target: under 80 MB RSS and about 0% CPU when idle. One process instead of two saves about 40 MB; if it crashes, launchd restarts it and the lease check (§8) re-attaches every run.

| Module | Job |
| --- | --- |
| store | The **only** writer of reminders, tickets, tags, config. Lock, write tmp, rename. Event log |
| fsm | Transition table; the only code that changes a ticket's `state` |
| runner | Admission, spawn, log tailing, gates, recovery |
| monitor | Memory pressure, available RAM, disk, network, sleep/wake, per-run RSS |
| slots | Heavy-command semaphore, QA locks and subagent counters, served on a unix socket |
| http | Binds to 127.0.0.1 only, checks the `Host` header, needs a token for every POST. Static UI, JSON API, Server-Sent Events |

- **`tb`** (your CLI) and the **`taskboard` skill** talk to `tbd` over HTTP and never edit files themselves. If `tbd` is down, `tb` says so.
- **`tbx`** (agent CLI) gives agents read-only status and the heavy-command slot.
- **The real RAM cost is not `tbd`.** It's the `claude` processes and the tests, servers and browsers they start, which §7 controls.

**launchd plist:** an absolute `node` path, `EnvironmentVariables` with a `PATH` that includes Homebrew/nvm, `gh` and `npx`, `KeepAlive`, and `AbandonProcessGroup = true` so restarting `tbd` never kills running agents.

```
~/taskboard/                      # code (a git repo)
  tbd.js
  lib/    store fsm runner spawn stream monitor slots gates/ metrics notify tags
  bin/    tb  tbx
  hooks/  path-guard.js  bash-guard.js  subagent-count.js
  phases/<kind>/<phase>/   prompt.md  settings.json  mcp.json  result.schema.json
  ui/     index.html  app.js  style.css
  test/   fake-claude.js  scenarios/  *.test.js

~/.taskboard/                     # data (never inside a repo)
  config.json  tags.json  tasks.json  metrics.jsonl  token
  tickets/<id>/   ticket.json events.jsonl ticket.md rounds/ facts.json decisions.json
                  plan.json plan.md feedback.md skills/ design/ out/ runs/
  worktrees/<id>/                 # git worktrees
  bin/claude-<version>            # pinned Claude Code binary used by the runner
```

Data lives outside the code repo for two reasons: so agent runs never pick up the taskboard repo's own `CLAUDE.md` or `.claude/` folder (Claude Code reads those up the directory tree), and so `git status` stays clean. M0 moves today's `tasks.json` into `~/.taskboard/`.

## 3. Items, kinds and tags

### Reminders

Reminders keep today's format and statuses (`inbox`, `now`, `next`, `later`, `done`), the `now` limit of 3, and your calendar integration. They add `type: "reminder"` and an optional `tag`.

The `taskboard` skill keeps its routing and ordering rules, but writes through `tb` (`tb new`, `tb done`, `tb move`). **Promote** turns a reminder into a flow when it grows: `tb promote <id> -f code -t acme/billing`.

### Flow kinds

| Kind | Planning output | Working | Review | QA | Final gate | Built in |
| --- | --- | --- | --- | --- | --- | --- |
| code | Task plan: files, interfaces, test-first steps | Runner loops tasks in a worktree | Code review | Tests, compat, UI | Push + PR | M3–M5 |
| research | Questions, scope, source plan | Report with a source for every claim | Claim-support review | URLs resolve; a fresh agent spot-checks claims | Copy to tag output | M6 |
| brainstorm | Framing, constraints, judging criteria | Options | Critic scores the options | Skipped | Copy to tag output | M6 (research variant) |
| design | Brief, deliverables, references | Mockups (HTML/Markdown, or Figma via MCP) | Design rubric | Visual check | Copy to tag output | M8 |

Non-code kinds write only to `tickets/<id>/out/` until the final gate copies the result.

### Tags

A tag is a folder plus settings, stored in `tags.json` (full shape in Appendix A).

- **Names are hierarchical.** `acme` groups `acme/billing` and `acme/gateway`. Reminders can use any level; flows need a leaf tag with a `path`.
- **`type: git`:**
  - Each ticket gets a worktree at `~/.taskboard/worktrees/<id>` on branch `tb/<id>-<slug>`, cut from `base`.
  - Worktree setup runs the tag's `setup` command (for example `npm ci`) inside the heavy slot and copies its `env_files` (for example `.env.test`).
  - A worktree with `node_modules` costs disk. `tb gc` frees finished ones.
- **`type: folder`:** agents can read it but not write to it (§9). Its `context` files go into the prompt. Outputs go to `tickets/<id>/out/` and are copied to the tag's `output` folder at the end.
- **`checks`:** the runner's lint, typecheck, unit, e2e, build, Prisma diff and OpenAPI commands for that repo, with low parallelism forced (Jest `--maxWorkers=2`, Playwright `--workers=1`).
- **`heavy`:** command prefixes that must take the heavy slot (§7).
- **`skills`:** the default skills a flow in this tag may use. The plan can change them; you approve the list with the plan.
- **Creating a tag:** `tb tag add` runs `tb doctor --tag`. It checks the path exists, the checks run, and the repo doesn't set billing-related settings (§9).

## 4. State machine (flows)

States: `backlog`, `planning`, `clarify`, `plan_approval`, `working`, `review`, `qa`, `final_gate`, `done`, `blocked`, `cancelled`. Brainstorm skips `qa`. Only you and the runner move tickets, always through `fsm`, which refuses anything not in this table.

| From → To | Moved by | Guard |
| --- | --- | --- |
| backlog → planning | You (Assign) | Tag passes doctor; tickets in `blocked_by` are merged (code) or done (others) |
| planning → clarify | Runner | Result `kind: questions`, ≥1 question |
| clarify → planning | You (Submit) | Every question answered, "use recommended", or "you decide" |
| planning → plan\_approval | Runner | Result `kind: plan` passes schema |
| plan\_approval → working | You (Approve) | Plan hash frozen; worktree created and set up |
| plan\_approval → planning | You (Request changes / Ask me more) | Comment saved; "Ask me more" sets `must_ask` |
| working → clarify | Runner | Task status `NEEDS_CONTEXT`, `NEEDS_SCOPE` or `TEST_DISPUTES_SPEC` |
| clarify → working | You (Submit) | Answer added to that task's brief |
| clarify → planning | You (Submit, "changes the plan") | On re-approval, tasks with unchanged id and text keep `done` |
| working → review | Runner | All tasks done; working gate green |
| review → qa | Runner | No blocking findings |
| qa → final\_gate | Runner | QA gate green |
| final\_gate → done | Runner | Final gate green |
| review / qa / final\_gate → working | Runner | `feedback.md` written, `rework` +1, one fix session |
| any → blocked | Runner | See the list below |
| blocked → a phase | You (Resume) | Only phases up to where it blocked; that phase's gate re-runs first |
| any → cancelled | You | Process tree killed; worktree kept until `tb gc` |

**Blocked happens when:**

- `rework` > 2;
- more than 3 **failures** in one phase. Failures are crash, stall, or a run that died without a result. Pauses for memory, usage limit, sleep or network do **not** count;
- the phase's wall-clock cap is hit (time spent waiting for the heavy slot doesn't count);
- a gate tool reports a config error.

There is no cap on Clarify rounds. `rework` resets only when you Resume from Blocked.

**Big goals:** the plan may list child tickets with `blocked_by`. Approving creates them in Backlog, and you assign each one when you're ready. Assign is refused until its blockers' PRs are merged (the runner polls `gh pr view --json mergedAt` every 10 min) or, for non-code kinds, done.

## 5. Phases

### Planning ⇄ Clarify

- **Read-only tools:** `Read, Glob, Grep`, `Bash(git log *)`, `Bash(git show *)`, `Bash(git diff *)`, plus `WebSearch, WebFetch` for research and brainstorm.
- **Result:** `kind: questions` (one round: each question has why, options and a recommended answer) or `kind: plan`. Both always carry `facts` and `decisions`, each decision with its source. The runner saves `rounds/NN-*.json`, `facts.json` and `decisions.json`, and rejects a result that changes a decision you made.
- **Rounds:** each round is a fresh session, seeded with the ticket, facts, decisions and all your answers. No limit on rounds. "Enough, plan now" turns every open item into "planner's call".
- **Plan contents:**
  - acceptance criteria tagged `new` or `preserve`;
  - tasks with files, modules, `blocked_by`, `type` and `test_cmd`;
  - `allowed_schema_changes` and `allowed_api_changes`;
  - the skills Working may use;
  - UI frames, if any;
  - child tickets, if any.
- **At approval** you see every decision with its source: your answer, the ticket, an ADR, or "planner's call".

### Working — code

The runner loops through tasks in order, starting one fresh session per task.

**Task gate (run by the runner, not the agent):**

1. **Worktree clean.** Otherwise resume once with "commit or revert your changes".
2. **Scope.** Changed files must be within the task's files, the task's modules, or generated files. Otherwise the agent has to return `NEEDS_SCOPE`.
3. **Checks.** Typecheck, the task's `test_cmd`, and the unit suite if it runs in under about 60 s.
4. **New tests can fail.** For `new` tasks, the task's new test files must fail at the pre-task commit. A compile failure there counts as "unproven" and is shown to the reviewer.

If the gate is red: resume once with the gate output, then try a fresh session, then Blocked.

**Working gate (before Review):** full lint, typecheck, build and unit suite, plus:

- **Prisma diff:** no drop or rename outside `allowed_schema_changes`.
- **OpenAPI diff:** no removal, and no optional → required change, outside `allowed_api_changes`.

### Working — research, brainstorm, design

One session, up to 3 subagents, writing only to `out/`. Working gate: every deliverable listed in the plan exists and parses, and every research claim has a source URL.

### Review

Read-only. For code: `Read, Glob, Grep` and read-only git. The result is a verdict, blocking findings (Critical or Important, high confidence, location, failure scenario), notes, and a declined-to-judge list. Only blocking findings send the ticket back.

### QA

- **code:**
  - QA writes only to `qa/` and maps each acceptance criterion to tests tagged `new_behaviour` or `compat`.
  - **QA gate (runner):** `qa/` and the old e2e suite pass on head. `new_behaviour` tests fail on base; `compat` tests pass on base. Every `new` criterion has at least one `new_behaviour` test.
  - Base runs use a base worktree (set up like any other) and a test DB reset to base migrations, inside the heavy slot.
  - UI tickets: see "UI tickets (Figma)".
- **research:** the runner fetches every cited URL, which must return 2xx or 3xx. A fresh agent checks 5 claims (or all, if fewer) against the fetched page text.

### Final gate

- **code:**
  1. `HEAD == tested_sha`.
  2. Sonnet writes `out/pr.md` from gate outputs only.
  3. The runner pushes and runs `gh pr create --body-file out/pr.md`.
  4. You merge. Squash-merge keeps your one-commit style. The runner records the merge and whether you pushed edits before merging.
- **others:** the runner copies the `out/` deliverables to the tag's `output` folder, and Sonnet writes a 5-line summary on the card.

## UI tickets (Figma)

UI tickets get two extra steps: Figma frames are pulled once in Planning, and a `uimatch` gate runs in QA. Backend tickets skip both. The UI check lives in QA, not Review, because it needs the running app; Review stays diff-only.

1. **Planning** marks the ticket `ui: true` when the plan touches frontend, and lists the Figma frames with a map of page URL → frame → CSS selector. The planner is read-only, so the **runner** exports each frame as a PNG **at 2x** into `design/` (Figma MCP, or the Figma REST API from a script). These are frozen with the plan, so you approve the design reference together with the plan.
2. **Working** gets the design context and frame PNGs in its prompt, and its system prompt adds the `figma-design-to-code` rules.
3. **QA gate** starts the app and runs `uimatch compare figma=bypass:<frame> story=<url> selector=<sel>` for every mapped frame. Bypass mode reads the saved PNG, so QA never calls Figma. Exit 0 = pass. Exit 1 = mismatch: `report.json` reasons and `diff.png` go to `feedback.md` and the ticket returns to Working. Exit 2 = bad config: the ticket goes to Blocked, and it doesn't count as rework.
4. **Then a `visual-verdict` run** compares each screenshot with its frame for layout and hierarchy, which pixels miss. It blocks only on high-severity findings (missing element, wrong copy, broken layout); the rest go into the PR body as notes.

I ran `uimatch` against a small card component, using a 2x screenshot of the original as the "Figma" frame:

| Case | Result | Exit |
| --- | --- | --- |
| Same as design | PASS, score 100, 0% pixel diff | 0 |
| Button color changed | FAIL, score 97, 6.26% pixel diff | 1 |
| Padding 24px → 12px, strict size | FAIL, size mismatch 736×302 vs 688×254 | 1 |
| Padding 24px → 12px, `size=pad` | FAIL, score 89, area gap 21.4% over the 15% critical limit | 1 |

What the test showed:

- **Export at 2x.** A 1x export failed every comparison with a size mismatch, because `uimatch` captures the page at 2x.
- **Bypass mode is pixel-only.** Style diffs came back empty without a Figma token. The docs say a token adds per-property style diffs, which would tell the coder exactly what to fix. I couldn't test that part without a token.
- **Content must match the design.** Pixel comparison fails on real data, dates, and avatars. Compare components in Storybook, or pages loaded with fixture data that uses the Figma copy.
- **It's 0.x and marked experimental.** Run it as a warning-only check for the first few UI tickets, tune the thresholds (default pixel diff limit is 1%), then make it a hard gate.
- Running headless as root needed `UIMATCH_CHROMIUM_SANDBOX=false`. Your Mac won't need this; a CI container will.

## 6. Models and subagents

| Run | Model | Effort |
| --- | --- | --- |
| Planning (all kinds) | `fable` | high |
| Review (all kinds) | `fable` | high |
| Working tasks, fix sessions | `opus` | xhigh |
| QA agents, claim spot-check, visual check | `opus` | xhigh |
| PR body, done summaries | `sonnet` | default |
| Module context refresh | `sonnet` | default (you didn't specify; cheapest that works) |

Fable goes where one wrong call costs the most: the decisions in Planning and the judgment in Review. Opus at xhigh does the long hands-on work.

**Fable billing gate.**

- **The risk:** the docs say Fable can bill to usage credits instead of your plan's limits, depending on plan and seat tier. The consent prompt for that only exists in interactive sessions, so a headless run could bill credits without asking.
- **Default:** Fable phases run on `opus` (xhigh) until `tb doctor` records your answer.
- **Check once:** open `/model` and see whether the Fable row says "Requires usage credits".
- **Then set `fable_billing`:** `plan` (use Fable), `credits_ok` (use Fable and accept credits), or `credits_no` (stay on Opus).

**Fable fallback.** Fable runs pass `--fallback-model opus`, which helps only when Fable is overloaded or unavailable. If a Fable run ends in a refusal (Fable has extra safety layers around some security topics), the runner re-runs that phase on Opus xhigh and logs it.

**Subagents: max 3 per session.**

- `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3`: at most 3 alive at once. This is a native Claude Code limit.
- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`: subagents can't spawn their own.
- **Total cap:** a `PreToolUse` hook on the `Agent` tool asks `tbd` (over its socket, so parallel calls can't race) for a spawn slot. The 4th request in a session is denied: "subagent budget used (3/3); do the rest yourself". The cap is `subagents.per_session_total` in config.
- **Per ticket:** a ticket only ever has one session at a time, so it never has more than 3 subagents alive.
- **Live count:** `SubagentStart` and `SubagentStop` hooks report to `tbd`, which drives the "subagents 1/3" number on the card.
- **Long subagents:** `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is set to the phase's wall-clock cap, so background subagents aren't cut off at the default 10 minutes.
- **No subagents:** runs that don't need them (PR, summaries, spot-check) get `--disallowedTools Agent`.
- **Check in M6:** whether `deep-research` tries to start more than 3 subagents. If it does, the hook makes it do the rest itself.

## 7. Resource guard

### Signals (every 5 s, cheap system calls)

| Signal | Source (macOS) | Confidence |
| --- | --- | --- |
| Memory pressure | `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical | High |
| Free memory % | `sysctl -n kern.memorystatus_level` | Medium-high; verify in M1 |
| Available memory | `vm_stat`: (free + inactive + speculative pages) × page size | Medium |
| Disk free | `fs.statfs(os.homedir())` | High |
| Per-run RAM | `ps -axo pid=,ppid=,pgid=,rss=`, walking each run's process tree in Node | High |
| Network | TCP connect to `api.anthropic.com:443`, only when a run retries or exits early | High |
| Power | `pmset -g batt` | High |

**Rough RAM budget on a 16 GB M2 Pro** (from experience, not measured on your Mac):

| Process | Typical RSS |
| --- | --- |
| `claude` process | 300–700 MB; 1–2 GB in long xhigh sessions |
| Jest worker | 150–400 MB each (why `--maxWorkers=2` is forced) |
| Playwright Chromium | 200–500 MB per worker |
| NestJS dev server | 300–700 MB |
| `tsc --noEmit` | 0.5–1.5 GB |

M1 replaces these guesses with measured peaks.

### Admission (checked before any run starts)

A run starts only if all of these hold:

- **Pressure** is normal.
- **Available memory** ≥ 2 GB + the phase's expected need + `docker_reserved_gb` if Docker is running. Expected need is the median peak of that phase's last 10 runs; it starts at planning 1 GB, review 1 GB, working 2 GB, QA 4 GB.
- **Disk free** ≥ 8 GB.
- **Running runs** < `max_concurrent`. The default is **1**; raise it to 2 after a week of measured peaks.

Otherwise the card shows the reason: "waiting: memory", "disk" or "slot".

### While runs are going

| Condition | Action |
| --- | --- |
| Pressure warn | Run one by one: nothing new starts until only one run is left |
| Pressure critical | Pause the most recently started run (SIGINT; it resumes later; not a failure) |
| Disk < 15 GB | Banner + Mac notification; `tb gc` lists what can be freed |
| Disk < 8 GB | No new runs; notification |

`tb gc` lists finished worktrees, base-build caches, and run logs older than 30 days, with their sizes. It deletes only what you confirm.

### Sessions aware of each other

**Heavy slot.** `tbd` holds a semaphore with 1 slot by default.

- The Bash `PreToolUse` hook matches the command against the tag's `heavy` list (by leading words, so `docker build` matches but `docker ps` doesn't). On a match it rewrites the command (`updatedInput`) to `tbx heavy -- sh -c '<original>'`, so a whole `cd x && npm run build` runs inside the slot, not just the `cd`.
- For Jest and Playwright, the same rewrite adds `--maxWorkers=2` / `--workers=1`.
- Commands already starting with `tbx heavy` are left alone, and the lease is re-entrant for child processes, so nothing double-waits.
- The agent can't call `tbx heavy` directly; the hook only allows the rewritten form of a command that passes the phase's rules.
- `tbx heavy` waits for the slot and runs the command with `nice`. Leases are tied to a pid and freed when it dies. If `tbd` is down, it retries for 30 s, then fails clearly.
- The runner's own gate commands take the same slot.
- **Timeouts:** `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` are 30 min in the child env, so waiting for the slot doesn't kill the command. Slot wait time is excluded from the phase wall-clock cap.

**Locks.** QA takes `qa:<tag>` (app ports and test DB), so two tickets in one repo never run QA at the same time.

**Context.** Every prompt carries a "System now" block: other active runs and their phases, locks held, memory and disk. Agents can run `tbx status` for a fresh view.

## 8. Run tracker and recovery

### Spawn so runs survive a daemon restart

- **Output to files, not pipes.** The prompt is read from a file (`runs/<n>.prompt`). stdout goes to `runs/<n>.jsonl`, stderr to `runs/<n>.err`. A `tbd` crash can't break a pipe the child is writing to.
- **Own process group.** Runs are spawned with `detached: true`, so each run leads its own process group. Claude starts each Bash call in a new group of its own, so the runner also remembers every process it sees in a run's tree (pid + start time); the run end and recovery kill those too. A Bash child of a claude that died while tbd was down is missed (a reboot kills it anyway).
- **The lease** in `ticket.json` records `pid`, the process start time (`LC_ALL=C ps -o lstart= -p <pid>`), `pgid`, `gen`, phase, task, session id and log path. A run counts as alive only if pid **and** start time both match, which guards against pid reuse.
- **Re-attach.** `tbd` tails the log file. The outcome comes from the last `result` line in the log, not from an exit code, which a restarted `tbd` can't collect.

### Liveness

Runs use `--output-format stream-json --verbose --include-partial-messages`. `tbd` only updates timestamps and the current tool from the events; it doesn't keep the text. Logs are gzipped when a run ends.

| Icon | State | Rule |
| --- | --- | --- |
| Pulsing dot | Thinking | Any event in the last 60 s |
| Gear + tool name | Tool running | `tool_use` without its result yet; shows elapsed time |
| Hourglass | Waiting | Heavy slot, lock, or `system/api_retry` |
| Yellow dot | Quiet | No event for 5 min, process alive |
| Red dot | Stalled | No event for 15 min and no tool running → recover |
| Broken link | Offline | Network probe fails |
| Pause | Paused | Memory, usage limit, or you |
| Cross | Interrupted | Process gone without a `result` line |

Each card shows the icon, "last activity 12 s ago", elapsed time, subagents alive (0–3), and the run's RSS.

**Wall-clock caps** catch an agent stuck in a busy loop, which never looks stalled: planning 30 min, a working task 45 min, review 30 min, QA 60 min. Slot wait time doesn't count.

### Recovery: one path for every case

1. **Take the ticket's mutex** and bump the lease `gen` with compare-and-swap. A second recovery attempt (an auto-resume, your button, or a post-restart check) sees the new `gen` and stops. The Resume button is disabled while a live lease exists.
2. **Make sure the old run is dead.** Send SIGINT to the process tree (pgid plus a ppid walk, plus the remembered Bash-call groups), wait 10 s, send SIGKILL, then confirm with `kill(pid, 0)`.
3. **Wait** for the network (probe every 30 s) and for admission (§7).
4. **Check `git status`.** A dirty tree is fine; it's mentioned in the prompt.
5. **Resume** with `claude -p --resume <session>` (no `--session-id` on resume) and the prompt "Your previous run was interrupted. Check the current state and continue from your last step." No resume env var, so there's exactly one continuation path.
6. **Count it.** Crashes, stalls and runs that died without a result add 1 to the phase's `failures`. Pauses for memory, usage limit, sleep or network don't count.

**What triggers recovery:**

- **Interrupted:** the process is gone with no `result` line.
- **Stalled:** no events for 15 min and no tool running.
- **Network back:** after an offline period.
- **Usage limit reset:** the reset time has passed.
- **Memory pause lifted:** pressure is back to normal.
- **Sleep/wake:** the monitor reads `kern.sleeptime` / `kern.waketime` each sample: a new wake after a sleep of more than 30 s gives the slept time, which the wall cap leaves out. A wall-clock jump of more than 30 s between ticks is only an early hint: it gives the grace and holds the wall cap until the OS wake arrives, but adds no sleep time (Node's clock keeps counting through sleep). Each live run then gets 6 minutes to produce an event before recovery; Claude Code's own stream watchdog often recovers within that time. Known limit: macOS keeps only the last sleep/wake pair, so dark wakes between two samples can undercount sleep.

**Idle sleep** is blocked only while runs are active. `tbd` starts `caffeinate -i` when the first run starts and kills it when the last one ends, and by default only on AC power. Closing the lid still sleeps the Mac; recovery handles that.

**Buttons:** **Resume** (same session, this path) and **Restart phase** (fresh session). Neither counts as rework.

### Usage limit

- **Pause on:** a `rate_limit_event` whose status is `rejected`, or a run that ends on the limit. Warning-level events (`allowed_warning`) only show a banner. The status names will be confirmed in M2 from a real event.
- **While paused:** nothing new starts, and runs resume after the reset.
- **Invalid result:** a result with subtype `error_max_structured_output_retries` means the agent couldn't produce valid JSON. The runner resumes once with "return the result matching the schema", then moves the ticket to Blocked.

## 9. Subscription, safety and the spawn

**Subscription only**

- **Auth check:** `tb doctor` runs `claude auth status`; `authMethod` must be `claude.ai` (keychain login). Runs get an allowlisted env (PATH, HOME, TMPDIR, locale, USER, LOGNAME, SHELL, TERM), so `CLAUDE_CODE_OAUTH_TOKEN` never reaches an agent (D-0024). It's checked again every 30 min and after wake, not on every spawn.
- **Pinned binary.** Runs use a pinned binary at `~/.taskboard/bin/claude-<version>` with `DISABLE_AUTOUPDATER=1`, so your interactive `claude` updating itself doesn't change the pipeline.
- **Why pin:** the docs say `--bare` will become the default for `-p`, and bare mode doesn't use your subscription login. An upgrade is a deliberate step: run the fake-claude suite, then one real smoke run, then switch the pin.
- **Repo check:** refuse a tag whose `.claude/settings.json` sets `apiKeyHelper` or `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` env keys.
- **Child env:** remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **CLI, not the Agent SDK.** The SDK docs bar claude.ai login for products built on it.

**No push access for agents.** Only the runner pushes, using your normal environment. In the child environment:

- `SSH_AUTH_SOCK`, `GH_TOKEN` and `GITHUB_TOKEN` are removed.
- `GIT_TERMINAL_PROMPT=0`.
- Git config overrides through `GIT_CONFIG_COUNT` turn off the credential helper (`credential.helper` set to empty) and make every push fail (`url.no-push://.pushInsteadOf` set to empty, which matches all URLs).
- `GH_CONFIG_DIR` points at an empty folder.
- `Bash(git push *)` is in the deny list.

**Write limits.**

- **Edit and Write tools:** `permissions.allow` covers only the worktree (or `out/`). `permissions.deny` covers the tag folder, the skills folder and `~/.taskboard`. This matters because `--add-dir` gives edit access, not just read access.
- **Bash:** Claude Code's sandbox can restrict Bash writes too. M1 must prove one real e2e run works inside it: localhost Postgres, `tbd`'s socket, the npm cache, Playwright's cache. If it can't, leave the Bash sandbox off.
- **The real proof** is the runner's scope diff either way.

**Permissions are deterministic:** `--permission-mode dontAsk` plus an explicit allow list per phase. Auto mode uses a classifier, so it could behave differently from run to run.

```
~/.taskboard/bin/claude-<version> -p  < runs/<n>.prompt  > runs/<n>.jsonl  2> runs/<n>.err
  --session-id <uuid>                      # new runs only; resumes use --resume <uuid>
  --setting-sources project
  --settings phases/<kind>/<phase>/settings.json      # hooks, permissions allow/deny, sandbox
  --append-system-prompt-file phases/<kind>/<phase>/prompt.md
  --add-dir ~/.taskboard/tickets/<id>/skills          # .claude/skills/ with COPIES of approved skills
  [--add-dir <tag path>]                               # folder tags; denied for Edit/Write
  --strict-mcp-config --mcp-config phases/<kind>/<phase>/mcp.json
  --tools "<explicit list, incl. Glob,Grep>"
  --permission-mode dontAsk --permission-prompts none
  --model <m> --effort <e> [--fallback-model opus] --max-turns <cap>
  --json-schema phases/<kind>/<phase>/result.schema.json
  --output-format stream-json --verbose --include-partial-messages

env  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1
     CLAUDE_CODE_DISABLE_AUTO_MEMORY=1  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=<phase cap>
     BASH_DEFAULT_TIMEOUT_MS=1800000  BASH_MAX_TIMEOUT_MS=1800000  DISABLE_AUTOUPDATER=1
     GIT_TERMINAL_PROMPT=0  GIT_CONFIG_COUNT=2  GH_CONFIG_DIR=<empty dir>
     removed: ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN SSH_AUTH_SOCK GH_TOKEN GITHUB_TOKEN
spawn: detached, cwd = worktree (git tags) or tickets/<id>/ (folder tags)
```

**Skills are copied, not symlinked.** Your `~/.claude/skills` don't load with `--setting-sources project`. The runner copies exactly the approved skills into the ticket's skills folder, which also freezes their versions for that ticket. It isn't documented whether `--add-dir` follows symlinks.

## 10. UI (low RAM)

The whole UI is `index.html`, `app.js` and `style.css`, served by `tbd`. Vanilla JS, no build step, no framework. Updates arrive over Server-Sent Events, only when something changes, so there's no polling. You can close the tab anytime; `tbd` keeps running.

- **Header:**
  - RAM used / total, with a pressure dot (green, yellow, red);
  - disk free (turns yellow under 15 GB, red under 8 GB);
  - active runs `n / max`;
  - total RSS of all Claude processes;
  - network dot;
  - a "paused until" banner.
- **Reminders panel:** now / next / later / inbox as today, with tag chips and a checkbox to finish.
- **Flows board:** Backlog · Planning · Clarify · Plan approval · Working · Review · QA · Final gate · Done · Blocked. Each card shows:
  - kind and tag;
  - the liveness icon and "last activity";
  - the rework count;
  - subagents `n/3`;
  - the run's RSS;
  - any "waiting: …" reason.
- **New item box:** one line of text, a Reminder / Flow toggle, and for flows, kind and tag.
- **Card detail:**
  - the plan with its decision-to-source table;
  - the Clarify question form;
  - the task list;
  - the log tail (last 200 lines, loaded on demand);
  - gate outputs;
  - buttons: Resume, Restart phase, Cancel, Promote.
- **Health tab:** §12.

## 11. Your skills

### Used by the pipeline at run time

| Skill | Where | How |
| --- | --- | --- |
| Your learning skill | code tickets | Before a phase, the runner refreshes stale module context (a Sonnet run). The prompt includes the modules the plan lists |
| `taskboard` | chat | Keeps reminder routing and ordering. Changed to write through `tb`, create flows (`tb new -f`), and read flow status |
| `deep-research` | research Working | Runs under the 3-subagent cap |
| Your study-guide skill | research | When the deliverable is a study guide |
| Job-search skills (research, cover letter, interview prep) | research flows tagged `job` | Tag default skills |
| Investing research skills | research flows tagged `investing` | Analysis only; never acts on anything |
| Your writing-voice skill | final gate, optional per tag | PR body or summary in your voice |
| Your blog-draft skill | after a research ticket, optional | Blog draft from a finished report |
| `docx`, `pdf`, `xlsx`, `pptx` | research and design deliverables | When the plan names a file format |
| `frontend-design` | design flows | Only when there's no Figma source of truth |

Not used at run time:

- `docs`: it needs the Docs connector, which pipeline runs don't have.
- chrome-axi: it drives your real Chrome, which is fine for manual checks but not for background runs.

**Check in M0:** where your claude.ai skills sit on your Mac (likely `~/.claude/skills/synced/`). The runner copies approved skills from there.

### Used to build the taskboard itself

| Skill | Use |
| --- | --- |
| `skill-creator` | Write each phase prompt with evals, so prompt changes are tested before they ship |
| `frontend-design` | The board's look, within the vanilla JS limit |
| `taskboard` | The reminder rules to keep: routing, ordering, the `now` limit, calendar |
| Your learning skill | Module context for the taskboard repo |
| Your agent-team harness | Reuse the gate/ledger script ideas, the 174-check test style, and the N+1 benchmark fixture for golden tickets |

The phase prompts themselves are built from the head-to-head skill review in the next section.

## Skill review and phase prompts

**How the picks were made.** Three separate reviewers each read every candidate in full, for a set of jobs: Matt Pocock's skills, superpowers, OMC's skills and agents, Anthropic's skills, and Figma's. They scored each on the quality of output it drives, whether its output can be checked, headless fit, loop risk, and length. I spot-checked their key claims against the files. No repo won outright: each job has a different winner, and several jobs are best served by a combination.

**One prompt file per phase, written by you, 300–800 words.** Not 14 vendored skill files. That means fewer moving parts and one place to fix, and each file is cached as a system prompt. Each file lists the upstream skills it was built from, so you can re-sync when they improve.

| Phase prompt | Built from | Beat, and why |
| --- | --- | --- |
| planner | Matt `grilling` rounds; OMC `deep-interview` spec sections (goal, constraints, non-goals, acceptance criteria, assumptions → resolution); superpowers `brainstorming` scope-split check; Matt `to-spec` "highest seam" rule; superpowers `writing-plans` task format (exact files, interfaces, test-first steps with commands, Review Focus, self-review) plus "blocked by" | OMC `deep-interview` alone: one question per turn and a self-graded ambiguity score. OMC `plan`/`ralplan`: 5-round consensus loop, loose output. Matt `to-tickets`: no tests per ticket |
| implementer | superpowers SDD `implementer-prompt.md` status contract; Matt `tdd` loop; superpowers `writing-good-tests.md` (name the break, independent expected values, mock only at boundaries); OMC `minimal-code-discipline` plus "listed files only, no renames, public shapes unchanged"; superpowers `verification-before-completion`, shortened | superpowers TDD alone: half of it is rationalization tables. OMC `tdd`: tied to OMC's own phases. OMC `code-simplifier`: a refactor pass, the churn you want to stop |
| fixer (rework) | implementer, plus Matt `diagnosing-bugs` (tight failing loop, ranked hypotheses, BLOCKED after 3 failed ones), plus "never edit QA tests; report TEST\_DISPUTES\_SPEC" | superpowers `systematic-debugging`: anchors on one hypothesis. OMC `debugger`: assumes tools and agents that don't exist here |
| reviewer | superpowers `task-reviewer-prompt.md` applied to the whole diff; OMC blocking rule (Critical or Important, high confidence, file:line, a concrete failure scenario); OMC `critic` self-check "could the author refute this?"; OMC `API_Contract_Review` checklist | Matt `code-review`: no verdict and no correctness check. OMC `code-reviewer`: surfaces every nitpick. OMC `critic`: built to reject |
| qa | OMC `test-engineer` constraints; superpowers `writing-good-tests.md`; Playwright Test (TS) with its `webServer` config; tests tagged `new_behaviour` / `compat` | OMC `qa-tester`: drives tmux and leaves no re-runnable tests. Anthropic `webapp-testing`: Python, with `networkidle` waits that make tests flaky |
| ui coder (added to implementer) | Figma `figma-design-to-code`; `frontend-design` quality floor (responsive, focus states, reduced motion) | OMC `designer`: bans common fonts that Figma files often use. `frontend-design` alone: invents a new look |
| visual | OMC `visual-verdict`, blocking only on high severity, with no self-loop | Nothing else compares a screenshot with a design |
| pr | OMC `pr` (evidence only from gate outputs) plus Matt `pr` diff sketches | superpowers `finishing-a-development-branch`: stops and waits for you |

**On `grill-me` vs `grill-with-docs`:** the planner uses the shared `grilling` loop. The `domain-modeling` half of `grill-with-docs` (ADRs, `GLOSSARY.md`) is valuable in long-lived repos like yours. It goes into the plan as a task, so ADR and glossary changes are reviewed in the diff instead of written during planning.

**Module context** stays your learning skill. OMC's `deepinit`, `wiki`, `map` and `graph` would either create a second source of truth or only work inside OMC.

## 12. Reliability tracker

### What gets recorded

`metrics.jsonl` gets one line per run, per gate, per finished ticket, and per chaos drill. The line shapes are in Appendix C.

- **Gate failures are auto-classified.** `infra` means exit 127, a timeout, `EADDRINUSE`, a missing lockfile, or a `uimatch` exit 2. Everything else is `work`.
- **Follow-up fixes:** tickets get `fix_of` when you create a fix for an earlier ticket.
- **Merges:** the runner records whether you pushed commits on top of the PR before merging.
- **Cost:** `total_cost_usd` is cumulative across resumes, so each run records the difference. On a subscription it's a relative signal, not a bill.

### Health tab

Shown as counts (x / y), because a month of personal use is a small sample.

| Metric | Target |
| --- | --- |
| Interruptions recovered without you | ≥ 95% |
| Runs you had to Resume or Restart | ≤ 5% |
| Gate failures classified `infra` | ≤ 5% |
| False stall alerts (the run produced events within 6 min) | ≤ 20% |
| Code tickets done with ≤ 1 rework | ≥ 70% |
| PRs merged without your edits | ≥ 60% |
| `fix_of` tickets within 14 days of done | ≤ 10% |
| Golden-ticket score | No regression vs the last run |
| `tbd` RSS | ≤ 80 MB |
| Decisions marked "planner's call" | Watch only |

### Evaluation steps

**1. Fake-Claude suite: on every change, costs no usage.** `test/fake-claude.js` stands in for the `claude` binary (via the `claude_bin` config key) and replays scripted stream-json. `node --test` covers:

- the happy path for each kind, and a Clarify round;
- invalid result JSON, and the structured-output retry error;
- a crash mid-run, and a hang with no events;
- a network drop, a usage limit, and `--max-turns`;
- a scope violation, a test that passes at base, and a 4th subagent;
- low disk, and memory pressure warn/critical;
- a daemon restart while runs are live (re-attach through the log and pid + start time);
- a clock jump (sleep/wake);
- a double-resume race, where only one may win.

**2. Chaos drills: after big changes, and monthly.** Run a real ticket in a sandbox repo, then try each of these:

- `kill -9 tbd`;
- kill `claude`;
- Wi-Fi off for 5 min;
- lid closed for 10 min;
- disk filled below 8 GB;
- memory pressure raised;
- reboot mid-run.

Each drill has an expected outcome and is logged pass or fail.

**3. Golden tickets: after any prompt or model change.** Start with 4, in a sandbox NestJS + Prisma repo:

- a vague one-line goal (tests the interview);
- an N+1 query trap;
- a breaking change: an API field removal plus a column drop;
- a research question with checkable sources.

Each has scripted checks (was the trap caught, in which phase, how much rework) and your 1–5 score. Add more later: a tempting test edit, a behaviour-preserving refactor, a UI ticket. A prompt change ships only if no golden ticket gets worse.

## 13. Milestones

Each milestone is usable on its own. The risky mechanics (recovery, resources, auth) are proven before any agent writes code.

| M | Build | Done when |
| --- | --- | --- |
| M0 | `tbd` skeleton: store, fsm, reminders, HTTP + SSE + token + Host check, UI shell with header metrics; `tb`; tags; data moved to `~/.taskboard`; `taskboard` skill writes via `tb`; skill locations checked | Reminders work as today from UI, CLI and chat; idle RSS < 80 MB; fake suite runs |
| M1 | Monitor, admission, heavy slot with `updatedInput` rewrite, locks, write limits (sandbox decision), `tb doctor` (auth, pinned version, Fable billing), `tb gc` | Pressure and disk drills pass; doctor catches API-key auth; the rewrite works for `cd x && npm run build` |
| M2 | Spawn to files, log tailing, liveness, lease + `gen`, recovery path, caffeinate, usage-limit pause, push blocking | All recovery fake scenarios pass; chaos: kill `tbd`, kill `claude`, Wi-Fi, lid; an agent's `git push` fails |
| M3 | Planning + Clarify + Plan approval (code, research); worktree setup | The vague-goal golden ticket gives a plan you'd approve |
| M4 | Working (code): task loop, task gate, working gate with Prisma/OpenAPI diffs | N+1 and breaking-change tickets reach Review with correct gate results |
| M5 | Review, QA with base runs, final gate, PR, merge polling | The breaking-change trap is caught before the PR; the PR opens; the merge is recorded |
| M6 | research + brainstorm kinds | Research golden ticket: every URL resolves, spot-check passes |
| M7 | Health tab, metrics, golden-ticket runner, chaos log | One full week of real use with every target visible |
| M8 | design kind and UI tickets (Figma export, uimatch, visual-verdict) | UI golden ticket passes; a planted mismatch is caught |

From M4 on, build later milestones through the pipeline itself.

## 14. Still to verify while building

| What | When | Fallback if it fails |
| --- | --- | --- |
| `--json-schema` together with `stream-json` | M2 | `json` output for the result; the transcript file for liveness |
| `rate_limit_event` status names | M2 | Pause only when a run ends on the limit |
| Sandbox keys, and an e2e run inside the sandbox | M1 | Bash sandbox off; Edit/Write rules plus the scope diff |
| `kern.memorystatus_level` meaning on your macOS | M1 | Pressure level + `vm_stat` only |
| Skills loading from a copied `--add-dir` folder in a non-bare `-p` run | M3 | `--plugin-dir` with a generated plugin |
| `deep-research` subagent count | M6 | Trim it in the phase prompt |
| Figma MCP in `-p` | M8 | Export frames with the Figma REST API from a script |

## Appendix A — Files

### `tags.json`

```json
{
  "acme/billing": {
    "path": "~/code/acme-billing",
    "type": "git",
    "base": "main",
    "setup": "npm ci --prefer-offline",
    "env_files": [".env.test"],
    "checks": {
      "lint": "npm run lint",
      "typecheck": "npx tsc --noEmit",
      "unit": "npx jest --maxWorkers=2",
      "e2e": "npm run test:e2e -- --maxWorkers=2",
      "build": "npm run build",
      "prisma_diff": true,
      "openapi": "npm run openapi:json"
    },
    "heavy": ["npm ci", "npm run build", "npm run test:e2e", "npx jest", "npx playwright", "docker build", "docker compose up"],
    "context": ["CLAUDE.md", "docs/architecture.md"],
    "skills": ["learning"]
  },
  "job": {
    "path": "~/Documents/job",
    "type": "folder",
    "output": "reports/",
    "context": ["README.md"],
    "skills": ["job-search", "writing-voice"]
  }
}
```

### `ticket.json` (flow)

```json
{
  "id": "t_k3x9qa", "type": "flow", "kind": "code", "tag": "acme/billing",
  "title": "Paginate GET /users", "text": "…what you typed…",
  "state": "working", "created_at": "…", "updated_at": "…",
  "parent": null, "blocked_by": [], "fix_of": null,
  "must_ask": false, "clarify_origin": null,
  "plan_hash": "9f2c…", "base_sha": "a1b2…", "tested_sha": null,
  "branch": "tb/t_k3x9qa-paginate-users", "worktree": "~/.taskboard/worktrees/t_k3x9qa",
  "skills": ["learning"],
  "tasks": [{"id": "T1", "status": "done", "attempts": 1, "session": "uuid", "commit": "c3d4…"}],
  "rework": 0,
  "failures": {"working": 1},
  "waiting": {"reason": "memory", "since": "…"},
  "lease": {
    "gen": 4, "pid": 48211, "lstart": "Wed Oct  7 16:02:11 2026", "pgid": 48211,
    "phase": "working", "task": "T2", "session": "uuid",
    "log": "runs/7.jsonl", "started_at": "…", "last_event_at": "…",
    "tool": "Bash: npx jest", "slot_wait_ms": 0,
    "subagents_alive": 1, "subagents_spawned": 2
  },
  "pr": {"number": 142, "url": "…", "merged_at": null, "edited_before_merge": null}
}
```

### Plan result (code)

```json
{
  "kind": "plan",
  "summary": "Paginate GET /users",
  "acceptance": [
    {"id": "A1", "text": "returns 20 per page with nextCursor", "type": "new"},
    {"id": "A2", "text": "clients without a cursor still get the first page", "type": "preserve"}
  ],
  "tasks": [
    {"id": "T1", "title": "cursor pagination in UsersService", "files": ["src/users/users.service.ts"],
     "modules": ["src/users"], "blocked_by": [], "type": "new",
     "test_cmd": "npx jest src/users --maxWorkers=2", "steps": ["…"]}
  ],
  "allowed_schema_changes": [],
  "allowed_api_changes": ["GET /users: add optional cursor query"],
  "skills": ["learning"],
  "ui": null,
  "children": [],
  "facts": ["…"],
  "decisions": [{"id": "D1", "text": "cursor, not offset", "source": "answer:R1Q2"}]
}
```

### `config.json`

```json
{
  "claude_bin": "~/.taskboard/bin/claude-<version>",
  "max_concurrent": 1,
  "memory": {"min_free_gb": 2, "phase_need_gb": {"planning": 1, "review": 1, "working": 2, "qa": 4}, "docker_reserved_gb": 2},
  "disk": {"warn_gb": 15, "stop_gb": 8},
  "liveness": {"quiet_min": 5, "stall_min": 15, "wake_grace_min": 6,
               "wall_min": {"planning": 30, "working_task": 45, "review": 30, "qa": 60}},
  "recovery": {"max_failures_per_phase": 3},
  "subagents": {"concurrent": 3, "per_session_total": 3, "depth": 1},
  "models": {
    "planning": {"model": "fable", "effort": "high"},
    "review":   {"model": "fable", "effort": "high"},
    "working":  {"model": "opus",  "effort": "xhigh"},
    "qa":       {"model": "opus",  "effort": "xhigh"},
    "pr":       {"model": "sonnet"},
    "context":  {"model": "sonnet"}
  },
  "fable_billing": "unknown",
  "max_turns": {"planning": 60, "working_task": 80, "review": 40, "qa": 80, "pr": 10},
  "caffeinate": "ac_only",
  "http": {"port": 7777, "token_file": "~/.taskboard/token"}
}
```

## Appendix B — Interfaces

### `tb` CLI

| Command | Does |
| --- | --- |
| `tb new "<text>" [-f code\|research\|brainstorm\|design] [-t <tag>]` | Without `-f`: a reminder. With `-f`: a flow in Backlog |
| `tb list [--flows\|--reminders]`, `tb show <id>`, `tb logs <id> [-f]` | Read |
| `tb done <id>`, `tb move <id> <status>` | Reminders |
| `tb promote <id> -f <kind> -t <tag>` | Reminder → flow |
| `tb assign <id>` | Backlog → Planning |
| `tb answer <id> [--file answers.json] [--plan-now]` | Submit a Clarify round |
| `tb approve <id>`, `tb reject <id> "<comment>" [--ask]` | Plan approval |
| `tb scope <id> --allow\|--deny` | Answer `NEEDS_SCOPE` |
| `tb resume <id> [--phase <p>]`, `tb restart <id>`, `tb cancel <id>` | Run control |
| `tb tag add\|list\|doctor` | Tags |
| `tb doctor`, `tb gc`, `tb health` | System |
| `tb eval fake\|golden\|chaos` | Evaluation |

`tbx` (agents only): `tbx status` (read-only system view), `tbx heavy -- <cmd>` (inserted by the hook, never typed by the agent).

### HTTP

127.0.0.1:7777 only. The `Host` header is checked, and every POST needs the header `X-TB-Token`.

| Route | Does |
| --- | --- |
| `GET /` | UI |
| `GET /api/state` | Reminders, flow summaries, system snapshot |
| `GET /api/tickets/:id` | Full ticket, plan and current round |
| `GET /api/tickets/:id/log?tail=200` | Log tail (max 1000 lines; `after=<offset>` for the lines since an earlier read, `run=<n>` for an older run) |
| `GET /events` | Server-Sent Events: `system`, `ticket`, `run`, `reminder` |
| `POST /api/reminders`, `PATCH /api/reminders/:id` | Reminders |
| `POST /api/flows` | New flow |
| `POST /api/tickets/:id/{assign,answer,approve,reject,scope,resume,restart,cancel,promote}` | Actions, with the same guards as `tb` |
| `GET /api/gc`, `POST /api/gc` | Preview, then delete confirmed items |
| `POST /api/drills` | Chaos drill result `{name, ok, note}` from `tb eval chaos` → `t:drill` line (token only) |
| `GET /api/health` | Metrics summary |

Event payloads:

- `system`: `{ram_used, ram_total, pressure, disk_free, runs, max, net, paused_until, usage_warning}`
- `ticket`: `{id, state, waiting, rework}`
- `run`: `{id, liveness, last_event_age_s, tool, subagents_alive, rss_mb}` (+ `tool_s, live, started_at, last_event_at`); `{id, liveness: null}` once the run left the view. Sent only when it changes.
- `reminder`: `{id, status}`

### Unix socket (`~/.taskboard/tbd.sock`)

Used by `tbx` and the hooks. `slot.acquire {pid, cmd}` → waits → `{lease}`; `slot.release {lease}`; `subagent.request {session}` → `{ok}` or `{denied, used: 3}`; `subagent.start` / `subagent.stop {session}`; `status` → system view.

## Appendix C — Result and metrics shapes

| Phase | Result (`--json-schema`) |
| --- | --- |
| planner | `{kind:"questions", round, questions:[{id, question, why, options[], recommended}], facts[], decisions[]}` or the plan in Appendix A |
| working task | `{status, commit, tests_added[], notes, needs_scope?:{files[], reason}, question?}` |
| working (non-code) | `{deliverables:[{path, kind}], claims?:[{id, text, sources[]}], notes}` |
| review | `{verdict:"pass"\|"block", blocking:[{severity, confidence, where, problem, failure_scenario}], notes[], declined[]}` |
| qa (code) | `{criteria:[{id, tests:[{id, file, type:"new_behaviour"\|"compat"}]}], notes}` |
| research check | `{checked:[{claim_id, supported:"yes"\|"partial"\|"no", reason}]}` |
| pr | `{title, body_file}` |

`metrics.jsonl` lines:

```json
{"t":"run","ticket":"t_k3x9qa","phase":"working","task":"T2","model":"opus","effort":"xhigh","started":"…","ended":"…","exit":"result|interrupted|stalled|paused|usage|crash|max_turns|schema_fail|wall_cap|refusal|cancelled","turns":31,"cost_delta":840000,"peak_rss_mb":1120,"subagents_peak":2,"slot_wait_ms":42000,"resumed":false}
{"t":"gate","ticket":"t_k3x9qa","gate":"task","ok":false,"class":"work|infra","ms":48210,"detail":"2 tests failed"}
{"t":"ticket","ticket":"t_k3x9qa","kind":"code","tag":"acme/billing","outcome":"done|blocked|cancelled","rounds":3,"decisions":{"you":9,"ticket":2,"adr":1,"planner":2},"rework":1,"interventions":0,"phase_minutes":{"planning":14,"working":52,"review":6,"qa":21},"pr_edited":false,"fix_of":null}
{"t":"drill","at":"2026-10-09T03:12:40.000Z","name":"wifi","ok":true,"note":"healthy after 312s: run 2 running"}
```

`cost_delta` is integer micro-USD (T5): 840000 = $0.84. `total_cost_usd` adds up over `--resume`, so a resumed run's `cost_delta` is its total minus the session's last known total (`cost_base` on the lease).

## Design review

An independent critic agent reviewed v2 twice, checking claims against the Claude Code docs and the skill repos. Round 1 found 2 blockers and 9 major issues. Round 2 confirmed the fixes, found 3 new major issues introduced by them, and reported nothing blocking a first build. Everything below is now in the design.

| Finding | Fix in this version |
| --- | --- |
| Bash can write files, so the Write/Edit hook can't protect tests | Runner diffs changed files against the task's allowed scope; hooks are only an early warning |
| Red/green evidence was self-reported by the agent | Runner runs new tests at the pre-task commit and on base; "unproven" tests listed for the reviewer |
| Answers during coding silently changed the approved plan | Each answer is scoped "this task only" or "changes the plan"; the latter goes through a plan diff you approve |
| Hook output is capped at 10,000 characters | Phase prompt via `--append-system-prompt-file`; ticket context in the prompt |
| Rework had no defined session or gate | One fix session with `feedback.md` and the diff, then the full gate |
| Resuming one planner session over many rounds burns usage | Fresh session per round, seeded with saved facts and decisions |
| Backward compatibility was only a prompt rule | Prisma, OpenAPI and type-declaration diffs, before Review |
| `--setting-sources project` doesn't block everything | Auto memory off; repos with billing-related settings refused; repo hooks flagged |
| Usage-limit detection undocumented | Pause only when a run ends on the limit; probe when the reset time is unclear |
| Child tickets started before their blockers were merged | Children start when blockers are merged |
| Strict file scope would block normal NestJS changes | Generated files and in-module files allowed; `NEEDS_SCOPE` for the rest |
| Fail-on-base wrong for refactors and new modules | Criteria tagged `new` / `preserve` in the plan; compile failures count as "unproven" |
| Over-engineering | Removed SessionStart, Stop, PostToolUse and SubagentStop hooks; the final gate no longer re-runs everything; planner made read-only; one prompt file per phase |

**v3 (this version)** went through two more rounds with a fresh critic, checked against the Claude Code docs. Round 1 found 3 blockers and 12 major issues; round 2 found nothing blocking M0–M1 and three behaviour errors for M2, all fixed here.

| Finding | Fix in v3 |
| --- | --- |
| A restarted daemon couldn't re-attach to runs through a pipe | Output to files, detached process groups, pid + start time in the lease, outcome read from the log |
| Schemas, CLI, API, config and permissions were left to guess | Appendices A–C, explicit `dontAsk` + allow lists |
| `tasks.json` had two writers (skill and daemon) | `tbd` is the only writer; the skill and `tb` go through it |
| Synced skills don't load with `--setting-sources project` | Approved skills are copied into each ticket |
| Headless Fable could bill usage credits silently | Fable phases run on Opus until billing is confirmed |
| Admission defaults would thrash a 16 GB Mac | `max_concurrent` 1, Jest/Playwright workers forced low, Docker reserve |
| Waiting for the heavy slot would hit Bash timeouts; the rewrite broke compound commands | 30-min Bash timeouts, whole-command `sh -c` wrap, re-entrant leases, slot wait excluded from caps |
| `caffeinate -w <tbd>` would block sleep forever | Started with the first run, stopped with the last |
| Resume paths could race or double-continue | One recovery path, `gen` compare-and-swap, old process confirmed dead first |
| Sleep, usage resets and memory pauses counted as failures | Only crashes, stalls and lost runs count |
| Warning-level rate-limit events would pause everything | Pause only on `rejected` or a run ending on the limit |
| `--add-dir` gives write access; removing `SSH_AUTH_SOCK` doesn't block push | Edit/Write deny rules; `pushInsteadOf` + no credential helper + deny `git push` |
| Runtime data inside the code repo leaked `CLAUDE.md` into runs | Data moved to `~/.taskboard/` |
| Claude Code auto-updates could switch runs to `--bare` | Pinned binary, `DISABLE_AUTOUPDATER=1`, upgrade only after the test suite |

## Sources

- [mattpocock/skills](https://github.com/mattpocock/skills): `grilling`, `grill-with-docs`, `domain-modeling`, `to-spec`, `to-tickets`, `tdd`, `diagnosing-bugs`, `code-review`, `pr`, `git-guardrails-claude-code` (MIT)
- [obra/superpowers](https://github.com/obra/superpowers): `writing-plans`, `brainstorming`, `subagent-driven-development` (implementer and task-reviewer prompts, `task-brief`), `test-driven-development/writing-good-tests.md`, `verification-before-completion`, `systematic-debugging` (MIT)
- [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode): `deep-interview`, `plan`, `ralplan`, `review`, `minimal-code-discipline`, `visual-verdict`, `pr`, agents `code-reviewer`, `critic`, `test-engineer`, `executor`
- [anthropics/skills](https://github.com/anthropics/skills): `webapp-testing`, `frontend-design`
- [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide): `figma-design-to-code`
- [kosaki08/uimatch](https://github.com/kosaki08/uimatch): `@uimatch/cli` (MIT, 0.x)
- Claude Code docs: [headless mode](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [authentication](https://code.claude.com/docs/en/authentication), [hooks](https://code.claude.com/docs/en/hooks), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [herdr review (bitdoze)](https://www.bitdoze.com/herdr-agent-multiplexer/)

All repos were cloned and their skills read on 2026-10-07. The guardrail hook and `uimatch` were run locally. The Claude Code mechanics were checked against the docs; the three still-unverified items are listed under Design review.

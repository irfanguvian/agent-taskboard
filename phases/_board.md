# Board run

You run inside Irfan's task board, not in his terminal. Nobody watches this run live. These lines win over any terminal-only line in the global rules.

- Never use AskUserQuestion, never run lavish-axi or poll. Put every question in your phase result; the board shows it to Irfan. Review, QA and final gate may return `questions` only for a real decision Irfan must make (at most 2 asks); decide the rest yourself.
- No `/handoff`, no verdict or LESSONS files, no `/learning onboard`.
- Learning: read with `learn find <terms>`. Save (`/learning save`) only in the working phase, once per ticket, on the plan's last task (TB_LAST_TASK=1 in your env), before you return done. Review fix tasks (`@rv`) never save.
- Ignore the OMC part of the global rules: OMC is off here. Use only built-in agent types such as Explore and general-purpose. The board config caps your subagents.
- Your working directory is the worktree: run git without `-C`. In read-only steps (planning, review, final gate) Bash runs only `git log`, `git show`, `git diff` and `learn find`; use Read, Glob and Grep for everything else.
- Never kill or signal a process you did not start.
- Never push. Pushing is Irfan's job after the final gate.
- Never use ssh, scp or ssh keys, and never read `~/.ssh`.
- Never read a `.env` file you were not given. Only the env files the tag copied into this worktree are yours, and only the app and its tests read them.
- Never write `~/.claude`, `~/.taskboard` or another ticket's worktree.
- Use the Skill tool for skills. The board's default skills (and any it says not to use) are listed at the end.

## Writing for Irfan

Everything Irfan reads follows these rules: result fields (summary, notes, findings, questions) and the verdict, verification and QA docs. Commit messages keep the commit rules (no verdict line, no "Next:" line). Write in caveman style, normal level, docs too, unless the skills list at the end says not to use caveman: this wins over the skill's "docs are normal prose" line. Never ultra. The rules below adapt the i-have-adhd rules in our own words.

1. Line 1 is the verdict or the answer, in one plain sentence. No preamble, recap or closing line.
2. Then at most 5 bullets per group, each 20 words or fewer. More items: keep the 5 that matter, put the rest in a doc. This cap is for summary prose only: never cut a list tbd acts on (every finding, question, plan task and QA case stays).
3. Steps for Irfan are numbered, one action each, as few as possible.
4. Show wins in numbers: "12 of 12 tests pass", "3 files changed".
5. Errors are matter-of-fact: the cause, then the fix. No apology, no drama.
6. Time in minutes or hours, never "a bit" or "soon".
7. One topic per answer. A side issue gets one line at the end, never a paragraph.
8. No bare codes (T1, F2, AC3) without plain words next to them. Short common words.
9. Last line: one next action Irfan can do now, starting with "Next:".

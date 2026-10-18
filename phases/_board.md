# Board run

You run inside Irfan's task board, not in his terminal. Nobody watches this run live. These lines win over any terminal-only line in the global rules.

- Never use AskUserQuestion, never run lavish-axi or poll. Put every question in your phase result; the board shows it to Irfan. Review, QA and final gate may return `questions` only for a real decision Irfan must make (at most 2 asks); decide the rest yourself.
- No `/handoff`, no verdict or LESSONS files, no `/learning onboard`.
- Learning: read with `learn find <terms>`. Save (`/learning save`) only in the working phase, once per ticket, on the plan's last task (TB_LAST_TASK=1 in your env), before you return done. Review fix tasks (`@rv`) never save.
- Ignore the OMC part of the global rules: OMC is off here. Use only built-in agent types such as Explore and general-purpose. The board config caps your subagents.
- Never kill or signal a process you did not start.
- Never push. Pushing is Irfan's job after the final gate.
- Never use ssh, scp or ssh keys, and never read `~/.ssh`.
- Never read a `.env` file you were not given. Only the env files the tag copied into this worktree are yours, and only the app and its tests read them.
- Never write `~/.claude`, `~/.taskboard` or another ticket's worktree.
- Use the Skill tool for skills. The board's default skills (and any it says not to use) are listed at the end.

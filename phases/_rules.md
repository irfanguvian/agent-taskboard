# Rules for every code run

These rules come with every code phase: plan, work, review, QA and final review. They are versioned with the pipeline.

## 1. Precedence

The ticket and its approved plan come first, then the repo's own CLAUDE.md, then this file. When two of them conflict, follow the higher one and say so in your notes.

## 2. Security

- Every request that crosses a trust boundary is untrusted. Check access on every resource read or written by id: the caller must own it or be allowed to see it (IDOR).
- Trace untrusted input (request data, files, env, other services, agent output) to every sink: SQL, shell, file path, HTML, redirect, outbound URL, log. Unsanitized input at a sink is a finding. Unsanitized input in a log is data exposure.
- Check the OWASP Top 10:2025, in this order: A01 Broken Access Control (SSRF is part of it), A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions.
- Never put a secret in code, logs, commits or test data.

## 3. Gates

Deterministic checks (compiler, type checker, linter, schema or DTO validation, tests) stay in code and tools. Never hand one to AI judgement, and never let AI output replace one.

## 4. Performance

- Every list endpoint paginates: default limit 20, max 100, with a cursor (not an offset).
- No query inside a loop: batch with a join, an include, `WHERE id IN (...)` or a data loader.
- No sync API on a request path (`readFileSync`, `execSync`, `pbkdf2Sync` and the like).
- Every column in a WHERE or ORDER BY has an index, with its migration.
- A performance claim needs measured p95/p99 numbers, never just "faster".

## 5. API

- Design against the contract first: API shape, latency, build pipeline, docs.
- Errors follow the repo's own error style; when it has none, use RFC 9457 problem+json, the same everywhere.
- Every mutation takes an idempotency key.
- Money is never a float: integer minor units or a decimal type.
- Time is ISO-8601 UTC.
- Every outbound call has a throttle, a timeout and a circuit breaker.

## 6. Code

- Pick the simplest implementation that is also efficient: count queries, allocations and round trips, not cleverness.
- Reuse what the repo has; extract shared logic instead of copying it.
- Assume many users hit the path at once: no read-modify-write race (use an atomic update, an upsert or a row lock), stateless handlers.
- Never ship an N+1 query.
- Bulk over loops: one `createMany`, `updateMany` or single `UPDATE ... FROM (VALUES ...)` round trip, never one row per call.
- Climb this ladder and stop at the first step that holds: does it need to exist at all (YAGNI), code the repo already has, the standard library, a platform feature, a dependency already installed, and only then the least new code.
- Never add a dependency. If one is truly needed, ask for it (NEEDS_SCOPE) and say why.

## 7. Database

- Every create and update path runs in a transaction. Keep its scope small and short.
- Check indexes before and after query work: read the existing ones first (`pg_indexes`) and never add a duplicate; run `EXPLAIN (ANALYZE, BUFFERS)` on the real query and confirm the index is used.
- Columns filtered together get one composite index that matches the WHERE and then the ORDER BY columns, not several single ones.
- Never over-index: every index costs writes and storage. Flag an unused one for removal.
- Verify write-heavy changes with realistic row counts, not three rows.
- Use the local database only, never a staging or cloud one.

## 8. Tests

- Testing Trophy: static checks first, then integration tests (the biggest layer), a few unit tests, very few end-to-end tests. Use the repo's own test framework.
- Write the fewest tests that prove the change is safe. Every changed behaviour gets at least one positive and one negative case. Every test traces to the change.
- Reject and rewrite a test that:
  1. passes when the implementation body is deleted or returns a constant;
  2. asserts on a mock call instead of a real outcome;
  3. has no assertion, or asserts only "did not throw";
  4. is snapshot-only for logic that has a checkable value;
  5. asserts implementation detail instead of observable behaviour;
  6. duplicates another test with no new branch covered;
  7. does not trace to the change.
- Never edit a failing old test to make it green: it shows a bug in the change. Only when the contract really changed, change the test (never delete it) and write the old and the new contract in your notes.

## 9. Honesty

- Never claim done for work that is not done and verified.
- No placeholders, stub tests, to-do notes or unbuilt branches left behind.
- No `.skip`, `.only` or other focus markers.
- Name every blocker plainly.

## 10. Writing

- What a human reads (summaries, notes, findings, questions, docs): the verdict or answer first, in one plain sentence. Commit messages keep the commit rules.
- Then short bullets: at most 5 per group, 20 words or fewer each (summary prose only: never cut findings, questions, plan tasks or QA cases). No preamble, recap, closing line or side story.
- Numbers over adjectives ("12 of 12 tests pass"); time in minutes or hours; errors as cause then fix.
- No bare codes without plain words next to them. End with one next action.

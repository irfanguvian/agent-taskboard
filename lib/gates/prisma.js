'use strict';
// gates/prisma: the schema half of the working gate's policy check (contract K8+M8), pure; tbd never runs diff itself:
// the working gate runs this file as a capped child (CLI below, R.child). Input: every `*.prisma` file
// under tag prisma.schema (a file or a dir, Prisma 7 multi-file) and every file under prisma.migrations, at base and at
// HEAD, as {path: value} maps (the CLI reads the files git wrote, R.blobsTo): a schema file's text; an
// old migration file's blob sha (base, and HEAD where the path exists at base: compared, never read); a new migration
// file's text. ≤ 1 MB per side, else refused (old migrations cost 40 bytes each). Output: SchemaChange[] with K10 refs
// (`drop User.nickname`; allowed:false, plan-rules.markAllowed sets it) + `added` (fields new at HEAD, for
// `rename M.a M.b`) + `migration` (findings with no K10 form, never policy: the gate maps them to class work), or
// {ok:false, why} on input over the cap or a schema the tokenizer can't read (fail closed, never silently green).
// Identity is the DB name (`@map` / `@@map`, else the Prisma name), refs use the Prisma names at base. Changes:
//   - model gone → drop M; column gone → drop M.f; enum gone → drop E; enum value gone → drop E.V;
//   - type change (scalar or enum, list-ness, @db native type) → type M.f; optional → required → required M.f;
//   - relation fields (typed by a model) have no column: never compared;
//   - schema missing at HEAD: every model and enum dropped (falls out of the compare);
//   - a new migration (a new dir holding migration.sql), its SQL read twice (standard quotes, and `\` escapes as MySQL
//     and PG E'' read them; both reads must pass, the drops of both count). An ALLOWLIST (D-0066): every statement must
//     be one `prisma migrate` writes (sqlDrops lists them; prisma 7.10 output of pg / mysql / sqlite / sqlserver), else
//     "unparsed SQL" (work); a data statement (INSERT / UPDATE / DELETE / TRUNCATE / MERGE …) → red (D-0067) but
//     SQLite's exact RedefineTables copy. Drops: DROP TABLE → drop M (each of a list), ALTER TABLE .. DROP [COLUMN] c →
//     drop M.f (each of SQL Server's `DROP COLUMN a, b`), CHANGE / RENAME COLUMN a → drop M.a, RENAME TO → drop M,
//     DROP TYPE → drop E, DROP SCHEMA → every base model and enum; a RedefineTables (`CREATE TABLE "new_X"`) loses
//     X.f when new_X has no f or its copy leaves f out, and its `DROP TABLE "X"` is no drop only after that exact copy.
//     The lexer fails closed too: a dollar quote ($$, $tag$), a MySQL `#` comment, `--` not followed by a space or a
//     newline (MySQL reads `1--1` as code), a /* inside a block comment (PG nests them), ]] (PG's ARRAY[ARRAY[…]]); a
//     MySQL `/*! … */` body is read as code. SQL Server's EXEC forms (CreateSchema, RenameIndex, RedefineTables) are
//     dynamic SQL: red;
//   - migration[]: an existing migration edited or deleted, or a file added to an old migration dir → edited|deleted
//     <path>; the schema changed (models/enums, comments, order and `@map(name: "x")` ≡ `@map("x")` ignored) with no
//     new migration → drift <schema>.

const fs = require('node:fs');
const path = require('node:path');

const CAP = 1 << 20;
const WORD = /[A-Za-z0-9_]+/y;
const SPACE = /[^\S\n]+/y;

// One .prisma file → tokens {t: 'w'|'s'|'p'|'nl', v}; comments (//, ///, /* */) and spaces dropped, strings kept whole.
function tokens(src, file) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    SPACE.lastIndex = i;
    WORD.lastIndex = i;
    if (c === '\n') {
      out.push({ t: 'nl', v: '\n' });
      i++;
    } else if (SPACE.test(src)) i = SPACE.lastIndex;
    else if (src.startsWith('//', i)) {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
    } else if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error(`${file}: a /* comment never ends`);
      if (src.slice(i, e).includes('\n')) out.push({ t: 'nl', v: '\n' });
      i = e + 2;
    } else if (c === '"') {
      let v = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\n') break;
        if (src[j] === '\\') j++;
        v += src[j] ?? '';
      }
      if (src[j] !== '"') throw new Error(`${file}: a string never ends`);
      out.push({ t: 's', v });
      i = j + 1;
    } else if (WORD.test(src)) {
      out.push({ t: 'w', v: src.slice(i, WORD.lastIndex) });
      i = WORD.lastIndex;
    } else {
      const v = src.startsWith('@@', i) ? '@@' : c;
      out.push({ t: 'p', v });
      i += v.length;
    }
  }
  return out;
}

const isP = (tok, v) => tok?.t === 'p' && tok.v === v;
const text = (toks) => toks.map((k) => (k.t === 's' ? JSON.stringify(k.v) : k.v)).join(' ');
const MAP_TOKS = 3; // `name : "x"`: an @map's string comes within 3 tokens after its `(`
// the string argument of `@map("x")` / `@@map(name: "x")` starting at tokens[i] (the word map), or null (no @map,
// `@map()`). Index-based, ≤ MAP_TOKS tokens read (a 1 MB `@map(@map(…` line stays linear); no string or `)` there →
// throw (fail closed).
function mapArg(line, i, file) {
  if (line[i]?.v !== 'map' || !isP(line[i + 1], '(')) return null;
  for (let j = i + 2; j < Math.min(line.length, i + 2 + MAP_TOKS); j++) {
    if (line[j].t === 's') return line[j].v;
    if (isP(line[j], ')')) return null;
  }
  throw new Error(`${file}: an @map( with no string argument: @map(${text(line.slice(i + 2, i + 2 + MAP_TOKS))} …`);
}

// A block's body → lines (split at newlines outside () and []).
function lines(body) {
  const out = [[]];
  let depth = 0;
  for (const k of body) {
    if (k.t === 'p' && (k.v === '(' || k.v === '[')) depth++;
    if (k.t === 'p' && (k.v === ')' || k.v === ']')) depth--;
    if (k.t === 'nl' && depth <= 0) out.push([]);
    else if (k.t !== 'nl') out.at(-1).push(k);
  }
  return out.filter((l) => l.length);
}

// Every schema file of one side → {models, enums: Map<db name, ...>, blocks: Map<'kind name', canonical text>}.
function parse(files) {
  const raw = [];
  const enums = new Map();
  const blocks = new Map();
  for (const [file, src] of Object.entries(files)) {
    const toks = tokens(src, file);
    for (let i = 0; i < toks.length;) {
      if (toks[i].t === 'nl') {
        i++;
        continue;
      }
      const [kw, name, open] = toks.slice(i, i + 3);
      if (kw.t !== 'w' || name?.t !== 'w' || !isP(open, '{')) throw new Error(`${file}: expected "<keyword> <name> {", got ${JSON.stringify(text(toks.slice(i, i + 3)))}`);
      let j = i + 3;
      for (let depth = 1; depth > 0; j++) {
        if (j >= toks.length) throw new Error(`${file}: ${kw.v} ${name.v}: a { never closes`);
        if (isP(toks[j], '{')) depth++;
        if (isP(toks[j], '}')) depth--;
      }
      const body = lines(toks.slice(i + 3, j - 1));
      i = j;
      if (kw.v !== 'model' && kw.v !== 'enum') continue; // datasource, generator, view, type: no migration of their own
      if (blocks.has(`${kw.v} ${name.v}`)) throw new Error(`${file}: ${kw.v} ${name.v} is declared twice`);
      blocks.set(`${kw.v} ${name.v}`, body.map((l) => text(l).replace(/\bmap \( name : /g, 'map ( ')).sort().join('\n'));
      let db = name.v;
      const items = [];
      for (const l of body) {
        if (isP(l[0], '@@')) {
          db = mapArg(l, 1, file) ?? db;
          continue;
        }
        if (l[0].t !== 'w') throw new Error(`${file}: ${kw.v} ${name.v}: can't read line ${JSON.stringify(text(l))}`);
        const at = l.findIndex((k) => isP(k, '@'));
        const attrs = at < 0 ? [] : l.slice(at);
        const mapped = attrs.map((k, n) => (isP(k, '@') ? mapArg(attrs, n + 1, file) : null)).find((v) => v !== null);
        if (kw.v === 'enum') {
          items.push({ name: l[0].v, db: mapped ?? l[0].v });
          continue;
        }
        if (l[1]?.t !== 'w') throw new Error(`${file}: model ${name.v}: field ${l[0].v} has no type`);
        const type = text((at < 0 ? l : l.slice(0, at)).slice(1)).replace(/ \[ \]$| \?$/, '');
        const nat = attrs.findIndex((k, n) => isP(k, '@') && attrs[n + 1]?.v === 'db');
        const native = nat < 0 ? '' : text(attrs.slice(nat + 1, attrs.findIndex((k, n) => n > nat && isP(k, '@')) >>> 0));
        items.push({ name: l[0].v, db: mapped ?? l[0].v, type, list: isP(l.at(at < 0 ? -1 : at - 1), ']'), optional: isP(l.at(at < 0 ? -1 : at - 1), '?'), native });
      }
      if (kw.v === 'enum') enums.set(db, { name: name.v, values: new Map(items.map((v) => [v.db, v.name])) });
      else raw.push({ name: name.v, db, fields: items });
    }
  }
  const modelNames = new Set(raw.map((m) => m.name));
  const enumDb = new Map([...enums].map(([db, e]) => [e.name, db]));
  const models = new Map();
  for (const m of raw) {
    if (models.has(m.db)) throw new Error(`two models map to table ${m.db}`);
    // relation fields (typed by a model) are not columns; a type key compares enums by DB name
    const cols = m.fields.filter((f) => !modelNames.has(f.type))
      .map((f) => [f.db, { ...f, key: `${enumDb.has(f.type) ? `enum:${enumDb.get(f.type)}` : f.type}${f.list ? '[]' : ''} ${f.native}` }]);
    models.set(m.db, { name: m.name, cols: new Map(cols) });
  }
  return { models, enums, blocks };
}

const DOLLAR = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y; // a PG dollar quote opens: $$ or $tag$
const unparsed = (file, why) => new Error(`${file}: unparsed SQL: ${why}`);
// SQL → statements: comments dropped (a MySQL `/*! … */` body is code), '...' literals emptied (no DROP inside a default
// value counts), ; outside quotes. backslash: `\` escapes the next character inside quotes. Outside quotes a dollar
// quote, a `#` or a `--` with no space after it throws, so does a /* inside a block comment or ]] (see the header).
function statements(sql, backslash, file) {
  const out = [];
  let cur = '';
  let exec = 0; // open /*! … */ bodies
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '$') {
      DOLLAR.lastIndex = i;
      if (DOLLAR.test(sql)) throw unparsed(file, `a dollar quote ${JSON.stringify(sql.slice(i, DOLLAR.lastIndex).slice(0, 40))}`);
    }
    if (c === '#') throw unparsed(file, 'a # (a MySQL comment)');
    if (c === '-' && sql[i + 1] === '-') {
      if (i + 2 < sql.length && !' \t\r\n'.includes(sql[i + 2])) throw unparsed(file, `${JSON.stringify(sql.slice(i, i + 3))}: -- with no space after it (MySQL reads it as code)`);
      const e = sql.indexOf('\n', i);
      i = e < 0 ? sql.length : e - 1;
      cur += ' ';
    } else if (sql.startsWith('/*!', i)) { // MySQL runs the body (/*!50001 ... */: a version first)
      for (i += 2; /\d/.test(sql[i + 1] ?? '');) i++;
      exec++;
      cur += ' ';
    } else if (exec && sql.startsWith('*/', i)) {
      i++;
      exec--;
      cur += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (sql.slice(i + 2, e < 0 ? sql.length : e).includes('/*')) throw unparsed(file, 'a /* inside a block comment (PG nests them)');
      i = e < 0 ? sql.length : e + 1;
      cur += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (backslash && c !== '[' && sql[j] === '\\') j++;
        else if (c === '[' && sql[j] === ']' && sql[j + 1] === ']') throw unparsed(file, ']] (PG: nested ARRAY[…], not a [quoted] name)');
        else if (sql[j] === end && sql[j + 1] === end) j++; // doubled quote: one quote character
        else if (sql[j] === end) break;
      }
      cur += c === "'" ? "''" : sql.slice(i, j + 1);
      i = j;
    } else if (c === ';') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\`[^\`]+\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const unq = (s) => (/^["`[]/.test(s) ? s.slice(1, -1).replace(/""/g, '"') : s);
const NOT_DROPPED = new Set(['CONSTRAINT', 'INDEX', 'KEY', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'DEFAULT', 'NOT', 'IDENTITY', 'EXPRESSION',
  'PARTITION', 'TRIGGER', 'ROW', 'SYSTEM', 'PERIOD', 'COLUMN']);
const NOT_COL = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i;

// Column names of `CREATE TABLE x (...)`: top-level items of the outer parens, constraints skipped.
function columns(stmt, open) {
  const cols = new Set();
  let depth = 0;
  let item = '';
  for (let i = open; i < stmt.length; i++) {
    const c = stmt[i];
    if (c === '"' || c === '`' || c === '[' || c === "'") {
      const end = c === '[' ? ']' : c;
      const j = stmt.indexOf(end, i + 1);
      item += stmt.slice(i, j < 0 ? stmt.length : j + 1);
      i = j < 0 ? stmt.length : j;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if ((c === ',' && depth === 1) || depth === 0) {
      const m = new RegExp(`^(${IDENT})`).exec(item.trim());
      if (m && !NOT_COL.test(item.trim())) cols.add(unq(m[1]));
      item = '';
      if (depth === 0) break;
    } else if (depth >= 1 && !(c === '(' && depth === 1)) item += c;
  }
  return cols;
}

// ---- the allowlist (D-0066): a new migration holds only what `prisma migrate` writes ---------------------------------
// One statement (statements(): comments gone, every '…' literal written as '') → its depth-0 tokens: {t: 'w', v: UPPER,
// raw} a word, {t: 'i', v} a quoted name (unquoted), {t: 's'} a literal, {t: '()', v: the text inside} a paren group (one
// token), {t: 'p', v} punctuation (:: one). Linear.
const WORD_CH = /[A-Za-z0-9_$@]/;
function toks(s, file) {
  const out = [];
  const close = (i, open, shut) => { // the index of the quote / paren closing the one at i, quotes skipped inside parens
    for (let j = i + 1, depth = 1; j < s.length; j++) {
      const c = s[j];
      if (open === '(' && (c === '"' || c === '`' || c === '[' || c === "'")) j = close(j, c, c === '[' ? ']' : c);
      else if (c === shut && open !== '(' && open !== '[' && s[j + 1] === shut) j++; // a doubled quote
      else if (c === open && open === '(') depth++;
      else if (c === shut && --depth === 0) return j;
    }
    throw unparsed(file, `an unclosed ${open}`);
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (c === '"' || c === '`' || c === '[' || c === "'") {
      const j = close(i, c, c === '[' ? ']' : c);
      out.push(c === "'" ? { t: 's' } : { t: 'i', v: unq(s.slice(i, j + 1)) });
      i = j + 1;
    } else if (c === '(') {
      const j = close(i, '(', ')');
      out.push({ t: '()', v: s.slice(i + 1, j) });
      i = j + 1;
    } else if (WORD_CH.test(c)) {
      let j = i + 1;
      while (j < s.length && WORD_CH.test(s[j])) j++;
      out.push({ t: 'w', v: s.slice(i, j).toUpperCase(), raw: s.slice(i, j) });
      i = j;
    } else {
      const v = s.startsWith('::', i) ? '::' : c;
      out.push({ t: 'p', v });
      i += v.length;
    }
  }
  return out;
}
const W = (k, i) => (k[i]?.t === 'w' ? k[i].v : null);
const NAME = (k, i) => (k[i]?.t === 'i' ? k[i].v : k[i]?.t === 'w' ? k[i].raw : null);
const seq = (k, i, ...ws) => (ws.every((w, n) => W(k, i + n) === w) ? i + ws.length : -1); // after those words, or -1
const opt = (k, i, ...ws) => Math.max(i, seq(k, i, ...ws)); // after those words when there, else i
// a schema-qualified name at k[i] → {name: its last part, i: after it} | null
function qual(k, i) {
  let name = NAME(k, i);
  if (name === null) return null;
  for (i++; k[i]?.t === 'p' && k[i].v === '.' && NAME(k, i + 1) !== null; i += 2) name = NAME(k, i + 1);
  return { name, i };
}
// `q, q, …` from k[i] → {names, i: after} | null
function quals(k, i) {
  const names = [];
  for (let q = qual(k, i); q; q = k[q.i]?.v === ',' ? qual(k, q.i + 1) : null) {
    names.push(q.name);
    i = q.i;
  }
  return names.length ? { names, i } : null;
}
// k split at depth-0 commas, from i
function items(k, i) {
  const out = [[]];
  for (; i < k.length; i++) {
    if (k[i].t === 'p' && k[i].v === ',') out.push([]);
    else out.at(-1).push(k[i]);
  }
  return out;
}
// Words that start a statement. SQL Server needs no `;` between statements, so a column definition's free tail may hold
// none of them (but ON DELETE / ON UPDATE [SET …], CHARACTER SET)
const STMT = new Set(('ALTER BACKUP BEGIN BULK CALL CHECKPOINT CLOSE COMMIT CREATE DBCC DEALLOCATE DECLARE DELETE DENY DO DROP END EXEC EXECUTE ' +
  'FETCH GO GOTO GRANT IF INSERT KILL LOAD LOCK MERGE OPEN PRAGMA PREPARE PRINT RAISERROR RECONFIGURE RENAME REPLACE RESTORE RETURN ' +
  'REVOKE ROLLBACK SAVE SELECT SET SHUTDOWN THROW TRUNCATE UNLOCK UPDATE USE WAITFOR WHILE').split(' '));
function tailOk(k, i, end = k.length) {
  for (; i < end; i++) {
    const w = W(k, i);
    if (w === 'ON' && (W(k, i + 1) === 'DELETE' || W(k, i + 1) === 'UPDATE')) i += W(k, i + 2) === 'SET' ? 2 : 1;
    else if (w && STMT.has(w) && !(w === 'SET' && W(k, i - 1) === 'CHARACTER')) return false;
  }
  return true;
}
// whole statements, as tokens joined: transactions, SQLite's foreign-key pragmas, SQL Server's TRY/CATCH wrapper (as
// statements() splits it)
const FIXED = new Set(['BEGIN', 'COMMIT', 'BEGIN TRANSACTION', 'COMMIT TRANSACTION', 'PRAGMA FOREIGN_KEYS = ON', 'PRAGMA FOREIGN_KEYS = OFF',
  'PRAGMA DEFER_FOREIGN_KEYS = ON', 'PRAGMA DEFER_FOREIGN_KEYS = OFF', 'SET XACT_ABORT ON', 'SET XACT_ABORT OFF', 'BEGIN TRY BEGIN TRAN', 'COMMIT TRAN',
  'END TRY BEGIN CATCH IF @@TRANCOUNT > 0 BEGIN ROLLBACK TRAN', 'END', 'THROW END CATCH']);
const ISOLATION = /^SET TRANSACTION ISOLATION LEVEL (?:READ (?:UN)?COMMITTED|REPEATABLE READ|SNAPSHOT|SERIALIZABLE)$/;
const DATA = new Set(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MERGE', 'REPLACE', 'UPSERT', 'COPY', 'LOAD']);
const head = (s) => JSON.stringify(s.slice(0, 200).replace(/\s+/g, ' ').trim().slice(0, 80));

// A new migration's SQL → drop changes, named by the base schema where it knows the table; a statement of no known form
// → throw "unparsed SQL"; a data statement → throw (D-0067). Known forms (prisma 7.10 migrate diff output, pg / mysql /
// sqlite / sqlserver; + CREATE EXTENSION, COMMENT ON):
//   FIXED; CREATE SCHEMA [IF NOT EXISTS] s; CREATE EXTENSION [IF NOT EXISTS] e [WITH] [SCHEMA s] [VERSION v];
//   CREATE SEQUENCE [IF NOT EXISTS] q; ALTER SEQUENCE q OWNED BY q.c; COMMENT ON … IS '…'|NULL;
//   CREATE TYPE q AS ENUM (…); ALTER TYPE q ADD VALUE [IF NOT EXISTS] '…' [BEFORE|AFTER '…'] | RENAME TO n |
//   RENAME VALUE '…' TO '…'; DROP TYPE [IF EXISTS] q, … → drop E (a name an ALTER TYPE renamed to before: Prisma's enum
//   rewrite, no drop);
//   CREATE TABLE [IF NOT EXISTS] q (…) [DEFAULT CHARACTER SET c COLLATE c] (q = new_X: X's redefine, its columns kept);
//   CREATE [UNIQUE] [FULLTEXT|SPATIAL] [CLUSTERED|NONCLUSTERED] INDEX [CONCURRENTLY] [IF NOT EXISTS] i ON [ONLY] q
//   [USING m] (…); DROP INDEX [CONCURRENTLY] [IF EXISTS] q [ON q]; ALTER INDEX [IF EXISTS] q RENAME TO n;
//   DROP TABLE [IF EXISTS] q, … [CASCADE] → drop M (X of a redefine: no drop only after its exact copy); DROP SCHEMA … → every base
//   model and enum dropped (which lived there is unknown);
//   ALTER TABLE [IF EXISTS] [ONLY] q a, …: ADD … (a column / constraint / key: tailOk) and SQL Server's `, [c] …` after it;
//   DROP [COLUMN] [IF EXISTS] c → drop M.c (SQL Server's `, [c]` after it too); DROP CONSTRAINT|INDEX|KEY|CHECK
//   [IF EXISTS] n, DROP PRIMARY KEY, DROP FOREIGN KEY n; ALTER [COLUMN] c [SET|DROP] … (USING only as Prisma's
//   ("c"::text::"T")); MODIFY [COLUMN] c …; CHANGE [COLUMN] a b … → drop M.a; RENAME [COLUMN] a TO b → drop M.a;
//   RENAME TO|AS q → drop M (not new_X's); RENAME INDEX|KEY|CONSTRAINT a TO b;
//   INSERT: only the exact copy (copy()). Anything else, CASCADE included, → unparsed.
function sqlDrops(sql, base, add, backslash, file) {
  const model = (t) => base.models.get(t);
  const tbl = (t) => model(t)?.name ?? t;
  const col = (t, c) => `${tbl(t)}.${model(t)?.cols.get(c)?.name ?? c}`;
  const redefined = new Map(); // X → the columns of its `CREATE TABLE "new_X"`
  const copied = new Set(); // X of each exact copy read so far
  const renamed = new Set(); // ALTER TYPE … RENAME TO <these>
  // Prisma's RedefineTables copy, exactly: INSERT INTO "new_X" (cols) SELECT cols FROM "X" after its CREATE TABLE
  // "new_X", the same columns both times, nothing else (no WHERE / UNION / EXCEPT / JOIN / LIMIT / `(` after SELECT). A
  // base column of X that new_X has and the copy leaves out loses its data → drop X.c.
  const copy = (k) => {
    const to = qual(k, seq(k, 0, 'INSERT', 'INTO'));
    if (!to || k[to.i]?.t !== '()' || W(k, to.i + 1) !== 'SELECT') return false;
    const ins = items(toks(k[to.i].v, file), 0);
    let i = to.i + 2;
    const sel = [];
    for (; NAME(k, i) !== null && W(k, i) !== 'FROM'; i += 2) {
      sel.push(NAME(k, i));
      if (k[i + 1]?.v !== ',') break;
    }
    const from = W(k, i + 1) === 'FROM' ? qual(k, i + 2) : null;
    const x = from?.name;
    if (!from || from.i !== k.length || to.name !== `new_${x}` || !redefined.has(x)) return false;
    if (ins.length !== sel.length || ins.some((it, n) => it.length !== 1 || NAME(it, 0) !== sel[n])) return false;
    copied.add(x);
    for (const [c, f] of model(x)?.cols ?? []) if (redefined.get(x).has(c) && !sel.includes(c)) add('drop', `${model(x).name}.${f.name}`);
    return true;
  };
  // one ALTER TABLE item → its kind ('add' | 'drop' | 'x'): an item with no keyword continues the one before it
  // (SQL Server `ADD [a] …, [b] …`, `DROP COLUMN [a], [b]`)
  const action = (t, a, prev, need) => {
    const v = W(a, 0);
    if (v === 'ADD') {
      need(a.length > 1 && tailOk(a, opt(a, opt(a, 1, 'COLUMN'), 'IF', 'NOT', 'EXISTS')));
      return 'add';
    }
    if (v === 'DROP') {
      const kind = W(a, 1);
      if (kind === 'PRIMARY') need(seq(a, 1, 'PRIMARY', 'KEY') === a.length);
      else if (['CONSTRAINT', 'INDEX', 'KEY', 'CHECK', 'FOREIGN'].includes(kind)) {
        const j = opt(a, kind === 'FOREIGN' ? seq(a, 1, 'FOREIGN', 'KEY') : 2, 'IF', 'EXISTS');
        need(j > 0 && NAME(a, j) !== null && j + 1 === a.length);
      } else {
        const j = opt(a, opt(a, 1, 'COLUMN'), 'IF', 'EXISTS');
        need(NAME(a, j) !== null && j + 1 === a.length && (W(a, 1) === 'COLUMN' || a[j].t === 'i' || !NOT_DROPPED.has(a[j].v)));
        add('drop', col(t.name, NAME(a, j)));
        return 'drop';
      }
      return 'x';
    }
    if (v === 'ALTER') {
      const j = opt(a, 1, 'COLUMN');
      need(NAME(a, j) !== null);
      const r = W(a, j + 1) === 'SET' || W(a, j + 1) === 'DROP' ? j + 2 : j + 1;
      const u = a.findIndex((x, n) => n >= r && W(a, n) === 'USING');
      const using = (g) => { // Prisma's enum rewrite only: ("c"::text::"T")
        const m = g?.t === '()' ? toks(g.v, file) : [];
        return m.length === 5 && NAME(m, 0) === NAME(a, j) && m[1].v === '::' && W(m, 2) === 'TEXT' && m[3].v === '::' && NAME(m, 4) !== null;
      };
      need(tailOk(a, r, u < 0 ? a.length : u) && (u < 0 || (u + 2 === a.length && using(a[u + 1]))));
      return 'x';
    }
    if (v === 'MODIFY' || v === 'CHANGE') {
      const j = opt(a, 1, 'COLUMN');
      const n = v === 'CHANGE' ? j + 1 : j;
      need(NAME(a, j) !== null && NAME(a, n) !== null && tailOk(a, n + 1));
      if (NAME(a, j) !== NAME(a, n)) add('drop', col(t.name, NAME(a, j)));
      return 'add';
    }
    if (v === 'RENAME') {
      if (['INDEX', 'KEY', 'CONSTRAINT'].includes(W(a, 1))) need(NAME(a, 2) !== null && W(a, 3) === 'TO' && NAME(a, 4) !== null && a.length === 5);
      else if (W(a, 1) === 'TO' || W(a, 1) === 'AS') {
        need(qual(a, 2)?.i === a.length);
        if (!(t.name.startsWith('new_') && redefined.has(t.name.slice(4)))) add('drop', tbl(t.name));
      } else {
        const j = opt(a, 1, 'COLUMN');
        need(NAME(a, j) !== null && W(a, j + 1) === 'TO' && NAME(a, j + 2) !== null && a.length === j + 3);
        if (NAME(a, j) !== NAME(a, j + 2)) add('drop', col(t.name, NAME(a, j)));
      }
      return 'x';
    }
    if (prev === 'add') {
      need(NAME(a, 0) !== null && tailOk(a, 1));
      return 'add';
    }
    need(prev === 'drop' && NAME(a, 0) !== null && a.length === 1);
    add('drop', col(t.name, NAME(a, 0)));
    return 'drop';
  };
  for (const s of statements(sql, backslash, file)) {
    const k = toks(s, file);
    const red = () => unparsed(file, `${head(s)}: not a known migration statement`);
    const need = (ok) => { if (!ok) throw red(); };
    const end = (i) => i === k.length;
    if (k.length <= 16 && (FIXED.has(k.map((x) => x.v ?? x.t).join(' ')) || ISOLATION.test(k.map((x) => x.v ?? x.t).join(' ')))) continue;
    if (DATA.has(W(k, 0))) {
      if (W(k, 0) === 'INSERT' && copy(k)) continue;
      throw new Error(`${file}: data statement in a migration (D-0067): ${head(s)}`);
    }
    let i = seq(k, 0, 'CREATE', 'SCHEMA');
    if (i > 0) {
      need(end(opt(k, i, 'IF', 'NOT', 'EXISTS') + 1) && NAME(k, opt(k, i, 'IF', 'NOT', 'EXISTS')) !== null);
      continue;
    }
    if ((i = seq(k, 0, 'CREATE', 'EXTENSION')) > 0) {
      i = opt(k, i, 'IF', 'NOT', 'EXISTS');
      need(NAME(k, i) !== null);
      i = opt(k, i + 1, 'WITH');
      if (W(k, i) === 'SCHEMA') i = NAME(k, i + 1) !== null ? i + 2 : -1;
      if (W(k, i) === 'VERSION') i = k[i + 1] ? i + 2 : -1;
      need(end(i));
      continue;
    }
    if ((i = seq(k, 0, 'CREATE', 'SEQUENCE')) > 0) {
      need(qual(k, opt(k, i, 'IF', 'NOT', 'EXISTS'))?.i === k.length);
      continue;
    }
    if ((i = seq(k, 0, 'ALTER', 'SEQUENCE')) > 0) {
      const q = qual(k, i);
      need(q && seq(k, q.i, 'OWNED', 'BY') > 0 && qual(k, q.i + 2)?.i === k.length);
      continue;
    }
    if (seq(k, 0, 'COMMENT', 'ON') > 0) {
      need(W(k, k.length - 2) === 'IS' && (k.at(-1).t === 's' || W(k, k.length - 1) === 'NULL'));
      continue;
    }
    if ((i = seq(k, 0, 'CREATE', 'TYPE')) > 0) {
      const q = qual(k, i);
      need(q && seq(k, q.i, 'AS', 'ENUM') > 0 && k[q.i + 2]?.t === '()' && end(q.i + 3));
      continue;
    }
    if ((i = seq(k, 0, 'ALTER', 'TYPE')) > 0) {
      const q = qual(k, i);
      need(q);
      let j = seq(k, q.i, 'ADD', 'VALUE');
      if (j > 0) {
        j = opt(k, j, 'IF', 'NOT', 'EXISTS');
        need(k[j]?.t === 's' && (end(j + 1) || ((W(k, j + 1) === 'BEFORE' || W(k, j + 1) === 'AFTER') && k[j + 2]?.t === 's' && end(j + 3))));
      } else if ((j = seq(k, q.i, 'RENAME', 'TO')) > 0) {
        need(NAME(k, j) !== null && end(j + 1));
        renamed.add(NAME(k, j));
      } else need((j = seq(k, q.i, 'RENAME', 'VALUE')) > 0 && k[j]?.t === 's' && W(k, j + 1) === 'TO' && k[j + 2]?.t === 's' && end(j + 3));
      continue;
    }
    if ((i = seq(k, 0, 'DROP', 'TYPE')) > 0) {
      const l = quals(k, opt(k, i, 'IF', 'EXISTS'));
      need(l && end(l.i));
      for (const n of l.names) if (!renamed.has(n)) add('drop', base.enums.get(n)?.name ?? n);
      continue;
    }
    if ((i = seq(k, 0, 'CREATE', 'TABLE')) > 0) {
      const q = qual(k, opt(k, i, 'IF', 'NOT', 'EXISTS'));
      need(q && k[q.i]?.t === '()');
      const j = q.i + 1;
      need(end(j) || (seq(k, j, 'DEFAULT', 'CHARACTER', 'SET') > 0 && W(k, j + 4) === 'COLLATE' && NAME(k, j + 3) !== null && NAME(k, j + 5) !== null && end(j + 6)));
      if (q.name.startsWith('new_')) redefined.set(q.name.slice(4), columns(`(${k[q.i].v})`, 0));
      continue;
    }
    i = opt(k, opt(k, opt(k, opt(k, opt(k, seq(k, 0, 'CREATE'), 'UNIQUE'), 'FULLTEXT'), 'SPATIAL'), 'CLUSTERED'), 'NONCLUSTERED');
    if (i > 0 && W(k, i) === 'INDEX') {
      i = opt(k, opt(k, i + 1, 'CONCURRENTLY'), 'IF', 'NOT', 'EXISTS');
      const q = NAME(k, i) !== null && W(k, i + 1) === 'ON' ? qual(k, opt(k, i + 2, 'ONLY')) : null;
      need(q);
      const j = W(k, q.i) === 'USING' && NAME(k, q.i + 1) !== null ? q.i + 2 : q.i;
      need(k[j]?.t === '()' && end(j + 1));
      continue;
    }
    if ((i = seq(k, 0, 'DROP', 'INDEX')) > 0) {
      const q = qual(k, opt(k, opt(k, i, 'CONCURRENTLY'), 'IF', 'EXISTS'));
      need(q && (end(q.i) || (W(k, q.i) === 'ON' && qual(k, q.i + 1)?.i === k.length)));
      continue;
    }
    if ((i = seq(k, 0, 'ALTER', 'INDEX')) > 0) {
      const q = qual(k, opt(k, i, 'IF', 'EXISTS'));
      need(q && seq(k, q.i, 'RENAME', 'TO') > 0 && NAME(k, q.i + 2) !== null && end(q.i + 3));
      continue;
    }
    if ((i = seq(k, 0, 'DROP', 'TABLE')) > 0) {
      const l = quals(k, opt(k, i, 'IF', 'EXISTS'));
      need(l && (end(l.i) || ((W(k, l.i) === 'CASCADE' || W(k, l.i) === 'RESTRICT') && end(l.i + 1)))); // CASCADE: FKs / views only
      for (const x of l.names) if (!(redefined.has(x) && copied.has(x))) add('drop', tbl(x));
      continue;
    }
    if ((i = seq(k, 0, 'DROP', 'SCHEMA')) > 0) {
      const l = quals(k, opt(k, i, 'IF', 'EXISTS'));
      need(l && (end(l.i) || ((W(k, l.i) === 'CASCADE' || W(k, l.i) === 'RESTRICT') && end(l.i + 1))));
      for (const m of [...base.models.values(), ...base.enums.values()]) add('drop', m.name);
      continue;
    }
    if ((i = seq(k, 0, 'ALTER', 'TABLE')) > 0) {
      const t = qual(k, opt(k, opt(k, i, 'IF', 'EXISTS'), 'ONLY'));
      need(t && t.i < k.length);
      let prev = '';
      for (const a of items(k, t.i)) prev = action(t, a, prev, need);
      continue;
    }
    throw red();
  }
  for (const [t, cols] of redefined) {
    for (const [c, f] of model(t)?.cols ?? []) if (!cols.has(c)) add('drop', `${model(t).name}.${f.name}`);
  }
}

/**
 * @param {{base: Record<string, string>, head: Record<string, string>, schema?: string, migrations?: string}} o by path:
 *   schema text; migration blob sha (old) or text (new at HEAD) — see the header
 * @returns {{ok: true, changes: import('./types').SchemaChange[], added: string[], migration: string[]} | {ok: false, why: string}}
 *   migration: `edited <path>` | `deleted <path>` | `drift <schema>`
 */
function diff({ base, head, schema = 'prisma/', migrations = 'prisma/migrations' }) {
  for (const [side, files] of [['base', base], ['HEAD', head]]) {
    const bytes = Object.entries(files).reduce((n, [p, s]) => n + Buffer.byteLength(p) + Buffer.byteLength(s), 0);
    if (bytes > CAP) return { ok: false, why: `prisma: ${side} schema + migrations are ${bytes} bytes, at most ${CAP}` };
  }
  const mig = `${migrations.replace(/\/+$/, '')}/`;
  const dir = `${schema.replace(/\/+$/, '')}/`;
  const isSchema = (p) => (schema.endsWith('.prisma') ? p === schema : p.startsWith(dir) && p.endsWith('.prisma') && !p.startsWith(mig));
  const pick = (files) => Object.fromEntries(Object.entries(files).filter(([p]) => isSchema(p)));
  /** @type {Map<string, import('./types').SchemaChange>} */
  const changes = new Map();
  const add = (op, ref) => changes.set(`${op} ${ref}`, { op, ref, allowed: false });
  const added = [];
  const migration = [];
  try {
    const b = parse(pick(base));
    const h = parse(pick(head));
    for (const [db, bm] of b.models) {
      const hm = h.models.get(db);
      if (!hm) {
        add('drop', bm.name);
        continue;
      }
      for (const [c, bf] of bm.cols) {
        const hf = hm.cols.get(c);
        const ref = `${bm.name}.${bf.name}`;
        if (!hf) add('drop', ref);
        else {
          if (bf.key !== hf.key) add('type', ref);
          if (bf.optional && !hf.optional) add('required', ref);
        }
      }
      for (const [c, hf] of hm.cols) if (!bm.cols.has(c)) added.push(`${hm.name}.${hf.name}`);
    }
    for (const [db, be] of b.enums) {
      const he = h.enums.get(db);
      if (!he) add('drop', be.name);
      else for (const [v, name] of be.values) if (!he.values.has(v)) add('drop', `${be.name}.${name}`);
    }
    const under = (files) => Object.keys(files).filter((p) => p.startsWith(mig));
    const dirOf = (p) => (p.slice(mig.length).includes('/') ? p.slice(mig.length).split('/')[0] : null); // null: a top-level file
    const oldDirs = new Set(under(base).map(dirOf).filter(Boolean));
    for (const p of under(base)) {
      if (!Object.hasOwn(head, p)) migration.push(`deleted ${p}`);
      else if (head[p] !== base[p]) migration.push(`edited ${p}`); // blob shas (or texts) differ
    }
    const fresh = []; // migration.sql of each new migration dir (a dir without one is no migration)
    for (const p of under(head).filter((x) => !Object.hasOwn(base, x))) {
      if (oldDirs.has(dirOf(p))) migration.push(`edited ${p}`);
      else if (dirOf(p) && p === `${mig}${dirOf(p)}/migration.sql`) fresh.push(p);
    }
    for (const p of fresh) for (const backslash of [false, true]) sqlDrops(head[p], b, add, backslash, p); // union of both reads
    const same = b.blocks.size === h.blocks.size && [...b.blocks].every(([k, v]) => h.blocks.get(k) === v);
    if (!same && !fresh.length) migration.push(`drift ${schema}`);
  } catch (e) {
    return { ok: false, why: `prisma: ${e.message}` };
  }
  return { ok: true, changes: [...changes.values()], added, migration };
}

// ---- CLI (a child of tbd: own process, so sync fs is fine) ---------------------------------------------------------
// `node --max-old-space-size=64 lib/gates/prisma.js <dir>`: <dir>/manifest.json {base, head: {path: sha | {blob: sha}},
// schema, migrations}: a plain sha goes in as it is (an old migration: compared, never read), {blob} as the text of
// <dir>/<sha> → one JSON line, diff's result ({ok:false, why} included). Exit: 0 ok; 2 usage; 1 anything else.
if (require.main === module) {
  const [dir] = process.argv.slice(2);
  try {
    if (!dir) throw Object.assign(new Error('usage: prisma.js <dir>'), { exit: 2 });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const side = (o) => Object.fromEntries(Object.entries(o).map(([p, v]) => [p, typeof v === 'string' ? v : fs.readFileSync(path.join(dir, v.blob), 'utf8')]));
    process.stdout.write(`${JSON.stringify(diff({ base: side(m.base), head: side(m.head), schema: m.schema, migrations: m.migrations }))}\n`);
  } catch (e) {
    process.stderr.write(`${String(e.message).slice(0, 1000)}\n`);
    process.exitCode = e.exit ?? 1;
  }
}

module.exports = { diff };

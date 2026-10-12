'use strict';
// P5b K8+M8: lib/gates/prisma.js diff, pure (file maps in, K10 changes out). One row per contract rule, each with a
// positive (no change reported) and a negative (the exact change): comments/strings with braces, @map, @@map, enum
// drop, optional → required, list, multi-file, relation fields, edited/deleted migration, missing schema, drift,
// new-migration SQL (DROP TABLE, DROP [COLUMN], SQLite RedefineTables + its exact copy, /*! */, backslash quotes), rename
// via markAllowed, 1 MB cap, parse errors. Old migrations go in as blob shas (compared, never read); edited/deleted/drift
// land in `migration`, never in the policy `changes`. The SQL allowlist (D-0066, D-0067): one red table (no known form,
// data statements) + one positive table of real `prisma migrate diff` output (prisma 7.10, each dialect).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diff } = require('../lib/gates/prisma');
const { markAllowed, parseAllowed } = require('../lib/plan-rules');

const BASE = `// base schema
datasource db {
  provider = "sqlite"
}
generator client {
  provider = "prisma-client-js"
}

/// a user { this brace is a doc comment
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.VarChar(255)
  name      String   @default("{not a block}") // } in a comment
  nickname  String?
  bio       String?  @map("biography")
  tags      String[]
  role      Role     @default(USER)
  orders    Order[]
  /* a block comment } */
  @@map("users")
}

model Order {
  id         Int  @id
  userId     Int
  user       User @relation(fields: [userId], references: [id])
  totalMinor Int
}

enum Role {
  USER
  ADMIN @map("admin")
}
`;
const INIT = 'prisma/migrations/0001_init/migration.sql';
const LOCK = 'prisma/migrations/migration_lock.toml';
const MIG = { [INIT]: 'a'.repeat(40), [LOCK]: 'b'.repeat(40) }; // old migrations: blob shas
const NEW = 'prisma/migrations/0002_change/migration.sql';
const SCHEMA = 'prisma/schema.prisma';
const sub = (from, to, s = BASE) => {
  assert.ok(s.includes(from), `fixture has ${from}`);
  return s.replace(from, to);
};
// head = the schema text (null: no schema file) + extra files at HEAD (null: that file gone); → K10 strings +
// `migration: <finding>`, or the why
function run(head, extra = {}) {
  const files = { ...(head !== null && { [SCHEMA]: head }), ...MIG, ...extra };
  const r = diff({ base: { [SCHEMA]: BASE, ...MIG }, head: Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) });
  return r.ok === true ? [...r.changes.map((c) => `${c.op} ${c.ref}`), ...r.migration.map((m) => `migration: ${m}`)] : [`error: ${r.why}`];
}
const REDEFINE = `-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '{not a block}, x',
    "biography" TEXT,
    "tags" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    CONSTRAINT "users_role_check" CHECK ("role" IN ('USER', 'admin'))
);
INSERT INTO "new_users" ("biography", "email", "id", "name", "role", "tags") SELECT "biography", "email", "id", "name", "role", "tags" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
PRAGMA foreign_keys=ON;
`;

test('K8 M8 prisma diff: one row per rule, positive and negative', () => {
  /** @type {[string, string | null, Record<string, string | null>, string[]][]} */
  const rows = [
    ['same schema, no new migration', BASE, {}, []],
    ['tokenizer: comments and strings with braces edited → no change, no drift', sub('// } in a comment', '// another } comment'), {}, []],
    ['drop a column + its migration (SQLite RedefineTables): one change, the DROP TABLE of the redefine is no drop',
      sub('  nickname  String?\n', ''), { [NEW]: REDEFINE }, ['drop User.nickname']],
    ['@map: the Prisma name changes, the DB name stays → no change (migration present)', sub('bio       String?  @map("biography")', 'about     String?  @map("biography")'), { [NEW]: '-- noop\n' }, []],
    ['@map: the DB name changes, the Prisma name stays → the base column is dropped', sub('@map("biography")', '@map("bio_text")'), { [NEW]: '-- rename\n' }, ['drop User.bio']],
    ['@@map: model renamed in Prisma, same table → no change', sub('model User {', 'model Person {', sub('User @relation', 'Person @relation')), { [NEW]: '-- noop\n' }, []],
    ['@@map: the table name changes → drop the model', sub('@@map("users")', '@@map("people")'), { [NEW]: '-- rename\n' }, ['drop User']],
    ['enum value dropped', sub('  ADMIN @map("admin")\n', ''), { [NEW]: '-- enum\n' }, ['drop Role.ADMIN']],
    ['enum value renamed in Prisma, same @map → no change', sub('ADMIN @map("admin")', 'Admin @map("admin")'), { [NEW]: '-- noop\n' }, []],
    ['optional → required', sub('nickname  String?', 'nickname  String'), { [NEW]: '-- req\n' }, ['required User.nickname']],
    ['required → optional is no change', sub('email     String   @unique', 'email     String?  @unique'), { [NEW]: '-- opt\n' }, []],
    ['list → scalar is a type change', sub('tags      String[]', 'tags      String'), { [NEW]: '-- list\n' }, ['type User.tags']],
    ['scalar type change', sub('totalMinor Int', 'totalMinor Float'), { [NEW]: '-- float\n' }, ['type Order.totalMinor']],
    ['a relation field has no column: removing it is no change', sub('  orders    Order[]\n', ''), { [NEW]: '-- noop\n' }, []],
    ['existing migration edited (another blob sha)', BASE, { [INIT]: 'c'.repeat(40) }, [`migration: edited ${INIT}`]],
    ['existing migration deleted', BASE, { [INIT]: null }, [`migration: deleted ${INIT}`]],
    ['a file added to an old migration dir', BASE, { 'prisma/migrations/0001_init/extra.sql': 'DROP TABLE "users";' }, ['migration: edited prisma/migrations/0001_init/extra.sql']],
    ['schema missing at HEAD → every model and enum dropped', null, {}, ['drop User', 'drop Order', 'drop Role', 'migration: drift prisma/']],
    ['drift: schema changed, no new migration dir', sub('  bio ', '  age       Int?\n  bio '), {}, ['migration: drift prisma/']],
    ['a new dir without migration.sql is no migration → drift', sub('  bio ', '  age       Int?\n  bio '), { 'prisma/migrations/0002_change/.keep': '' }, ['migration: drift prisma/']],
    ['@@map(name: "users") ≡ @@map("users"): no drift', sub('@@map("users")', '@@map(name: "users")'), {}, []],
    ['the same change with its migration → no drift', sub('  bio ', '  age       Int?\n  bio '), { [NEW]: 'ALTER TABLE "users" ADD COLUMN "age" INTEGER;' }, []],
    ['new migration SQL, schema unchanged: DROP COLUMN and DROP TABLE named by the base schema', BASE,
      { [NEW]: 'ALTER TABLE "users" DROP COLUMN "biography";\nDROP TABLE IF EXISTS "Order";\n' }, ['drop User.bio', 'drop Order']],
    ['schema unchanged, a RedefineTables loses a column → drop', BASE, { [NEW]: REDEFINE }, ['drop User.nickname']],
    ['ALTER TABLE .. DROP "c" without COLUMN drops c', BASE, { [NEW]: 'ALTER TABLE "users" DROP "biography";\n' }, ['drop User.bio']],
    ['DROP CONSTRAINT / INDEX / DEFAULT / NOT NULL drop no column', BASE,
      { [NEW]: 'ALTER TABLE "users" DROP CONSTRAINT "users_pkey";\nALTER TABLE "users" ALTER COLUMN "email" DROP DEFAULT, ALTER COLUMN "email" DROP NOT NULL;\nALTER TABLE "users" DROP INDEX "users_email_key";\n' }, []],
    ['a MySQL /*! */ body is code', BASE, { [NEW]: '/*!40000 DROP TABLE `users` */;\n' }, ['drop User']],
    ["a backslash-escaped quote can't hide a DROP (both reads count)", BASE,
      { [NEW]: String.raw`ALTER TABLE "users" ADD COLUMN "a" TEXT DEFAULT E'\'';` + '\nDROP TABLE "users";\nALTER TABLE "users" ADD COLUMN "b" TEXT DEFAULT \'x\';\n' }, ['drop User']],
    ['a backslash read hides a DROP the standard read sees (both reads count)', BASE,
      { [NEW]: String.raw`ALTER TABLE "users" ADD COLUMN "a" TEXT DEFAULT 'C:\';` + '\nDROP TABLE "users";\nALTER TABLE "users" ADD COLUMN "b" TEXT DEFAULT \'x\';\n' }, ['drop User']],
    ['DROP COLUMN <keyword name>: an explicit COLUMN makes `key` a column', BASE, { [NEW]: 'ALTER TABLE users DROP COLUMN key;\nALTER TABLE users DROP COLUMN index;\n' }, ['drop User.key', 'drop User.index']],
    ['RENAME COLUMN a TO b drops the old DB name; RENAME TO drops the table', BASE, { [NEW]: 'ALTER TABLE "users" RENAME COLUMN "biography" TO "bio";\nALTER TABLE "Order" RENAME TO "orders";\n' }, ['drop User.bio', 'drop Order']],
    ['@db native type change → type', sub('@db.VarChar(255)', '@db.VarChar(100)'), { [NEW]: '-- x\n' }, ['type User.email']],
    ["Prisma's implicit m2m table _UserToTag", BASE, { [NEW]: 'DROP TABLE "_UserToTag";\n' }, ['drop _UserToTag']],
    ['new migration SQL: DROP inside a string or a comment is not a drop', BASE,
      { [NEW]: `-- DROP TABLE "users";\n/* DROP TABLE "Order"; */\nALTER TABLE "users" ADD COLUMN "note" TEXT DEFAULT 'DROP COLUMN "email"; DROP TABLE "users"';\n` }, []],
    ['a SQLite rebuild without the INSERT … SELECT copy drops the table', BASE, { [NEW]: REDEFINE.replace(/^INSERT INTO .*\n/m, '') }, ['drop User', 'drop User.nickname']],
    ['the copy after the DROP TABLE is too late: drop', BASE, { [NEW]: REDEFINE.replace(/^(INSERT INTO .*\n)(DROP TABLE .*\n)/m, '$2$1') }, ['drop User', 'drop User.nickname']],
    ['DROP TABLE a, b: each table of the list', BASE, { [NEW]: 'DROP TABLE IF EXISTS "Order", "users" CASCADE;\n' }, ['drop Order', 'drop User']],
    ['a copy that leaves out columns new_X keeps: their data is lost → drop each', BASE,
      { [NEW]: REDEFINE.replace(/^INSERT INTO .*$/m, 'INSERT INTO "new_users" ("id", "email") SELECT "id", "email" FROM "users";') }, ['drop User.name', 'drop User.bio', 'drop User.tags', 'drop User.role', 'drop User.nickname']],
    ['DROP SCHEMA: every base model and enum (which lived there is unknown)', BASE, { [NEW]: 'DROP SCHEMA "public" CASCADE;\nCREATE SCHEMA "public";\n' }, ['drop User', 'drop Order', 'drop Role']],
    ['DROP TYPE drops the enum', BASE, { [NEW]: 'DROP TYPE "Role";\n' }, ['drop Role']],
    ['SQL Server DROP COLUMN [a], [b]: both', BASE, { [NEW]: 'ALTER TABLE [dbo].[users] DROP COLUMN [role], [nickname];\n' }, ['drop User.role', 'drop User.nickname']],
    ['MySQL CHANGE a b renames: the old name is dropped', BASE, { [NEW]: 'ALTER TABLE `users` CHANGE `nickname` `nick` VARCHAR(191) NULL;\n' }, ['drop User.nickname']],
    ['ALTER TABLE IF EXISTS reads the table name', BASE, { [NEW]: 'ALTER TABLE IF EXISTS "users" DROP COLUMN "nickname";\n' }, ['drop User.nickname']],
  ];
  for (const [name, head, extra, want] of rows) assert.deepEqual(run(head, extra), want, name);
});

test('K8 multi-file schema (Prisma 7 dir): a model moved between files is no change; a file gone drops its models', () => {
  const [from, to] = [BASE.indexOf('model Order'), BASE.indexOf('enum Role')];
  const [main, order] = [BASE.slice(0, from) + BASE.slice(to), BASE.slice(from, to)];
  const base = { 'prisma/schema.prisma': main, 'prisma/models/order.prisma': order, ...MIG };
  const moved = diff({ base, head: { 'prisma/schema.prisma': main + order, ...MIG } });
  assert.deepEqual(moved, { ok: true, changes: [], added: [], migration: [] });
  const gone = diff({ base, head: { 'prisma/schema.prisma': main, ...MIG } });
  assert.deepEqual(gone.ok === true && [gone.changes.map((c) => `${c.op} ${c.ref}`), gone.migration], [['drop Order'], ['drift prisma/']]);
  const one = diff({ base, head: { 'prisma/schema.prisma': main, ...MIG }, schema: 'prisma/schema.prisma' }); // a file tag: only that file
  assert.deepEqual(one, { ok: true, changes: [], added: [], migration: [] });
});

test('K10 rename M.a M.b: allows drop M.a only when the diff saw M.b added (markAllowed over the diff)', () => {
  const head = sub('nickname  String?', 'handle    String?');
  const r = diff({ base: { [SCHEMA]: BASE, ...MIG }, head: { [SCHEMA]: head, ...MIG, [NEW]: '-- rename\n' } });
  assert.ok(r.ok);
  assert.deepEqual(r.added, ['User.handle']);
  const { entries } = parseAllowed(['rename User.nickname User.handle'], 'schema');
  assert.deepEqual(markAllowed(r.changes, entries, r.added), { changes: [{ op: 'drop', ref: 'User.nickname', allowed: true }], unused: [] });
  assert.deepEqual(markAllowed(r.changes, parseAllowed(['rename User.nickname User.alias'], 'schema').entries, r.added),
    { changes: [{ op: 'drop', ref: 'User.nickname', allowed: false }], unused: ['rename User.nickname User.alias'] }, 'M.b not added → not allowed, entry unused');
});

test('K8 fail closed: input over 1 MB per side, an unterminated string or block → {ok:false, why}', () => {
  const big = diff({ base: { [SCHEMA]: BASE, ...MIG }, head: { [SCHEMA]: BASE, [NEW]: 'x'.repeat(1 << 20) } });
  assert.equal(big.ok, false);
  assert.match(!big.ok ? big.why : '', /HEAD schema \+ migrations are \d+ bytes, at most 1048576/);
  assert.equal(diff({ base: { [SCHEMA]: BASE }, head: { [SCHEMA]: BASE } }).ok, true, 'under the cap: read');
  for (const [name, head] of [['string', sub('"{not a block}"', '"{not a block}')], ['block', `${BASE}\nmodel Broken {\n  id Int\n`], ['junk', 'model { }']]) {
    const r = diff({ base: { [SCHEMA]: BASE }, head: { [SCHEMA]: head } });
    assert.equal(r.ok, false, name);
  }
  assert.match(run(sub('@map("biography")', `${'@map('.repeat(20_000)}"x")`))[0], /^error: prisma: prisma\/schema\.prisma: an @map\( with no string argument/, '@map(@map(… (O(n²) before)');
});

test('K8 D-0066 D-0067 SQL allowlist: a statement of no known form → "unparsed SQL"; a data statement → red; never silently no drop', () => {
  const copy = (cols, tail = '') => REDEFINE.replace(/^INSERT INTO .*$/m, `INSERT INTO "new_users" (${cols}) SELECT ${cols} FROM "users"${tail};`);
  const COLS = '"biography", "email", "id", "name", "role", "tags"';
  /** @type {[string, string, 'unparsed' | 'data'][]} */
  const rows = [
    ['a dollar quote $$', 'SELECT $$ DROP TABLE "users"; $$;\n', 'unparsed'],
    ['a tagged dollar quote $tag$', 'CREATE FUNCTION f() RETURNS void AS $body$ DROP TABLE "users"; $body$ LANGUAGE sql;\n', 'unparsed'],
    ['a MySQL # comment', "# '\nDROP TABLE `users`;\n-- '\n", 'unparsed'],
    ['-- with no space (MySQL: 1--1 is code)', 'SELECT 1--1; DROP TABLE "users";\n', 'unparsed'],
    ['a /* inside a block comment (PG nests them)', `/* /* */ ' */ ALTER TABLE "users" DROP COLUMN "biography"; -- '`, 'unparsed'],
    [']] (PG ARRAY[ARRAY[1]], read as a [name] it would hide the DROP)', 'SELECT ARRAY[ARRAY[1]]; ALTER TABLE "users" DROP COLUMN "biography"; SELECT ARRAY[1];', 'unparsed'],
    ['SELECT', 'SELECT 1;\n', 'unparsed'],
    ['DO', "DO 'BEGIN DROP TABLE users; END';\n", 'unparsed'],
    ['PREPARE', "PREPARE s FROM 'DROP TABLE users';\n", 'unparsed'],
    ['EXECUTE', 'EXECUTE s;\n', 'unparsed'],
    ['CALL', 'CALL p();\n', 'unparsed'],
    ['SQL Server EXEC( inside an IF', "IF 1 = 1 EXEC('DROP TABLE users');\n", 'unparsed'],
    ['SQL Server sp_executesql (no EXEC: first in its batch)', "sp_executesql N'DROP TABLE users';\n", 'unparsed'],
    ["real prisma SQL Server RenameIndex (EXEC SP_RENAME: its target can't be read)", "EXEC SP_RENAME N'dbo.Post.Post_authorId_idx', N'post_author_idx', N'INDEX';\n", 'unparsed'],
    ['real prisma SQL Server RedefineTables (dynamic SQL)', "DECLARE @SQL NVARCHAR(MAX) = N''\nSELECT @SQL += N'ALTER TABLE ' + ' DROP CONSTRAINT '\nEXEC sp_executesql @SQL\n;\n", 'unparsed'],
    ['SQL Server: a statement hidden in a column definition (T-SQL needs no ;)', 'ALTER TABLE [dbo].[users] ADD [x] INT DROP TABLE [dbo].[users];\n', 'unparsed'],
    ['a procedure body: SQL Server CREATE OR ALTER PROC', 'CREATE TABLE "a" ("id" INT);\nGO\nCREATE OR ALTER PROC dbo.p AS DROP TABLE users;\n', 'unparsed'],
    ['a function body: PG CREATE OR REPLACE FUNCTION', "CREATE OR REPLACE FUNCTION f() RETURNS void AS 'DROP TABLE users' LANGUAGE sql;\nSELECT f();\n", 'unparsed'],
    ['a trigger body: SQLite CREATE TEMP TRIGGER IF NOT EXISTS', 'CREATE TEMP TRIGGER IF NOT EXISTS t AFTER INSERT ON "users" BEGIN DELETE FROM "users"; END;\n', 'unparsed'],
    ['a MySQL event body: CREATE EVENT … DO', 'CREATE EVENT e ON SCHEDULE AT CURRENT_TIMESTAMP DO DROP TABLE users;\n', 'unparsed'],
    ['a DEFINER with a space (CREATE DEFINER=`a b`@`%` EVENT)', 'CREATE DEFINER=`a b`@`%` EVENT e ON SCHEDULE AT CURRENT_TIMESTAMP DO ALTER TABLE `users` DROP COLUMN `nickname`;\n', 'unparsed'],
    ['a MySQL DELIMITER line (+ a DEFINER procedure)', 'DELIMITER //\nCREATE DEFINER=`root`@`%` PROCEDURE p() BEGIN DROP TABLE users; END //\nDELIMITER ;\n', 'unparsed'],
    ['MariaDB ALTER ONLINE TABLE', 'ALTER ONLINE TABLE `users` DROP COLUMN `nickname`;\n', 'unparsed'],
    ['DROP TYPE … CASCADE (PG drops the columns of that type too)', 'DROP TYPE "Role" CASCADE;\n', 'unparsed'],
    ["ALTER COLUMN … USING other than Prisma's enum cast", 'ALTER TABLE "users" ALTER COLUMN "biography" TYPE TEXT USING NULL;\n', 'unparsed'],
    ['UPDATE', 'UPDATE "users" SET "biography" = NULL;\n', 'data'],
    ['DELETE', 'DELETE FROM "users";\n', 'data'],
    ['TRUNCATE', 'TRUNCATE "users";\n', 'data'],
    ['MERGE', 'MERGE INTO "users" USING "x" ON 1 = 1 WHEN MATCHED THEN DELETE;\n', 'data'],
    ['INSERT … VALUES', `INSERT INTO "users" ("email") VALUES ('a');\n`, 'data'],
    ['MySQL REPLACE INTO', "REPLACE INTO `users` (`email`) VALUES ('a');\n", 'data'],
    ['a redefine copy with EXCEPT (copies nothing; sqlite3 run: 2 rows → 0)', copy(COLS, ` EXCEPT SELECT ${COLS} FROM "users"`), 'data'],
    ['a redefine copy with WHERE 0', copy(COLS, ' WHERE 0'), 'data'],
    ['a redefine copy whose SELECT list differs from its column list', REDEFINE.replace(/^INSERT INTO .*$/m, 'INSERT INTO "new_users" ("id", "email") SELECT "email", "id" FROM "users";'), 'data'],
  ];
  for (const [name, sql, kind] of rows) {
    assert.match(run(BASE, { [NEW]: sql })[0], new RegExp(`^error: prisma: ${NEW}: ${kind === 'data' ? 'data statement in a migration \\(D-0067\\)' : 'unparsed SQL'}: `), name);
  }
});

// real `prisma migrate diff --script` output, prisma 7.10.0 (empty → A, A → B, C → D per dialect; blank lines dropped;
// SQL Server without its two EXEC lines, which go red above)
const PG = `-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'GUEST');
-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "nickname" TEXT,
    "bio" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Post" (
    "id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
-- CreateIndex
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");
-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('USER', 'ADMIN', 'OWNER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';
COMMIT;
-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey";
-- DropIndex
DROP INDEX "User_email_key";
-- AlterTable
ALTER TABLE "User" DROP COLUMN "bio",
ADD COLUMN     "biography" TEXT,
ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "nickname" SET NOT NULL,
ALTER COLUMN "age" SET DATA TYPE BIGINT;
-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "slug" TEXT NOT NULL;
-- DropTable
DROP TABLE "Tag";
-- CreateIndex
CREATE INDEX "user_email_idx" ON "User"("email");
-- CreateIndex
CREATE UNIQUE INDEX "Post_slug_title_key" ON "Post"("slug", "title");
-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RenameIndex
ALTER INDEX "Post_authorId_idx" RENAME TO "post_author_idx";
-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'OWNER';
-- DropForeignKey
ALTER TABLE "Item" DROP CONSTRAINT "Item_acctId_fkey";
-- AlterTable
CREATE SEQUENCE acct_id_seq;
ALTER TABLE "Acct" DROP CONSTRAINT "Acct_pkey",
DROP COLUMN "gone",
ALTER COLUMN "id" SET DEFAULT nextval('acct_id_seq'),
ALTER COLUMN "role" SET DEFAULT 'ADMIN',
ADD CONSTRAINT "acct_pk" PRIMARY KEY ("id", "org");
ALTER TABLE "Acct" RENAME CONSTRAINT "Acct_pkey" TO "acct_pk";
ALTER SEQUENCE acct_id_seq OWNED BY "Acct"."id";
-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "acctOrg" INTEGER NOT NULL,
ALTER COLUMN "id" DROP DEFAULT;
-- DropEnum
DROP TYPE "Gone";
-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "item_acct_fk" FOREIGN KEY ("acctId", "acctOrg") REFERENCES "Acct"("id", "org") ON DELETE RESTRICT ON UPDATE CASCADE;
`;
const MYSQL = `-- CreateTable
CREATE TABLE \`User\` (
    \`id\` INTEGER NOT NULL AUTO_INCREMENT,
    \`email\` VARCHAR(191) NOT NULL,
    \`nickname\` VARCHAR(191) NULL,
    \`bio\` VARCHAR(191) NOT NULL,
    \`age\` INTEGER NOT NULL,
    \`role\` ENUM('USER', 'ADMIN', 'GUEST') NOT NULL DEFAULT 'USER',
    UNIQUE INDEX \`User_email_key\`(\`email\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- CreateTable
CREATE TABLE \`Post\` (
    \`id\` INTEGER NOT NULL,
    \`title\` VARCHAR(191) NOT NULL,
    \`authorId\` INTEGER NOT NULL,
    INDEX \`Post_authorId_idx\`(\`authorId\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- CreateTable
CREATE TABLE \`Tag\` (
    \`id\` INTEGER NOT NULL,
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- AddForeignKey
ALTER TABLE \`Post\` ADD CONSTRAINT \`Post_authorId_fkey\` FOREIGN KEY (\`authorId\`) REFERENCES \`User\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE;
-- DropForeignKey
ALTER TABLE \`Post\` DROP FOREIGN KEY \`Post_authorId_fkey\`;
-- DropIndex
DROP INDEX \`User_email_key\` ON \`User\`;
-- AlterTable
ALTER TABLE \`User\` DROP COLUMN \`bio\`,
    ADD COLUMN \`biography\` VARCHAR(191) NULL,
    ADD COLUMN \`score\` INTEGER NOT NULL DEFAULT 0,
    MODIFY \`nickname\` VARCHAR(191) NOT NULL,
    MODIFY \`age\` BIGINT NOT NULL,
    MODIFY \`role\` ENUM('USER', 'ADMIN', 'OWNER') NOT NULL DEFAULT 'USER';
-- AlterTable
ALTER TABLE \`Post\` ADD COLUMN \`slug\` VARCHAR(191) NOT NULL;
-- DropTable
DROP TABLE \`Tag\`;
-- CreateIndex
CREATE INDEX \`user_email_idx\` ON \`User\`(\`email\`);
-- CreateIndex
CREATE UNIQUE INDEX \`Post_slug_title_key\` ON \`Post\`(\`slug\`, \`title\`);
-- AddForeignKey
ALTER TABLE \`Post\` ADD CONSTRAINT \`Post_authorId_fkey\` FOREIGN KEY (\`authorId\`) REFERENCES \`User\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;
-- RenameIndex
ALTER TABLE \`Post\` RENAME INDEX \`Post_authorId_idx\` TO \`post_author_idx\`;
-- DropForeignKey
ALTER TABLE \`Item\` DROP FOREIGN KEY \`Item_acctId_fkey\`;
-- AlterTable
ALTER TABLE \`Acct\` DROP PRIMARY KEY,
    DROP COLUMN \`gone\`,
    MODIFY \`role\` ENUM('USER', 'ADMIN', 'OWNER') NOT NULL DEFAULT 'ADMIN',
    ADD PRIMARY KEY (\`id\`, \`org\`);
-- AlterTable
ALTER TABLE \`Item\` ADD COLUMN \`acctOrg\` INTEGER NOT NULL,
    MODIFY \`id\` INTEGER NOT NULL;
-- AddForeignKey
ALTER TABLE \`Item\` ADD CONSTRAINT \`Item_acctId_acctOrg_fkey\` FOREIGN KEY (\`acctId\`, \`acctOrg\`) REFERENCES \`Acct\`(\`id\`, \`org\`) ON DELETE RESTRICT ON UPDATE CASCADE;
`;
const SQLITE = `-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "nickname" TEXT,
    "bio" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER'
);
-- CreateTable
CREATE TABLE "Post" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- CreateTable
CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
);
-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
-- CreateIndex
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Tag";
PRAGMA foreign_keys=on;
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "biography" TEXT,
    "age" BIGINT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL DEFAULT 'USER'
);
INSERT INTO "new_User" ("age", "email", "id", "nickname", "role") SELECT "age", "email", "id", "nickname", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE INDEX "user_email_idx" ON "User"("email");
CREATE TABLE "new_Post" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Post" ("authorId", "id", "title") SELECT "authorId", "id", "title" FROM "Post";
DROP TABLE "Post";
ALTER TABLE "new_Post" RENAME TO "Post";
CREATE INDEX "post_author_idx" ON "Post"("authorId");
CREATE UNIQUE INDEX "Post_slug_title_key" ON "Post"("slug", "title");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Acct" (
    "id" INTEGER NOT NULL,
    "org" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    PRIMARY KEY ("id", "org")
);
INSERT INTO "new_Acct" ("id", "name", "org", "role") SELECT "id", "name", "org", "role" FROM "Acct";
DROP TABLE "Acct";
ALTER TABLE "new_Acct" RENAME TO "Acct";
CREATE TABLE "new_Item" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "acctId" INTEGER NOT NULL,
    "acctOrg" INTEGER NOT NULL,
    CONSTRAINT "Item_acctId_acctOrg_fkey" FOREIGN KEY ("acctId", "acctOrg") REFERENCES "Acct" ("id", "org") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("acctId", "id") SELECT "acctId", "id" FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
`;
const SQLSERVER = `BEGIN TRY
BEGIN TRAN;
-- DropForeignKey
ALTER TABLE [dbo].[Post] DROP CONSTRAINT [Post_authorId_fkey];
-- DropIndex
DROP INDEX [User_email_key] ON [dbo].[User];
-- AlterTable
ALTER TABLE [dbo].[User] ALTER COLUMN [nickname] NVARCHAR(1000) NOT NULL;
ALTER TABLE [dbo].[User] ALTER COLUMN [age] BIGINT NOT NULL;
ALTER TABLE [dbo].[User] DROP COLUMN [bio];
ALTER TABLE [dbo].[User] ADD [biography] NVARCHAR(1000),
[score] INT NOT NULL CONSTRAINT [User_score_df] DEFAULT 0;
-- AlterTable
ALTER TABLE [dbo].[Post] ADD [slug] NVARCHAR(1000) NOT NULL;
-- DropTable
DROP TABLE [dbo].[Tag];
-- CreateIndex
CREATE NONCLUSTERED INDEX [user_email_idx] ON [dbo].[User]([email]);
-- CreateIndex
ALTER TABLE [dbo].[Post] ADD CONSTRAINT [Post_slug_title_key] UNIQUE NONCLUSTERED ([slug], [title]);
-- AddForeignKey
ALTER TABLE [dbo].[Post] ADD CONSTRAINT [Post_authorId_fkey] FOREIGN KEY ([authorId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;
-- RenameIndex
COMMIT TRAN;
END TRY
BEGIN CATCH
IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW
END CATCH
`;
const PBASE = `model User {
  id       Int     @id @default(autoincrement())
  email    String  @unique
  nickname String?
  bio      String
  age      Int
  role     Role    @default(USER)
  posts    Post[]
}
model Post {
  id       Int  @id
  title    String
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
model Tag {
  id Int @id
}
enum Role {
  USER
  ADMIN
  GUEST
}
`;
test('K8 D-0066 allowlist, positive: real prisma migrate output of each dialect parses; only its drops are reported', () => {
  /** @type {[string, string, string[]][]} */
  const rows = [
    ['postgresql (enum rewrite, sequences, renamed constraint and index)', PG, ['drop User.bio', 'drop Tag', 'drop Acct.gone', 'drop Gone']],
    ['mysql (MODIFY, DROP / ADD PRIMARY KEY, DROP FOREIGN KEY, RENAME INDEX)', MYSQL, ['drop User.bio', 'drop Tag', 'drop Acct.gone']],
    ['sqlite (PRAGMA-wrapped DropTable, RedefineTables ×4 with their exact copies)', SQLITE, ['drop Tag', 'drop User.bio']],
    ['sqlserver (TRY/CATCH wrapper, ADD [a] …, [b] …, ALTER COLUMN)', SQLSERVER, ['drop User.bio', 'drop Tag']],
  ];
  for (const [name, sql, want] of rows) {
    const base = { 'prisma/schema.prisma': PBASE, ...MIG };
    const r = diff({ base, head: { ...base, [NEW]: sql } });
    assert.deepEqual(r.ok === true ? r.changes.map((c) => `${c.op} ${c.ref}`) : r.why, want, name);
  }
});

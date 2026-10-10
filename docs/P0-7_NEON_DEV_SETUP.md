# P0-7 — Development database setup

Status: **BLOCKED pending operator confirmation** — no database command has been run.
Branch inspected: `p0-hardening`. Scope: `expense-tracker-backend/` only.
This document records inspection evidence and the steps an operator must take before the P0-7
migration/constraint verification can run.

---

## 1. What I verified (evidence)

Everything below was established by read-only inspection. No Prisma command that connects to a
database was run, no migration was run, no file was modified.

### 1.1 Prisma CLI and client versions

Command: `npx prisma --version` (this reports local tool versions; it does **not** connect to a
database). Literal output:

```
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
prisma                  : 6.12.0
@prisma/client          : 6.12.0
Computed binaryTarget   : darwin-arm64
Operating System        : darwin
Architecture            : arm64
Node.js                 : v24.15.0
TypeScript              : unknown
Query Engine (Node-API) : libquery-engine 8047c96bbd92db98a2abc7c9323ce77c02c89dbc (at node_modules/@prisma/engines/libquery_engine-darwin-arm64.dylib.node)
PSL                     : @prisma/prisma-schema-wasm 6.12.0-15.8047c96bbd92db98a2abc7c9323ce77c02c89dbc
Schema Engine           : schema-engine-cli 8047c96bbd92db98a2abc7c9323ce77c02c89dbc (at node_modules/@prisma/engines/schema-engine-darwin-arm64)
Default Engines Hash    : 8047c96bbd92db98a2abc7c9323ce77c02c89dbc
Studio                  : 0.511.0
```

Summary of the requested facts:

| Fact | Observed value |
| --- | --- |
| `prisma` (CLI) | **6.12.0** |
| `@prisma/client` | **6.12.0** |
| Node.js | **v24.15.0** |
| Prisma engine type | **Default Rust-based engines**: Query Engine `libquery-engine` exposed via **Node-API (library engine)** for the client, plus `schema-engine-cli` for migrations/introspection. Binary target `darwin-arm64`. |
| Platform | macOS (darwin), arm64 |

Note: the two lines `Environment variables loaded from .env` and `Prisma schema loaded from
prisma/schema.prisma` are only informational — the CLI parsed the schema and the env file. The
output contains no server/database information, which is consistent with `--version` not
connecting to a database.

### 1.2 Versions pinned in package.json and package-lock.json

`package.json` (dependency declarations, both caret-ranged):

```json
"@prisma/client": "^6.12.0",
"prisma": "^6.12.0"
```

`package-lock.json` (lockfileVersion 3, resolved/pinned versions):

```
node_modules/@prisma/client        -> 6.12.0
node_modules/prisma                -> 6.12.0
node_modules/@prisma/engines       -> 6.12.0
node_modules/@prisma/engines-version -> 6.12.0-15.8047c96bbd92db98a2abc7c9323ce77c02c89dbc
```

Installed `node_modules` versions (independent check): `@prisma/client` **6.12.0**,
`prisma` **6.12.0**.

So declaration, lockfile and installed tree agree at **6.12.0**. Note that the declared ranges are
caret (`^6.12.0`) but the lockfile pins 6.12.0, and the installed tree matches the lockfile.

### 1.3 The datasource block currently has NO `directUrl`

Command: `grep -n "directUrl" prisma/schema.prisma` → no match (`NO MATCH: directUrl absent`).

Literal `datasource` block from `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Confirmed: `directUrl` is **not** present. There is exactly one URL used for both application
traffic and migrations.

### 1.4 `DATABASE_URL` pooled-endpoint check (boolean only)

Command (prints a boolean only; never the value, host, or credentials):

```bash
grep -q -- "-pooler" .env && echo yes || echo no
```

Result: **yes** — `DATABASE_URL` matches a `-pooler` pattern, i.e. it appears to be a **Neon pooled
endpoint**. No value, host or credential was read or printed.

### 1.5 Other `.env.*` files and the KEY NAMES in `.env`

- `.env.*` files present other than `.env`: **none** (0). There is no `.env.local`,
  `.env.development`, `.env.example`, or any other environment file in this directory.
- Key names in `.env`, obtained with `cut -d= -f1 .env` (**names only — no values were printed**):

```
DATABASE_URL
JWT_SECRET
EMAIL_USER
EMAIL_APP_PASSWORD
FRONTEND_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Two consequences: (a) there is exactly one database connection key, `DATABASE_URL`, and no
`DIRECT_URL` key exists yet; (b) there is no non-production environment file to point commands at.

### 1.6 `.env` is git-ignored

`.gitignore` contains exactly one line:

```
.env
```

Command: `git check-ignore -v .env` →

```
.gitignore:1:.env	.env
```

So `.env` is ignored and cannot be committed. `git ls-files` shows **no** `env` file tracked
outside `node_modules/` (the only matches were library files inside `node_modules`, which are
vendored dependency files, not project env files).

### 1.7 Related repository facts

- Migration history present: **10** migration directories under `prisma/migrations/`
  (`20260901144212_init` … `20261010225757_add_user_token_version`), plus `migration_lock.toml`
  with `provider = "postgresql"`.
- `docs/DEFECT_REGISTER.md` already records the same environment finding and marks P0-7 as
  `BLOCKED`.

### 1.8 Not verified

- **`.env.example` does not exist.** It is absent from the working tree, is not tracked by git, and
  `git log --all -- .env.example` returns no output (it has never existed in this repository's
  history). Any instruction to "update `.env.example` in the same commit" therefore actually means
  *create* it in that commit. This document does not create it.
- **Whether the currently configured database is production.** I did not connect to it, so this is
  an assumption based on the operator's stated policy, not a measured fact.
- **Whether the configured endpoint is reachable, or what data it holds.** No connectivity was
  tested.
- **The upstream Prisma version that introduced `directUrl`.** Support in *6.12.0* is confirmed
  below from the installed CLI bundle; the historical "introduced in 4.10.0" claim was not
  independently re-verified in this environment.

---

## 2. Why database operations are currently blocked

The backend has **one** environment file (`.env`) and **one** database key (`DATABASE_URL`). There
is no `.env.development`, no `.env.local`, no `directUrl`, and no `DIRECT_URL`. Consequently every
Prisma command — `migrate status`, `migrate deploy`, `db push`, `migrate dev`, `db execute`,
`prisma studio` — resolves its target from that single variable. There is no configuration that
selects a different database, so **any** Prisma command would act on the one configured database.

Because that database is the one the running application uses and must be treated as
**production**, running a migration or any schema-changing command against it is unacceptable
without explicit authorisation and a verified non-production target. Even `migrate status` is
withheld under the current policy, because the policy is "no Prisma command against the single
configured target until a dedicated non-production target is confirmed".

**Why the pooled endpoint is unsuitable for migrations.** Neon's pooled endpoint (`-pooler` in the
host) is a PgBouncer-style connection pooler, normally in transaction pooling mode. In that mode a
client's statements are not guaranteed to stay on the same server connection for the life of a
session. Prisma's migration engine relies on session-scoped behaviour: it takes a Postgres
**advisory lock** to serialise concurrent migrations, and migration steps are wrapped in
**transactions** whose semantics assume a stable session. Under transaction pooling, advisory locks
and session-level state can be lost or applied on a different backend connection than the
transaction, and multi-statement transaction guarantees do not hold. That is why migrations must go
to the **direct** (unpooled) endpoint.

**Why the app and migrations may need different endpoints.** The application wants a pooled
endpoint: many short-lived connections from a serverless/short-lived process are best multiplexed
by the pooler, which avoids exhausting Postgres connection limits. Migrations want a direct
endpoint for the session/lock/transaction reasons above. One variable cannot correctly serve both
roles, which is exactly the gap `directUrl` fills: `url` serves the application, `directUrl` serves
migration and introspection commands.

---

## 3. Recommended Prisma configuration (exact)

**Target Prisma version: 6.12.0** (CLI and client both 6.12.0; see §1.1–1.2).

**Is `directUrl` supported by this version? Yes.** Confirmed by inspecting the installed CLI bundle
`node_modules/prisma/build/index.js`: it contains 6 occurrences of `directUrl`, including the
resolution logic `directUrl!==void 0?r.directUrl:r.url` (i.e. "use `directUrl` when present, else
fall back to `url`"), an assignment `directUrl:this.directUrl`, and a validation error string
containing `` `directUrl` setting ``. A version that did not support the attribute would reject it
at schema-validation time. So 6.12.0 supports `directUrl`.

The exact datasource block to use:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Meaning of the two attributes:

- **`url`** continues to serve the **application**. It stays the pooled endpoint and is the variable
  the running server (and `@prisma/client`) uses for all normal queries.
- **`directUrl`** is used **only** by migration and introspection commands
  (`prisma migrate dev/deploy/status/reset`, `prisma db pull`, `prisma db push`,
  `prisma migrate diff` against a live database). Those commands connect to the direct endpoint,
  where advisory locks and transactions behave correctly. It changes nothing about how the app
  connects at runtime.

Constraints on making this change:

- **It must be made in the SAME commit as the `.env.example` update**, so the schema and the
  documented variable set never drift apart. Per §1.8, `.env.example` does not exist today: that
  commit must *create* it (key names only, with `<dev-pooled-url>` / `<dev-direct-url>`
  placeholders — never real values).
- **`prisma/schema.prisma` must NOT be changed before the development database exists.** Editing
  the schema first leaves the repository with a `directUrl = env("DIRECT_URL")` that no environment
  can satisfy, which breaks every migration command (and `migrate status`) with a missing-variable
  error until the dev environment is created.
- **Adding `directUrl` alone changes no data and no schema.** It is a datasource wiring change only:
  no table, column, index or row is touched, and it does not by itself authorise running any
  migration. It only makes it *possible* to point migrations at a non-production endpoint.

---

## 4. Step-by-step: creating the development database (non-technical)

Audience: someone comfortable clicking around a web console who is not a database expert. Neon is a
hosted Postgres service; a "project" is a database, and a "branch" is an isolated copy-on-write
instance inside a project.

1. **Sign in.** Open the Neon console in a browser and sign in to your account
   (`https://console.neon.tech`). This is an external site, not something in this repository.
2. **Create a NEW project.** In the console choose **New Project**. Give it an unmistakable
   development name, e.g. `expense-tracker-dev`, and pick a region close to you. A brand-new project
   starts empty — that is what you want.
   - If you prefer to work inside a branch, create the branch **inside this brand-new project**
     only. Never create the branch inside the project that holds production data.
3. **Do NOT use any "copy data", restore, import, or branch-from-production option.** If the console
   offers to copy data from an existing project (or you are tempted to branch the production
   project), **stop** — this environment must contain **only synthetic data**, and copying
   production would put real financial records into a non-production system.
   Do not point this setup at the production project in any way.
4. **Find the two connection strings.** In the new project, open the **Connect** (or
   **Connection Details**) panel. Neon shows connection strings for the database and role. You need
   two of them:
   - **Pooled** connection string — its host contains `-pooler`. This is for the **application**;
     it multiplexes connections. You will store it as `DATABASE_URL`.
   - **Direct** connection string — the same host **without** `-pooler` (turn the pooling toggle
     off to reveal it). This is for **migrations**; it gives a stable session. You will store it as
     `DIRECT_URL`.
   If a password is shown, copy it now; some consoles show a credential only once.
5. **Store them safely.** Create the file `expense-tracker-backend/.env` containing exactly two
   database keys (plus whatever other keys the app already needs):

   ```
   DATABASE_URL="<dev-pooled-url>"
   DIRECT_URL="<dev-direct-url>"
   ```

   Replace the angle-bracket placeholders with the two strings from step 4. **Never commit this
   file.** You do not have to do anything special to protect it: `.env` is already listed in
   `.gitignore` (verified — see §1.6, `git check-ignore` reports `.gitignore:1:.env	.env`), so Git
   will not track it. Do not "force add" it, and do not paste the strings into a tracked file,
   a document, a chat message, or a screenshot.
6. **Confirm the app is pointed at development, not production** — using safe, read-only checks
   only:
   - Check the **database name and host in the Neon UI** against the name you chose in step 2, and
     check that `DATABASE_URL` in `.env` contains your development project's identifiers.
   - In the Neon console's **SQL Editor** for the development project, run:
     ```sql
     SELECT current_database();
     ```
     This is read-only. It should return the database name of your brand-new development project
     (e.g. `neondb` or the name you chose), not a production database name.
   - Optionally `SELECT count(*) FROM "Expense";` to confirm the expected synthetic row count.
   - **Never run a destructive statement to "test" the connection** — no `DROP`, `DELETE`,
     `TRUNCATE`, `UPDATE`, `ALTER`, or `migrate reset`. "Testing" a connection must never be able to
     destroy data; a read-only `SELECT` is always sufficient.
7. **Seed synthetic data.** Populate the development database with a **few obviously fake
   expenses** you invent yourself — e.g. `Coffee 120`, `Test Groceries 2500`, `Fake Rent 15000`,
   with fake merchants and dates. Create them through the application's own UI/API against the dev
   configuration, or by hand in the SQL editor. **Do not use any real financial record, real
   statement export, real merchant list, or real account numbers**, and do not import a production
   CSV. A handful of rows is enough for testing.
8. **Rotate or remove credentials afterwards.** If the development environment is temporary: when
   you are finished, delete the project/branch in the Neon console, and **reset/rotate** the
   database role's password so the old strings stop working. Remove the dev values from your local
   `.env` (and from your shell history and clipboard). Never leave a live development credential
   lying around after the work is done.

---

## 5. Env-var override for one-off commands

You do **not** need to edit `.env` to point a single command at development. Set the variables for
that one invocation at the shell level:

```bash
DATABASE_URL="<dev-pooled-url>" DIRECT_URL="<dev-direct-url>" npx prisma migrate status
```

Why this is safe and works:

- **An explicit environment variable takes precedence over `.env`.** The Prisma CLI loads `.env`
  through `dotenv`, and dotenv's `populate()` does **not** overwrite a variable that already exists
  in `process.env` unless `{ override: true }` is passed. Verified in the installed source
  (`node_modules/dotenv/lib/main.js`), which checks
  `Object.prototype.hasOwnProperty.call(processEnv, key)` and, when `override` is false, leaves the
  existing value in place. So the values you place on the command line win, and the `.env` values
  are ignored for that run.
- This is the **mechanism to use so no production credential is ever used**: the command receives
  dev endpoints directly, and you never have to repoint `.env` (and therefore never risk leaving
  the app pointed at dev, or a later command silently using production).
- Put **both** variables in the override. `DATABASE_URL` already exists in `.env` today, but
  `DIRECT_URL` does **not** (see §1.5), so a command run against a schema that uses `directUrl`
  would fail with a missing-variable error unless `DIRECT_URL` is supplied explicitly.

Safety notes for this technique:

- Values on a command line can land in your **shell history** and be visible in the process list.
  Prefer a leading space (if `HISTCONTROL=ignorespace` is set), or export the variables in a
  short-lived subshell — e.g. `read -rs DIRECT_URL` (and likewise `DATABASE_URL`) to type them
  without echoing, then run the command — and clear the history/clipboard afterwards.
- Start with the least invasive command, e.g. `npx prisma migrate status` — it is read-only — and
  never substitute a reset/destructive command for it.
- These placeholders are deliberately not real values. Substitute the strings from §4 step 4 at
  invocation time only.

---

## 6. Safety rules

- **Never use production credentials in this environment.** Development work must use development
  endpoints only.
- **Never copy production financial records** — not via "copy data", restore, import, CSV export,
  or a dump. This environment must contain synthetic data only.
- **Never assume a Neon branch is anonymised just because it is a branch.** A branch created from a
  production project is a copy of production data; branching is a storage/copy-on-write feature,
  not a privacy control. Branches must be created in a brand-new project, never from production.
- **Confirm the target before any write.** Check the database name/host and run a read-only
  `SELECT current_database();` before any command that could modify anything. When in doubt, stop.
- **Migrations are still not authorised** until the environment is verified and the operator
  confirms the target (see §7). `directUrl` support in the schema does not grant that authorisation.
- Never print, commit, paste into a document, or screenshot a connection string or credential.
- `.env` must stay untracked; never `git add -f` it, and never add real values to a tracked file.

---

## 7. Open questions for the operator

Before P0-7 can run, the following confirmations are needed:

1. **Which Neon project and branch is the development target?** Provide the project name and branch
   name (not the credential). Confirm it is a **new** project/branch, not the production project.
2. **Confirmation that it contains no copied production data.** Explicit confirmation that no
   "copy data" / restore / import / production-branch was used, and that the environment holds
   synthetic data only.
3. **Approval to run read-only commands against it** — at minimum `npx prisma migrate status`, and
   `SELECT current_database();` in the SQL editor (**no** destructive statement, no migration).
4. **Authorisation to make the schema change and create `.env.example`.** Confirm that
   `prisma/schema.prisma` (adding `directUrl`) and the *new* `.env.example` may be created together
   in one commit — noting that `.env.example` does not exist today (§1.8) and that the schema must
   not be changed before the development database exists.
5. **When migrations themselves are authorised** (a later, separate step), and the exact command
   approved for that step.

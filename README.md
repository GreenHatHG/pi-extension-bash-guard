# pi-extension-bash-guard

A pi extension that catches "big output" from bash/powershell and returns only a few key lines + the
full-output path on disk + **write-it-right advice based on the command type**; blocks unbounded scans
rooted at `$HOME`, `/`, or a system dir (`/etc`, etc.) **before they run**; caps search commands
(`find`/`grep -r`/`rg`/`du`/`tree`) at a 5-minute timeout; can fence a whole process to **read-only bash**
(`PI_BASH_GUARD_MODE=advisor`); and injects an output-discipline note once
at session start. The goal isn't to cut output — it's to **push the model to write shell right**,
without **blocking the payload the model really needs**.

## Behavior

Four things, three hard and one soft:

1. **Set the rules up front (soft)**: on the session's first agent run, inject a `[BASH OUTPUT DISCIPLINE]`
   note (`display: false`, model context only, not the TUI) that tells the model how to bound searches /
   file reads / logs, and what to do when the guard steps in. A normal session gets it once; after
   compaction it's injected again on the next agent run.
2. **Block unbounded scans before they run (hard)**: at `tool_call`, check the scan root of
   `find`/`grep -r`/`rg`/`du`/`tree`. If it's `$HOME` (including `~`, `$HOME`, `${HOME}`, a literal home
   path), `/`, or an exact system dir (`/etc`, `/var`, `/usr`, `/System`, `/Library`, `/Applications`,
   `/opt`, `/private`, `/bin`, `/sbin`, `/dev`, `/proc`), **block it** and return narrowing hints
   (`rg -l <pattern> ~/Projects`, `mdfind -name '<name>'`, or add `-g '!Library/**'`). Deeper subdirs
   (`/etc/nginx`, `~/Library/Preferences`) always pass. Why: these commands produce almost no output,
   so the byte guard can't catch them at all, yet they walk tens of GB (a real incident took 934 seconds).
3. **Cap search commands at 5 minutes (hard)**: at `tool_call`, for search commands (`find`, recursive
   `grep`, `rg`, `du`, `tree`) with no `timeout` or a value over 300 seconds, rewrite `input.timeout` in
   place to **300**; a smaller model-set value is respected (300 is a ceiling, not an override).
   Non-search commands are **left completely alone** — long runners like `tail -f`/`watch`/foreground
   servers keep going.
4. **Read-only fence for fenced processes (hard, opt-in)**: when `PI_BASH_GUARD_MODE` is set, every
   `bash`/`powershell` call is judged **before it runs** against a read-only allow list, and anything
   that writes, deletes, installs, builds, tests, or reaches the network is blocked with a
   `[BASH READ-ONLY FENCE]` reason that names the way out (the `read` tool, the session-recall CLI).
   The allow list is a small set of readers: `rg`/`grep`/`sed -n`/`head`/`tail`/`wc`/`ls`/`stat`/
   `file`/`sort`/`uniq`/`cut`/`tr`/`diff`/`jq`, read-only `git` subcommands (`log`/`show`/`diff`/
   `status`/`blame`/`rev-parse`/...), read-only `tmux` inspection (`capture-pane`/`has-session`/`ls`),
   and `bun <script> ...` / `pi-vcc ...` so a recall CLI keeps working. Output redirects (`>`, `>>`,
   `2>&1`) are blocked everywhere; so are commands that hand off to another program (wrappers like
   `sudo`/`env`/`xargs`, `rg --pre`, interpreters) and flags that never return (`tail -f`, `ls -R`).
   An unparsable command (unclosed quote) or an unknown mode value fails **closed**. The fence matches
   literal command names only — it does not expand `${VAR}` or aliases, so a poisoned environment is
   out of its scope. The mode itself comes from the env var and is not writable from the session, so a
   fenced process can't switch it off (the `[READ-ONLY SESSION]` notice says so, and the status bar
   shows `🛡 read-only`). See `src/read-only.ts`.

   A real incident: `grep -rln ... ~/.pi ~/Projects ~/ensoai | grep -v ...` ran for **5148 seconds**
   with no timeout; now such commands are pulled to 5 minutes.
4. **Hard block when over the limit (hard)**: at `tool_result`, classify the command first, then use a
   different limit per class:

   - **Process output** (search/list/dump: `rg`, recursive `grep`, `find`, `ls -R`, `env`, `ps`,
     `git log`…): uses the **tight limit** (default **8KB**). Replaced with a preview + full path +
     **rewrite hints**, and counted for repeat/escalation warnings.
   - **Valuable payload** (everything else, including file reads like `cat`/`sed` and builds/tests
     like `pnpm build`/`pytest`): uses the **wide limit** (default **30KB**). Under the limit it
     **passes through untouched**; over it, it's saved to disk with **no lecturing** — just where the
     full output is and how to pull only what's needed with the `read`/`grep` tools.

   Both classes keep: head/tail preview (repeated lines folded to `(×N)`), auto-picked error/warning
   lines, and the full-output path on disk.

   Sample when "process output" is intercepted:

```
[BASH OUTPUT GUARD] Output withheld: 1842 lines / 214.3KB (limit 8.0KB).

Preview — first 20 lines:
  <first 20 lines, repeated lines folded to (×N)>
  ... [1795 lines omitted] ...
Preview — last 15 lines:
  <last 15 lines>

Error/warning lines:
  <auto-picked error/warning lines, up to 15>

Full output saved to: /var/folders/.../pi-bash-guard-XXXX/output-0.txt
Read it selectively: the `read` tool with offset/limit, or the `grep` tool pointed at this file.

Rewrite the command instead of repeating it. Do NOT re-run the same command, and do NOT just pipe it to
`less`/`more`. Suggestions:
  - Cap the search: `rg -l <pattern>` lists matching files only, `-c` counts per file, or `-m 5` / `--max-count=5` caps matches per file.
```

   Sample when "valuable payload" is intercepted (no rewrite lecture):

```
[BASH OUTPUT GUARD] Large result saved to disk: 3200 lines / 41.2KB (inline limit 30.0KB).
...
Full output saved to: /var/folders/.../pi-bash-guard-XXXX/output-0.txt
Read it selectively: the `read` tool with offset/limit, or the `grep` tool pointed at this file.

This looks like the content you asked for, so it was capped at the wider payload limit rather than the
process-output limit. The full output is in the file above; read only the parts you need, and do not
re-run the command.
```

What it does NOT do: **no guessing output size** (it won't auto-add `| head`, which would break
redirection/pipe semantics), and it does **not override the installed `bash` tool** (pi's built-in
already truncates at 2000 lines/50KB and saves the full text; this extension tightens the tight limit,
widens the payload limit, and adds "rewrite" advice on top). Command-level intervention happens in
exactly two places: the `$HOME`/`/`/system-dir scan **pre-block** in point 2, and the **5-minute search
cap** in point 3 (non-search commands are never touched).

## Highlights

- **Targeted advice**: specific rewrites based on the original command (`cat` → `read`/`sed`; unbounded
  `rg` → `-l`/`-c`/`-m`; `git log` → `--oneline -n 20`; `find`/`ls -R`/`du -a`/`env`/`docker logs`…).
- **Errors stay visible**: on `isError` the tail preview is longer, and signal lines like
  `Error`/`Traceback`/`npm ERR!` are pulled to the front.
- **Repeat-offender escalation (process output only)**: seeing the same process-output command again
  says "already intercepted"; the 3rd such hit in a session adds an escalation warning. Re-reading
  valuable payload is fine and doesn't count.
- **Limits per class**: classify the command as "process output / build-test / other payload" first
  (strict allowlist, unsure means payload), then apply the 8KB / 30KB limits, so content the model
  really needs isn't pushed into "save to disk + read in slices".
- **Bound searches, leave the rest alone**: only search commands get the auto 5-minute cap, and a
  smaller explicit budget is respected; non-search commands are never touched, so long builds aren't
  hurt and "recursive search runs for tens of minutes unnoticed" is closed off.
- **Full output is retrievable**: prefer reusing the **complete** output the built-in bash truncation
  saved; otherwise write the current text to this extension's temp file, cleaned up at session end.
  The model can `read` with offset/limit or `rg`/`sed` it directly.
- **Cache-safe**: only append-only rewrites at the tail of `tool_result`; no systemPrompt changes, no
  tool-set changes, no `context` handlers.

## Install

```bash
# no install, try the current dir
pi -e .

# or add the local package to settings
pi install /Users/jooooody/Projects/pi-extension-bash-guard

# or copy it manually (single-file entry)
cp -r src ~/.pi/agent/extensions/bash-guard/
```

After install, `/reload` to hot-load it; `pi list` shows installed packages and `pi remove ...` uninstalls.

## Platform limits

The `powershell` tool also goes through the byte-output guard and the timeout cap for recognizable
search commands; but the scan-root parser is built mainly for POSIX shell syntax and isn't a full
PowerShell parser yet. Windows paths, native PowerShell commands (like `Get-ChildItem -Recurse`), and
backtick escapes can slip past the pre-run scan block. For strict scan protection, use commands the
parser understands (bash/`rg`), or confirm by hand before turning the policy off or changing it.

## Config

Commands:

| Command | Effect |
|---|---|
| `/bash-guard` | toggle on/off |
| `/bash-guard on` / `off` | explicit on/off |
| `/bash-guard status` | show current limits, preview lines, scan-block switch, session hit count |
| `/bash-guard scan on` / `off` | toggle the "pre-block scans of `$HOME`/`/`/system dirs" rule alone |
| `/bash-guard bytes 8192` | change the process-output byte limit (`0` = no limit for this tier; use `on`/`off` for the master switch) |
| `/bash-guard payload 30720` | change the valuable-payload byte limit (`0` = no limit for this tier) |
| `/bash-guard preview 25 15` | change head/tail preview lines |

Config is saved into the session with `pi.appendEntry` and replayed on resume.

Env vars act as **new-session seed values** (a saved session config wins):

| Var | Default | Notes |
|---|---|---|
| `PI_BASH_GUARD_DISABLED` | — | any non-empty, non-0 value turns it off by default |
| `PI_BASH_GUARD_ENABLED=0` | — | off by default |
| `PI_BASH_GUARD_SCAN_BLOCK=0` | — | on by default; set to `0`/`false`/`off`/`no` to turn off the scan pre-block |
| `PI_BASH_GUARD_MAX_BYTES` | `8192` | process-output byte limit, 0 = no byte limit for this tier (tiers are independent) |
| `PI_BASH_GUARD_PAYLOAD_MAX_BYTES` | `30720` | valuable-payload byte limit, 0 = no limit for this tier |
| `PI_BASH_GUARD_PREVIEW_HEAD` | `20` | head preview lines |
| `PI_BASH_GUARD_PREVIEW_TAIL` | `15` | tail preview lines (on success) |
| `PI_BASH_GUARD_ERROR_TAIL` | `25` | tail preview lines (on failure) |
| `PI_BASH_GUARD_MODE` | — | not a seed value: read from the env on **every** tool call. `advisor` = read-only fence; any other non-empty value = block all bash (fail closed). Set by the sub-agent launcher (see `pi-extension-tmux-subagent`), never persisted into the session |

Status bar: shows `🛡 bash-guard` when enabled, `🛡 bash-guard ×N` after interceptions. In a fenced
process it shows `🛡 read-only` and `🛡 read-only ×N` (fence blocks only).

## Design trade-offs

- **Why two limits**: one global limit would weld "process noise" and "valuable payload" together —
  once the latter is intercepted, the model is pushed into "save + read in slices", which costs more
  and is easier to under-read. Command classification is a strict allowlist; unsure means payload, so
  the error direction is "give more content", not "swallow content".
- **Why `tool_result`, not `tool_call`**: you only know if output is big once you have it; blindly
  adding `| head` at `tool_call` would break redirection, change exit-code meaning, and might cut off
  errors.
- **Bytes only, not lines**: context cost ≈ bytes (~4 chars/token); line count doesn't track tokens.
  Default 8KB ≈ 2k tokens. Many short lines (e.g. 2000 lines of `a` ≈ 4KB) aren't expensive and
  shouldn't be intercepted.
- **Why not override the `bash` tool**: pi's built-in already does truncation + full-output save +
  session env injection + a renderer; overriding means copying it and tracking upstream drift forever.
  A `tool_result` content patch is enough.
- **Why not cover `read`/`grep`/`find`**: those built-ins already have structured truncation and
  offset/limit/head_limit params, so v1 doesn't handle them again.
- **Why inject a search `timeout` instead of blocking**: `tool_call`'s `input` is mutable, so pulling
  `timeout` to 300 seconds takes effect right away with no extra "block → resend" round trip; and it's
  a ceiling — a smaller model-set budget is used as is. The cost is the model may not know it was
  capped, but the `[BASH TIMEOUT GUARD]` error hint covers that on a hit.
- **Why leave all other commands alone**: `tail -f`/`watch`/foreground servers are meant to run long;
  hard-blocking would only push the model to write `timeout: 999999` and bypass it. Putting the limit
  only on "search" — the one class with a definite bounded need — keeps friction lowest.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm check:biome # lint + format check
```

Layout:

```
src/index.ts          plugin wiring: events, /bash-guard command, status bar, temp-file lifecycle
src/config.ts         limit defaults, env seeds, command arg parsing, session-persist replay
src/analyze.ts        size checks, built-in footer removal, preview trim, repeat folding, signal pickup
src/classify.ts       command classes: process output / build-test / valuable payload (strict allowlist, word list from claude-code)
src/suggest.ts        command heuristics -> rewrite hints
src/scan-guard.ts     scan parsing: quote-aware segment split + tokenizer + find/grep/rg/du/tree root check
src/read-only.ts      the read-only allow list: judge a command, and read the fence mode from the env
src/timeout-guard.ts  5-minute timeout cap for search commands (pure helper)
src/guard-message.ts  build the final guard text
tests/                pure helpers + end-to-end (mockPi) cases
```

## License

MIT

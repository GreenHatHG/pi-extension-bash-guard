import { describe, expect, test } from "vitest";
import { judgeReadOnlyCommand, MODE_ENV, READ_ONLY_MODE, readOnlyMode } from "../src/read-only";

const ok = (cmd: string) => judgeReadOnlyCommand(cmd).ok;
const reason = (cmd: string) => {
	const v = judgeReadOnlyCommand(cmd);
	return v.ok ? "" : v.reason;
};

describe("readOnlyMode", () => {
	test("unset and empty mean no fence", () => {
		expect(readOnlyMode({})).toBeUndefined();
		expect(readOnlyMode({ [MODE_ENV]: "" })).toBeUndefined();
		expect(readOnlyMode({ [MODE_ENV]: "   " })).toBeUndefined();
	});
	test("a value is a fence, trimmed", () => {
		expect(readOnlyMode({ [MODE_ENV]: "advisor" })).toBe(READ_ONLY_MODE);
		expect(readOnlyMode({ [MODE_ENV]: " task " })).toBe("task");
	});
});

describe("judgeReadOnlyCommand: allowed", () => {
	test("the recall CLI in both shapes", () => {
		expect(ok("bun /Users/jooooody/Projects/pi-vcc/cli/main.ts recall /tmp/s.jsonl keyword")).toBe(true);
		expect(ok("pi-vcc compact /tmp/s.jsonl")).toBe(true);
		expect(ok("/usr/local/bin/bun /x/main.ts recall f k")).toBe(true);
		expect(ok("FOO=1 bun /x/main.ts recall f k")).toBe(true);
	});
	test("plain read commands", () => {
		for (const cmd of [
			"rg -l -m 5 pattern src/",
			"grep -n foo file.ts",
			"sed -n '1,80p' file.ts",
			"head -n 40 file.md",
			"tail -n 50 log.txt",
			"ls -la /tmp",
			"wc -l file",
			"stat -f '%Sm' file",
			"file /bin/ls",
			"sort file | uniq -c",
			"cut -d: -f1 file",
			"diff a.ts b.ts",
			"jq '.x' data.json",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
	});
	test("read-only git, including global flags before the subcommand", () => {
		for (const cmd of [
			"git log --oneline -n 20",
			"git show HEAD -- src/index.ts",
			"git diff --stat",
			"git status --short",
			"git blame src/index.ts",
			"git rev-parse HEAD",
			"git rev-list --count HEAD",
			"git ls-files",
			"git cat-file -p HEAD:src/index.ts",
			"git -C /tmp/repo log --oneline -n 5",
			"git -c core.pager=cat log -n 1",
			"git log --format='%s' -n 5",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
	});
	test("read-only tmux", () => {
		for (const cmd of [
			"tmux -L pi-sub ls",
			"tmux -L pi-sub capture-pane -t s -p | tail -30",
			"tmux -L pi-sub has-session -t s",
			"tmux -L pi-sub display-message -p '#{pane_title}'",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
	});
	test("quote-aware splitting: pipes inside a quoted pattern stay one segment", () => {
		expect(ok("rg 'a|b' src/")).toBe(true);
		expect(ok('rg "sendUserMessage|agent_settled" src/')).toBe(true);
		expect(ok("rg -n 'a && b' src/")).toBe(true);
	});
	test("pipes and sequencing across allowed commands", () => {
		expect(ok("rg -l foo src/ | head -n 5")).toBe(true);
		expect(ok("git diff --stat; git status --short")).toBe(true);
	});
	test("date/hostname print, but lose the day they are given something to set", () => {
		for (const cmd of [
			"date",
			"date +%s",
			"date -u",
			"date '+%Y-%m-%d'",
			"date -r /etc/hosts",
			"date -v-1d +%Y",
			"hostname",
			"hostname -s",
			"hostname -f",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
		for (const cmd of [
			"date 0101120099", // a bare operand is BSD's set-the-clock form
			"date -s '2020-01-01'",
			"hostname evil.example",
			"hostname -F /tmp/h",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("plain shell builtins and pipelines", () => {
		// Real advisor commands: the extra `echo`/`cd` segments were the bulk of the false positives
		for (const cmd of [
			"cd /Users/x/Projects/pi-watchdog && git status --short | head -n 20",
			'grep -rn x src/ --include="*.ts" -l; echo "exit=$?"',
			"grep -n a f.ts | head; echo ---; grep -n b f.ts | head",
			"true",
			"pwd",
			"uname -s",
			"which bun",
			"test -f /etc/hosts",
			"rg -l foo src/ | xargs wc -l",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
	});
	test("find/tree are readers only without their exec/write flags", () => {
		expect(ok("find /x/packages -name '*bash*' -not -path '*node_modules*' | head")).toBe(true);
		expect(ok("tree -L 2 src")).toBe(true);
		for (const cmd of [
			"find . -name '*.ts' -exec rm {} ;",
			"find . -name '*.ts' -delete",
			"find . -name '*.ts' -fls /tmp/out",
			"tree -o /tmp/out.txt",
			"sort -o /tmp/out.txt in.txt",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("command substitution is judged as its own command, and no longer breaks the outer parse", () => {
		// The substitution's `|` used to split the outer command, leaving `p" f` as an unknown segment
		expect(ok('sed -n "$(grep -n x f.ts | cut -d: -f1)p" f.ts')).toBe(true);
		expect(ok('ls -dt /tmp/x | head -5; echo "count: $(ls -d /tmp/x | wc -l)"')).toBe(true);
		// ...but it stays a real check: the substitution runs code like any other command
		expect(ok('sed -n "$(pnpm test)" f.ts')).toBe(false);
		expect(ok("grep x `rm -rf /tmp/x`")).toBe(false);
	});
	test("xargs is judged by the command it runs, not waved through", () => {
		expect(ok("rg -l foo src/ | xargs wc -l")).toBe(true);
		expect(ok("rg -l foo src/ | xargs -0 wc -l")).toBe(true);
		expect(ok("rg -l foo src/ | xargs -n1 wc -l")).toBe(true);
		expect(ok("rg -l foo src/ | xargs -I{} wc -l {}")).toBe(true);
		expect(ok("printf '' | xargs -r wc")).toBe(true);
		for (const cmd of [
			"find . -type f -print0 | xargs -0 rm",
			"rg -l foo src/ | xargs pnpm test",
			"rg -l foo src/ | xargs -a list.txt rm",
			"rg -l foo src/ | xargs -alist.txt wc",
			"rg -l foo src/ | xargs",
			// an xargs flag this code has not seen changes what xargs runs; fail closed on it
			"rg -l foo src/ | xargs --some-future-flag wc",
			"rg -l foo src/ | xargs -0foo wc",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("shell control flow is refused by name, not by accident", () => {
		// The body of `for f in x; do <body>; done` is split off before it is judged, so the construct
		// is refused as a whole; if this ever starts passing because `do` got allowlisted, loop bodies
		// would run unjudged.
		for (const cmd of ["for f in a b; do echo $f; done", "while true; do ls; done", "if [ -f x ]; then ls; fi"]) {
			expect(ok(cmd), cmd).toBe(false);
			expect(reason(cmd), cmd).toContain("control flow");
		}
	});
	test("read-only git subcommands that used to be blocked", () => {
		for (const cmd of [
			"git tag --contains 0cf4828 | head -5",
			"git reflog show advisor-mode | head -20",
			"git merge-base HEAD MERGE_HEAD",
			"git worktree list",
			"git show-ref --heads",
			"git for-each-ref --format='%(refname)' refs/heads",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
		expect(ok("git worktree add /tmp/wt")).toBe(false);
	});
	test("git -p starts a pager, so it stays denied in the global position only", () => {
		expect(ok("git -p log")).toBe(false);
		expect(ok("git --paginate log")).toBe(false);
		// `-p` after the subcommand is that subcommand's own flag (cat-file -p = pretty print)
		expect(ok("git cat-file -p HEAD:src/index.ts")).toBe(true);
	});
	test("empty command is a no-op, not a denial", () => {
		expect(ok("")).toBe(true);
		expect(ok("   ")).toBe(true);
	});
	test("cleanup verbs stay denied even though the fence now allows their read-only neighbours", () => {
		for (const cmd of ["cat f", "tee out", "kill 1", "pnpm test"]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
});

describe("judgeReadOnlyCommand: denied", () => {
	test("write redirects, including a redirect that only looks like silencing", () => {
		for (const cmd of [
			"echo hi > /tmp/x",
			"git log >> out.txt",
			"sed -n '1,5p' f > /tmp/y",
			// the shapes people reach for when they mean "hush": a real target is still a write
			"rg foo src/ 2> /tmp/err",
			"rg foo src/ 2>&1 > /tmp/x",
			// `<>` opens for read+write and creates the file; process substitution runs a command
			"sed -n '1p' <>/tmp/x",
			"sed -n '1p' <(pnpm test)",
			"sed -n '1p' >(pnpm test)",
			"ls >&out.txt",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
		// every denial names the rewrite — one of them does not use the word "redirect"
		expect(reason("ls >&out.txt")).toContain("2>&1");
		expect(reason("sed -n '1p' <>/tmp/x")).toContain("writing");
		expect(ok("cat >> /tmp/x <<'EOF'")).toBe(false);
		expect(ok("cat <<'EOF'")).toBe(false); // a bare here-doc is denied by the command rule, not the redirect one
	});
	test("discarding a stream or merging it into stdout is not a write", () => {
		// Each of these is the reflex form in a read-only one-liner; blocking them costs a turn and writes nothing.
		for (const cmd of [
			"ls /nope 2>/dev/null",
			"rg -n x . 2>/dev/null | head -5",
			"rg -c foo src/ 2>&1 | head -3",
			"ls src/ > /dev/null",
			// a numeric target is descriptor duplication, not a file: `2>&2` is a no-op, `2>&1` merges
			"rg foo src/ 2>&2",
			"bun /x/main.ts recall f k 2>/dev/null",
			"sed -n '1p' /etc/hosts 2>/dev/null; echo ---",
		]) {
			expect(ok(cmd), cmd).toBe(true);
		}
		// `2>&1` inside a substitution must be allowed too, or a whole class of one-liners dies on it
		expect(ok('echo "count: $(ls -d /tmp/pi-sub-* 2>/dev/null | wc -l)"')).toBe(true);
	});
	test("reading stdin is not a write redirect", () => {
		expect(ok("jq '.x' < data.json")).toBe(true);
	});
	test("never-allowed verbs", () => {
		for (const cmd of [
			"pnpm test",
			"pnpm typecheck",
			"npm install",
			"curl https://x",
			"rm -rf /tmp/x",
			"cat file",
			"tee out",
			"python3 -c 'print(1)'",
			"node -e 'x()'",
			"chmod +x f",
			"kill 1234",
			"awk '{print $1}' f",
			"sudo ls",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("git that mutates", () => {
		for (const cmd of [
			"git checkout main",
			"git commit -m x",
			"git reset --hard",
			"git clean -fd",
			"git push",
			"git fetch",
			"git add .",
			"git stash",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("tmux that mutates or kills", () => {
		for (const cmd of [
			"tmux -L pi-sub kill-server",
			"tmux -L pi-sub kill-session -t s",
			"tmux -L pi-sub send-keys -t s ls Enter",
			"tmux -L pi-sub set-hook -t s pane-died x",
		]) {
			expect(ok(cmd), cmd).toBe(false);
		}
	});
	test("sed -i edits in place", () => {
		expect(ok("sed -i '' 's/a/b/' file")).toBe(false);
		expect(reason("sed -i '' 's/a/b/' file")).toContain("sed -i");
	});
	test("rg --pre runs another program, so it is denied", () => {
		for (const cmd of ["rg --pre 'sh -c x' foo .", "rg --pre=./hook foo .", "rg --hostname-bin cmd foo ."]) {
			expect(ok(cmd), cmd).toBe(false);
		}
		expect(ok("rg --pretty -n foo src/")).toBe(true);
		// a pattern that merely looks like the flag is not the flag
		expect(ok("rg -n -- '--pre' src/")).toBe(false); // still a token; documented conservative choice
	});
	test("long-running follow flags are denied", () => {
		for (const cmd of ["tail -f log.txt", "tail -F log.txt", "ls -R src"]) {
			expect(ok(cmd), cmd).toBe(false);
		}
		expect(ok("tail -n 50 log.txt")).toBe(true);
		expect(ok("ls -la src")).toBe(true);
	});
	test("timeout is unwrapped, its inner command is judged", () => {
		expect(ok("timeout 5 rg -l foo src/")).toBe(true);
		expect(ok("timeout -s KILL 5 sed -n '1,5p' file")).toBe(true);
		expect(ok("timeout 5 pnpm test")).toBe(false);
		expect(ok("timeout")).toBe(false);
	});
	test("flags that reach another program or write are denied", () => {
		expect(ok("git --exec-path=/tmp/evil log")).toBe(false);
		expect(ok("git --upload-pack=sh log")).toBe(false);
		expect(ok("jq --in-place '.x=1' data.json")).toBe(false);
	});
	test("bare bun REPL and bun -e are denied", () => {
		expect(ok("bun")).toBe(false);
		expect(reason("bun")).toContain("REPL");
		expect(ok("bun -e 'console.log(1)'")).toBe(false);
		expect(ok("bun --eval 'x' ")).toBe(false);
		expect(ok("bun /x/main.ts recall f k")).toBe(true);
	});
	test("unknown commands and unbalanced quotes fail closed", () => {
		expect(ok("frobnicate --all")).toBe(false);
		expect(ok("rg 'unclosed src/")).toBe(false);
	});
	test("a denied segment poisons the whole line", () => {
		expect(ok("rg -l foo src/ && pnpm test")).toBe(false);
		expect(ok("git status; rm -rf build")).toBe(false);
	});
	test("reason names the way out", () => {
		expect(reason("pnpm test")).toContain("read-only");
		expect(reason("cat file")).toContain("read tool");
	});
});

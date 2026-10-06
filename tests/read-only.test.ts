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
	test("empty command is a no-op, not a denial", () => {
		expect(ok("")).toBe(true);
		expect(ok("   ")).toBe(true);
	});
});

describe("judgeReadOnlyCommand: denied", () => {
	test("write redirects, including fd merge and here-doc", () => {
		for (const cmd of [
			"echo hi > /tmp/x",
			"git log >> out.txt",
			"rg foo src/ 2>&1",
			"cat >> /tmp/x <<'EOF'",
			"sed -n '1,5p' f > /tmp/y",
		]) {
			expect(ok(cmd), cmd).toBe(false);
			expect(reason(cmd), cmd).toContain("redirect");
		}
		expect(ok("cat <<'EOF'")).toBe(false); // a bare here-doc is denied by the command rule, not the redirect one
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

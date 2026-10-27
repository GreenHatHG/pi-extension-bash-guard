import { describe, expect, test } from "vitest";
import {
	detectBlockedScan,
	extractForWordLists,
	maskHeredocBodies,
	splitCommandSubstitutions,
	stripRedirections,
	tokenizeSegment,
} from "../src/scan-guard";
import { isSearchCommand } from "../src/timeout-guard";

const HOME = "/Users/tester";
const opts = { home: HOME };
/** The `${HOME}` literal (built by joining so lint doesn't misread it). */
const BRACED_HOME = "$" + "{HOME}";

/** A `tool root kind` summary of the hit, easy to assert on. */
function hit(command: string): string | null {
	const result = detectBlockedScan(command, opts);
	return result ? `${result.tool} ${result.root} ${result.kind}` : null;
}

describe("tokenizeSegment", () => {
	test("Split on whitespace, keep quoted content with spaces", () => {
		expect(tokenizeSegment('find "/Users/tester/My Dir" -name x')).toEqual([
			"find",
			"/Users/tester/My Dir",
			"-name",
			"x",
		]);
	});

	test("Single quotes keep their content literal", () => {
		expect(tokenizeSegment("rg '$HOME' -g '*.ts'")).toEqual(["rg", "$HOME", "-g", "*.ts"]);
	});
});

describe("splitCommandSubstitutions", () => {
	test("pulls `$(...)` out and leaves a marker that cannot be split on", () => {
		const { text, nested } = splitCommandSubstitutions('sed -n "$(grep -n x f.ts | cut -d: -f1)p" f.ts');
		expect(nested).toEqual(["grep -n x f.ts | cut -d: -f1"]);
		expect(text).not.toContain("|");
		expect(text).toContain('p" f.ts'); // the tail of the outer command survives intact
	});
	test("backticks are pulled out too, including inside double quotes", () => {
		expect(splitCommandSubstitutions("grep x `ls /tmp`").nested).toEqual(["ls /tmp"]);
		expect(splitCommandSubstitutions('echo "n: `ls | wc -l`"').nested).toEqual(["ls | wc -l"]);
	});
	test("a substitution inside single quotes is literal text, not code", () => {
		expect(splitCommandSubstitutions("rg '$(rm -rf /)' src/").nested).toEqual([]);
	});
});

describe("detectBlockedScan — `for ... in <list>` word lists", () => {
	test("the substitution inside a for-list is scanned", () => {
		expect(hit("for f in $(grep -rl x ~); do echo $f; done")).toBe("grep ~ home");
		expect(hit("for f in $(rg -l x /); do echo $f; done")).toBe("rg / root");
	});
	test("a literal word list is not a scan", () => {
		expect(extractForWordLists("for f in a b c; do echo $f; done")).toEqual(["a b c"]);
		expect(hit("for f in a b c; do echo $f; done")).toBeNull();
	});
});

describe("detectBlockedScan — blocks the filesystem root /", () => {
	test("find /", () => {
		expect(hit("find / -name x")).toBe("find / root");
	});

	test("sudo find /", () => {
		expect(hit("sudo find / -name x")).toBe("find / root");
	});

	test("Absolute-path call /usr/bin/find", () => {
		expect(hit("/usr/bin/find / -name x")).toBe("find / root");
	});

	test("find with / among several starting points", () => {
		expect(hit("find /tmp / -name x")).toBe("find / root");
	});

	test("grep -r /", () => {
		expect(hit("grep -r foo /")).toBe("grep / root");
	});

	test("grep with combined short flags -rnI", () => {
		expect(hit('grep -rnI "pat" /')).toBe("grep / root");
	});

	test("rg /", () => {
		expect(hit("rg foo /")).toBe("rg / root");
	});

	test("Leading FOO=bar assignment prefix", () => {
		expect(hit("FOO=bar rg pattern /")).toBe("rg / root");
	});

	test("env wrapper", () => {
		expect(hit("env rg pattern /")).toBe("rg / root");
	});

	test("Each pipe segment is checked on its own", () => {
		expect(hit("ls / | xargs grep -r foo /")).toBe("grep / root");
	});

	test("With redirection and 2>&1", () => {
		expect(hit("rg foo / 2>&1 | head")).toBe("rg / root");
		// Descriptor duplication is not a separator, with or without spaces around the pipe.
		expect(hit("rg foo / 2>&1|head")).toBe("rg / root");
		expect(hit("rg foo / 1>&2 | head")).toBe("rg / root");
	});

	test("rg inside command substitution can't dodge the root block", () => {
		expect(hit('echo "$(rg foo /)"')).toBe("rg / root");
		expect(hit("echo `rg foo /`")).toBe("rg / root");
	});
});

describe("detectBlockedScan — blocks the whole home", () => {
	test("rg ~", () => {
		expect(hit("rg foo ~")).toBe("rg ~ home");
	});

	test("find ~", () => {
		expect(hit("find ~ -maxdepth 2")).toBe("find ~ home");
	});

	test('find "$HOME"', () => {
		expect(hit('find "$HOME" -name x')).toBe("find $HOME home");
	});

	test("grep -r $HOME", () => {
		expect(hit("grep -r foo $HOME")).toBe("grep $HOME home");
	});

	test('Escaped pipe inside quotes doesn\'t split the segment: grep -rl "a\\|b" ~', () => {
		expect(hit('grep -rl "a\\|b" ~')).toBe("grep ~ home");
	});

	test(`rg ${BRACED_HOME}`, () => {
		expect(hit(`rg --hidden pattern ${BRACED_HOME}`)).toBe(`rg ${BRACED_HOME} home`);
	});

	test("Literal home path", () => {
		expect(hit(`rg foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("find -L with a leading flag still finds home", () => {
		expect(hit("find -L ~ -name x")).toBe("find ~ home");
	});
});

describe("detectBlockedScan — blocks system dirs", () => {
	test.each([
		["rg foo /etc", "rg /etc system"],
		["find /etc -name x", "find /etc system"],
		["grep -r foo /var", "grep /var system"],
		["rg foo /usr", "rg /usr system"],
		["rg foo /System", "rg /System system"],
		["rg foo /Library", "rg /Library system"],
		["find /opt -maxdepth 2", "find /opt system"],
	])("blocks: %s", (command, expected) => {
		expect(hit(command)).toBe(expected);
	});

	test.each([
		"rg foo /etc/nginx", // subdir passes
		"find /etc/nginx -name x",
		"rg foo /opt/homebrew", // /opt subdir passes
		"rg foo ~/Library", // a specific home subdir passes (the 5-minute cap still backs it up)
		"rg foo /tmp",
	])("passes: %s", (command) => {
		expect(hit(command)).toBeNull();
	});
});

describe("detectBlockedScan — flag values and quotes", () => {
	test("du/tree flag values aren't mistaken for a root", () => {
		expect(hit("du --exclude /etc ~/Projects")).toBeNull();
		expect(hit("tree -I /usr .")).toBeNull();
	});

	test("A quoted > isn't treated as redirection", () => {
		expect(stripRedirections('rg "a>b" /')).toBe('rg "a>b" /');
		expect(hit('rg "a>b" /')).toBe("rg / root");
	});
});

describe("detectBlockedScan — passes narrowed or unrelated commands", () => {
	test.each([
		"rg foo",
		"rg foo ~/Projects",
		"find ~/Projects -name x",
		`rg foo ${HOME}/Projects`,
		"cd / && rg foo .",
		"find /tmp -maxdepth 1",
		"find . -name x",
		"grep -r foo ./src",
		"grep foo /", // single-file grep can't walk a tree — capped, but never blocked
		"grep foo $HOME", // same: explicit files only, no scan
		"rg foo /tmp",
		"rg -e foo -e bar ./src",
		'echo "a;b"',
		"git log --oneline -n 20",
	])("passes: %s", (command) => {
		expect(hit(command)).toBeNull();
	});
});

describe("detectBlockedScan — message text", () => {
	test("reason has the block header and narrowing hints", () => {
		const result = detectBlockedScan("rg foo /", opts);
		expect(result?.reason).toContain("[BASH SCAN GUARD]");
		expect(result?.reason).toContain("mdfind");
		expect(result?.reason).toContain("project-dir");
	});

	test("home message gives the narrowed whole-~ form", () => {
		const result = detectBlockedScan("rg foo ~", opts);
		expect(result?.reason).toContain("!Library/**");
	});

	test("system message names the dir and suggests find -maxdepth", () => {
		const result = detectBlockedScan("rg foo /etc", opts);
		expect(result?.reason).toContain("/etc");
		expect(result?.reason).toContain("-maxdepth 2");
	});

	test("names a way to locate an executable without walking the tree", () => {
		// 24 of 51 real blocks were `find / -name <binary>` / `find ~ -name '*pkg*'`.
		const result = detectBlockedScan("find / -maxdepth 6 -name tsc -type f 2>/dev/null | head", opts);
		expect(result?.reason).toContain("command -v");
		expect(result?.reason).toContain("npm ls -g");
	});
});

describe("detectBlockedScan — real-incident regression", () => {
	test("A grep -rl + find combo scanning the whole home is caught by the first segment", () => {
		const incident =
			`grep -rl "foldInquiryContext" ${HOME} 2>/dev/null | head -20; ` +
			`echo "---"; find ${HOME} -maxdepth 6 -type d -name "pi-extension-utils" 2>/dev/null | head`;
		const result = detectBlockedScan(incident, opts);
		expect(result?.tool).toBe("grep");
		expect(result?.kind).toBe("home");
	});
});

describe("heredoc bodies are data, not commands", () => {
	// Real incident, twice in one session: a commit message that quoted `find / -name tsc` was blocked
	// as a filesystem scan, because the body was parsed as if the shell would run it.
	test("prose inside a quoted heredoc is not a scan", () => {
		const commit = `git commit -F - <<'EOF'\nfix: say the thing\n\nThe blocks were \`find / -name tsc\` lookups.\nEOF`;
		expect(hit(commit)).toBeNull();
	});

	test("a body line that looks like a scan is not a scan", () => {
		expect(hit("cat > /tmp/notes.md <<'EOF'\nfind / -name tsc\nEOF")).toBeNull();
	});

	test("a real scan after the heredoc still blocks", () => {
		// 46 archived commands were capped (or blocked) only because of heredoc text.
		expect(hit(`cat > /tmp/a.txt <<'EOF'\nnotes\nEOF\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("a body fed to a shell is still judged (it is a script)", () => {
		for (const command of [
			"bash <<'EOF'\nfind / -name x\nEOF",
			"ssh host <<EOF\nfind / -name x\nEOF",
			"{ bash; } <<'EOF'\nfind / -name x\nEOF",
			"! bash <<'EOF'\nfind / -name x\nEOF",
			"then bash <<'EOF'\nfind / -name x\nEOF",
			"(bash <<'EOF'\nfind / -name x\nEOF\n)",
			"sudo -u root bash <<'EOF'\nfind / -name x\nEOF",
			// Long / clustered runner flags: eating the next token would hide `bash`.
			"sudo --user root bash <<'EOF'\nfind / -name x\nEOF",
			"sudo -Eu root bash <<'EOF'\nfind / -name x\nEOF",
			"sudo -E bash <<'EOF'\nfind / -name x\nEOF",
			"env -i bash <<'EOF'\nfind / -name x\nEOF",
			"env --unset NOPE bash <<'EOF'\nfind / -name x\nEOF",
			// A runner in front of the shell is still a shell.
			"timeout 30 bash <<'EOF'\nfind / -name x\nEOF",
			"timeout --signal KILL 5 bash <<'EOF'\nfind / -name x\nEOF",
			"setsid bash <<'EOF'\nfind / -name x\nEOF",
			"su - login <<'EOF'\nfind / -name x\nEOF",
			"$SHELL <<'EOF'\nfind / -name x\nEOF",
			"eval bash <<'EOF'\nfind / -name x\nEOF",
			"f() { bash; } <<'EOF'\nfind / -name x\nEOF",
			// A `\\`-continued opening line puts the shell on the first physical line.
			"bash \\\n<<'EOF'\nfind / -name x\nEOF",
			// Redirect first, program after the delimiter.
			"<<'EOF' bash\nfind / -name x\nEOF",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("a body piped into a shell is still judged", () => {
		// `cat <<EOF | bash` hands the body to bash as stdin: it runs.
		for (const command of [
			"cat <<'EOF' | bash\nfind / -name x\nEOF",
			"cat <<'EOF' |bash\nfind / -name x\nEOF",
			"cat<<'EOF'|bash\nfind / -name x\nEOF",
			"true &&bash <<'EOF'\nfind / -name x\nEOF",
			"true ;bash <<'EOF'\nfind / -name x\nEOF",
			"cat <<'EOF' | sudo sh\nfind / -name x\nEOF",
			"cat <<'EOF' | (bash)\nfind / -name x\nEOF",
			"cat <<'EOF' | timeout 30 bash\nfind / -name x\nEOF",
			"cat <<'EOF' |& bash\nfind / -name x\nEOF",
			"cat <<'EOF' | $BASH\nfind / -name x\nEOF",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("other shell names and the fd-0 redirect are not blind spots", () => {
		for (const command of [
			"rzsh <<'EOF'\nfind / -name x\nEOF",
			"mksh <<'EOF'\nfind / -name x\nEOF",
			"yash <<'EOF'\nfind / -name x\nEOF",
			"posh <<'EOF'\nfind / -name x\nEOF",
			"$BASH <<'EOF'\nfind / -name x\nEOF",
			// Braced variables: stripping the `}` before comparing used to lose these.
			"$" + "{BASH} <<'EOF'\nfind / -name x\nEOF",
			"$" + "{SHELL} <<'EOF'\nfind / -name x\nEOF",
			// `$'bash'` normalises to `$bash`.
			"$'bash' <<'EOF'\nfind / -name x\nEOF",
			"source /dev/stdin <<'EOF'\nfind / -name x\nEOF",
			// POSIX `.` is `source`.
			". /dev/stdin <<'EOF'\nfind / -name x\nEOF",
			"cat <<'EOF' | . /dev/stdin\nfind / -name x\nEOF",
			// `0<<'EOF'` feeds descriptor 0, which a later command can read.
			"exec 0<<'EOF'\nfind / -name x\nEOF",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("a newline inside a quoted argument keeps the opening line open", () => {
		// bash keeps reading, so the line after the in-quote newline is still this command.
		expect(hit(`cat <<'EOF' "multi\nline"\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("a substitution spanning a newline keeps the opening line open", () => {
		// `$( … )` and backticks run across newlines, so what follows is still command text.
		expect(hit(`cat <<'EOF' $(echo a\nfind / -name x)\nBODY\nEOF`)).toBe("find / root");
		expect(hit(`cat <<'EOF' \`echo a\nfind / -name x\`\nBODY\nEOF`)).toBe("find / root");
	});

	test("a shell that consumes the body from after it is still judged", () => {
		// The consumer can be named after the body: braces, a subshell, a function, or a process substitution.
		for (const command of [
			"{ cat <<'EOF'\nfind / -name x\nEOF\n} | bash",
			"( cat <<'EOF'\nfind / -name x\nEOF\n) | bash",
			"f() { cat <<'EOF'\nfind / -name x\nEOF\n; } ; f | bash",
			"cat <<'EOF' | tee >(bash)\nfind / -name x\nEOF",
			"cat <<'EOF' > >(bash)\nfind / -name x\nEOF",
			// Blank, comment and continuation lines between the body and the consumer still belong to it.
			"{\ncat <<'EOF'\nfind / -name x\nEOF\n\n} | bash",
			"{\ncat <<'EOF'\nfind / -name x\nEOF\n# feed it\n} | bash",
			"{\ncat <<'EOF'\nfind / -name x\nEOF\n} \\\n| bash",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("sudo's own shell flags mean the body is a root script", () => {
		for (const command of [
			"sudo -s <<'EOF'\nfind / -name x\nEOF",
			"sudo -i <<'EOF'\nfind / -name x\nEOF",
			"sudo --shell <<'EOF'\nfind / -name x\nEOF",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("an unquoted body keeps what really runs, even inside quote characters", () => {
		// In a heredoc body, `'…'` is literal bytes: bash still expands `$(...)` inside it, so a
		// quote-aware scan of the body would drop a command that really runs.
		for (const command of [
			"cat <<EOF\nx\n'$(find / -name tsc)'\nEOF",
			'cat <<EOF\nx\n"$(find / -name tsc)"\nEOF',
			"git commit -F - <<EOF\ndocs: don't run $(find / -name tsc) here\nEOF",
			"cat <<EOF\nrun `find / -name tsc`\nEOF",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("an escaped expansion in a body is literal, and a quoted delimiter expands nothing", () => {
		expect(hit("cat <<EOF\ncost \\$(find / -name tsc)\nEOF")).toBeNull();
		expect(hit("cat <<'EOF'\nExample: $(find / -name tsc)\nEOF")).toBeNull();
	});

	test("a descriptor heredoc keeps its body judged but is skipped as a body", () => {
		// `2<<EOF` is a descriptor redirect, so the prose inside it is data… but a later `<<X` in that
		// prose must not pair with an `X` line and swallow a real command.
		expect(hit("cat 2<<EOF\nexample: cat <<X\nEOF\nfind / -name tsc\nX")).toBe("find / root");
		expect(hit("exec 0<<'EOF'\nfind / -name tsc\nEOF")).toBe("find / root");
	});

	test("multiple heredocs on one line: the last body is the one that runs", () => {
		// `bash <<A <<B` feeds only B to bash, so B's body must be judged, not masked away.
		for (const command of [
			"bash <<'A' <<'B'\nprose\nA\nfind / -name x\nB",
			"bash <<'A' <<'B' <<'C'\nx\nA\ny\nB\nfind / -name x\nC",
			"sudo bash <<'A' <<'B'\nprose\nA\nfind / -name x\nB",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("a group's consumer is found past an intervening command line", () => {
		for (const command of [
			"{ cat <<'EOF'\nfind / -name x\nEOF\necho \"extra\"\n} | bash",
			"( cat <<'EOF'\nfind / -name x\nEOF\ntrue\n) | bash",
			"{ cat <<'EOF'\nfind / -name x\nEOF\ntrue\n} | env bash",
		]) {
			expect(hit(command), command).toBe("find / root");
		}
	});

	test("an apostrophe in a comment does not open a quote", () => {
		// Pre-existing leak: `# don't` swallowed every later command in the outer parse.
		expect(hit("echo hi # don't\nfind / -name x")).toBe("find / root");
	});

	test("blank and comment lines between a pipe and its filter keep the pipe", () => {
		// Real pipeline in bash: the producer's output still reaches the filter.
		expect(isSearchCommand("printf 'x' |\n# why\n\ngrep x")).toBe(false);
		expect(isSearchCommand("cat log.txt |\n\n# why\n\ngrep -n error")).toBe(false);
		// The producer is a search itself, so that one still gets the cap.
		expect(isSearchCommand("rg foo src |\n\nhead")).toBe(true);
	});

	test("a data heredoc keeps its mask when the next line is an ordinary command", () => {
		expect(hit(`git commit -F - <<'EOF'\nmessage\nEOF\nnpm test`)).toBeNull();
		expect(maskHeredocBodies(`git commit -F - <<'EOF'\nmessage\nEOF\nnpm test`)).not.toContain("message");
	});

	test("a shell word before an in-quote newline is still seen", () => {
		// `bash -s` reads the heredoc as its script; the header must include the line the word is on.
		expect(hit("bash -s 'a\nb' <<'EOF'\nfind / -name x\nEOF")).toBe("find / root");
	});

	test("a length expansion in the header is not a comment", () => {
		// The `#` of `${#x}` used to start a "comment", so the `${` counter never closed and every
		// later heredoc was ignored — including the one whose body is real command text.
		expect(hit(`x=abc\necho ${"$"}{#x} <<'EOF'\n{"a": 1}\nEOF\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("a `\\`-continued opening line does not become part of the body", () => {
		// Real bash starts the body after the *logical* line, so the continuation line is command text.
		expect(hit(`cat <<'EOF' \\\n&& rg -rn foo ${HOME}\nBODY\nEOF`)).toBe(`rg ${HOME} home`);
	});

	test("prose in one body cannot leak quote state into the next heredoc", () => {
		// An ordinary apostrophe in the first body used to hide the second body's operator, so the second
		// body was parsed and hard-blocked.
		const command =
			"cat > /tmp/a.md <<'EOF'\nIt's a note.\nEOF\ncat > /tmp/b.md <<'EOF'\nThe old command was `find / -name tsc`.\nEOF";
		expect(hit(command)).toBeNull();
		expect(maskHeredocBodies(command)).not.toContain("find");
	});

	test("an unquoted delimiter still expands, so its substitutions still run", () => {
		expect(hit(`cat <<EOF\n$(rg -rn foo ${HOME})\nEOF`)).toBe(`rg ${HOME} home`);
	});

	test("a herestring is not a heredoc (its operand is a word)", () => {
		expect(maskHeredocBodies('echo <<< "hi"')).toBe('echo <<< "hi"');
	});

	test("<<- strips leading tabs, and bodies are matched one after another", () => {
		const command = "cat <<-A <<'B'\n\tfind / -name a\n\tA\nbody-b\nB\necho done";
		expect(maskHeredocBodies(command)).not.toContain("find");
		expect(maskHeredocBodies(command)).toContain("echo done");
	});

	test("an unclosed heredoc is left alone, so nothing after it is hidden", () => {
		// bash fails such a script with "unexpected EOF"; guessing a body would swallow every command after it.
		const unclosed = "cat <<EOF\nno closing word\n";
		expect(maskHeredocBodies(unclosed)).toBe(unclosed);
		expect(hit(`cat <<EOF\nno closing word\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("a `<<` in a comment is not an operator", () => {
		// Real shape: a comment that documents a heredoc must not hide the next real command.
		expect(hit(`# example: cat <<EOF\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("a `<<` inside arithmetic or a parameter expansion is a shift, not a heredoc", () => {
		expect(hit(`echo $(( x << y ))\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
		expect(hit(`(( x << y ))\nrg -rn foo ${HOME}`)).toBe(`rg ${HOME} home`);
		expect(hit(`echo \${x:-foo <<A B}\nrg -rn foo ${HOME}\nA`)).toBe(`rg ${HOME} home`);
	});

	test("a `<<` in a quoted string is not an operator", () => {
		expect(maskHeredocBodies('echo "cat <<EOF"')).toBe('echo "cat <<EOF"');
	});
});

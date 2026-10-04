import { describe, expect, test } from "vitest";
import { detectBlockedScan, stripRedirections, tokenizeSegment } from "../src/scan-guard";

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
		"grep foo /",
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

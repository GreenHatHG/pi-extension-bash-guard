import { describe, expect, test } from "vitest";
import { detectBlockedScan, tokenizeSegment } from "../src/scan-guard";

const HOME = "/Users/tester";
const opts = { home: HOME };
/** `${HOME}` 字面量（拼接以避免 lint 误判）。 */
const BRACED_HOME = "$" + "{HOME}";

/** 命中的 `tool root kind` 摘要，便于断言。 */
function hit(command: string): string | null {
	const result = detectBlockedScan(command, opts);
	return result ? `${result.tool} ${result.root} ${result.kind}` : null;
}

describe("tokenizeSegment", () => {
	test("按空白分词，保留带空格的双引号内容", () => {
		expect(tokenizeSegment('find "/Users/tester/My Dir" -name x')).toEqual([
			"find",
			"/Users/tester/My Dir",
			"-name",
			"x",
		]);
	});

	test("单引号内保留字面量", () => {
		expect(tokenizeSegment("rg '$HOME' -g '*.ts'")).toEqual(["rg", "$HOME", "-g", "*.ts"]);
	});
});

describe("detectBlockedScan — 拦截文件系统根 /", () => {
	test("find /", () => {
		expect(hit("find / -name x")).toBe("find / root");
	});

	test("sudo find /", () => {
		expect(hit("sudo find / -name x")).toBe("find / root");
	});

	test("绝对路径调用 /usr/bin/find", () => {
		expect(hit("/usr/bin/find / -name x")).toBe("find / root");
	});

	test("find 多 starting point 中含 /", () => {
		expect(hit("find /tmp / -name x")).toBe("find / root");
	});

	test("grep -r /", () => {
		expect(hit("grep -r foo /")).toBe("grep / root");
	});

	test("grep 组合短选项 -rnI", () => {
		expect(hit('grep -rnI "pat" /')).toBe("grep / root");
	});

	test("rg /", () => {
		expect(hit("rg foo /")).toBe("rg / root");
	});

	test("段首 FOO=bar 赋值前缀", () => {
		expect(hit("FOO=bar rg pattern /")).toBe("rg / root");
	});

	test("env 包装器", () => {
		expect(hit("env rg pattern /")).toBe("rg / root");
	});

	test("管道后段单独判定", () => {
		expect(hit("ls / | xargs grep -r foo /")).toBe("grep / root");
	});

	test("带重定向与 2>&1", () => {
		expect(hit("rg foo / 2>&1 | head")).toBe("rg / root");
	});
});

describe("detectBlockedScan — 拦截整个 home", () => {
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

	test('引号内转义管道不切断段：grep -rl "a\\|b" ~', () => {
		expect(hit('grep -rl "a\\|b" ~')).toBe("grep ~ home");
	});

	test(`rg ${BRACED_HOME}`, () => {
		expect(hit(`rg --hidden pattern ${BRACED_HOME}`)).toBe(`rg ${BRACED_HOME} home`);
	});

	test("字面 home 路径", () => {
		expect(hit(`rg foo ${HOME}`)).toBe(`rg ${HOME} home`);
	});

	test("find -L 前置选项后仍能识别 home", () => {
		expect(hit("find -L ~ -name x")).toBe("find ~ home");
	});
});

describe("detectBlockedScan — 拦截系统目录", () => {
	test.each([
		["rg foo /etc", "rg /etc system"],
		["find /etc -name x", "find /etc system"],
		["grep -r foo /var", "grep /var system"],
		["rg foo /usr", "rg /usr system"],
		["rg foo /System", "rg /System system"],
		["rg foo /Library", "rg /Library system"],
		["find /opt -maxdepth 2", "find /opt system"],
	])("拦：%s", (command, expected) => {
		expect(hit(command)).toBe(expected);
	});

	test.each([
		"rg foo /etc/nginx", // 子目录放行
		"find /etc/nginx -name x",
		"rg foo /opt/homebrew", // /opt 的子目录放行
		"rg foo ~/Library", // home 的具体子目录放行（另有 5 分钟封顶兜底）
		"rg foo /tmp",
	])("放行：%s", (command) => {
		expect(hit(command)).toBeNull();
	});
});

describe("detectBlockedScan — 放行收窄/无关命令", () => {
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
	])("放行：%s", (command) => {
		expect(hit(command)).toBeNull();
	});
});

describe("detectBlockedScan — 提示文案", () => {
	test("reason 含拦截标题与收窄建议", () => {
		const result = detectBlockedScan("rg foo /", opts);
		expect(result?.reason).toContain("[BASH SCAN GUARD]");
		expect(result?.reason).toContain("mdfind");
		expect(result?.reason).toContain("project-dir");
	});

	test("home 提示给出全量 ~ 的收窄写法", () => {
		const result = detectBlockedScan("rg foo ~", opts);
		expect(result?.reason).toContain("!Library/**");
	});

	test("system 提示点名目录并给出 find -maxdepth 建议", () => {
		const result = detectBlockedScan("rg foo /etc", opts);
		expect(result?.reason).toContain("/etc");
		expect(result?.reason).toContain("-maxdepth 2");
	});
});

describe("detectBlockedScan — 真实事故回归", () => {
	test("扫描整个 home 的 grep -rl + find 组合被第一段拦截", () => {
		const incident =
			`grep -rl "foldInquiryContext" ${HOME} 2>/dev/null | head -20; ` +
			`echo "---"; find ${HOME} -maxdepth 6 -type d -name "pi-extension-utils" 2>/dev/null | head`;
		const result = detectBlockedScan(incident, opts);
		expect(result?.tool).toBe("grep");
		expect(result?.kind).toBe("home");
	});
});

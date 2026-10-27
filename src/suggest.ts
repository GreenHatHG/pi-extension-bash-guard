/**
 * Pure helper: suggest how to rewrite a command for bounded output.
 * Caps at 3 hints; falls back to a generic one when nothing matches.
 */

const MAX_SUGGESTIONS = 3;

interface Rule {
	test: (command: string) => boolean;
	hint: string;
}

const GENERIC_HINT =
	"Prefer counting/aggregating first (`| wc -l`, `-q`, `--quiet`, `-s`) and then drill down. " +
	"If you genuinely need the whole output, redirect it to a file (`> /tmp/out.txt`) and read/grep it selectively.";

const GIT_LOG_COMMAND =
	/(^|[\s|;&(])git(?:\s+(?:--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)|\s+-C\s+\S+|\s+-c\s+\S+|\s+--(?:config-env|exec-path|git-dir|namespace|super-prefix|work-tree)(?:=\S+|\s+\S+))*\s+log\b/;

/** Targets whose lines are enormous: session transcripts and minified bundle chunks. */
const LONG_LINE_TARGET = /\.jsonl\b|dist\/bundle|\/chunks\/|\.min\.js\b|sessions\//;

const RULES: Rule[] = [
	{
		// Long-line sources first: they are the measured failure mode. Of 105 real guarded commands, the 83
		// that already had `head`/`tail` ran ~1.6KB per line (36 of them over 2KB), and 19 targeted session
		// `.jsonl`, 13 minified `dist/bundle` chunks. A line cap cannot fit those under the byte limit.
		test: (c) => LONG_LINE_TARGET.test(c) && !/\|\s*(head\s+-c|cut\s+-c)/.test(c),
		hint:
			"That target is long-line (`.jsonl` / minified bundle): bound bytes, not lines — " +
			"`| cut -c1-200 | head -40` or `| head -c 3000`. `head -n 40` alone still returns several KB.",
	},
	{
		// cat / less / more / bat: dumps a whole big file
		test: (c) => /(^|[\s|;&(])(cat|less|more|bat)\s/.test(c) && !/\|\s*(head|tail|sed|awk|rg|grep|wc)\b/.test(c),
		hint:
			"Read files with the `read` tool and its offset/limit instead of dumping them; for a spot check use " +
			"`sed -n '1,80p' <file>` or `head -n 80 <file>`.",
	},
	{
		// recursive search + trailing grep -v dir filter: exclude before the walk, not after
		test: (c) => /(^|[\s|;&(])(grep\s+-[A-Za-z]*r|rg)\b/.test(c) && /\|\s*grep\s+-v\b/.test(c),
		hint:
			"Exclude before traversing, not after: `rg -g '!**/sessions/**' -g '!**/.git/**' <pattern> <dir>` " +
			"(or `grep --exclude-dir=.git --exclude-dir=node_modules -r`). A trailing `| grep -v dir` still reads every file.",
	},
	{
		// rg / grep with no cap flag. A line cap alone is not a byte cap: `grep ... | head -5` still returned
		// 2 lines / 30KB in real history, so only an explicit byte cap silences this hint.
		test: (c) =>
			/(^|[\s|;&(])(rg|grep)\b/.test(c) &&
			!/(^|\s)(-l|--files-with-matches|-c|--count|-m|--max-count)(\s|=|\b)/.test(c) &&
			!/\|\s*(head|tail)\s+(-c|--bytes)\b/.test(c) &&
			!/\|\s*(wc|sort|uniq)\b/.test(c),
		hint:
			"Cap the search: `rg -l <pattern>` lists matching files only, `-c` counts per file, " +
			"or `-m 5` / `--max-count=5` caps matches per file. `| head -N` caps lines, not bytes — one huge " +
			"line still blows the limit, so bound bytes with `| head -c 2000` when matches can be long.",
	},
	{
		// find with no narrowing
		test: (c) => /(^|[\s|;&(])find\s/.test(c) && !/(-maxdepth|--max-depth|-name\b|\|\s*head)/.test(c),
		hint: "Narrow `find`: add `-maxdepth 2`, a `-name '<glob>'` filter, or pipe it to `| head -n 50`.",
	},
	{
		// git log with no -n / --oneline
		test: (c) => GIT_LOG_COMMAND.test(c) && !/(-n\s*\d|--max-count|--oneline|\|\s*head)/.test(c),
		hint: "Use `git log --oneline -n 20` (or `--max-count=20`); add `--stat` only when you need changed files.",
	},
	{
		// git diff with no summary or path scope
		test: (c) => /(^|[\s|;&(])git\s+diff\b/.test(c) && !/(--stat|--name-only|--name-status|--\s)/.test(c),
		hint: "Use `git diff --stat` or `git diff --name-only` first, then scope with `git diff -- <path>`.",
	},
	{
		// recursive / unbounded directory listing
		test: (c) => /(^|[\s|;&(])(ls\s+-[a-z]*R|tree\b|du\s+-[a-z]*a)/.test(c),
		hint: "Cap listings: `tree -L 2`, `ls | head -n 50`, or `du -d 1 -h | sort -h | tail`.",
	},
	{
		// env / process / dependency dumps
		test: (c) =>
			/(^|[\s|;&(])(env|printenv|ps\s+aux|ps\s+-ef|npm\s+ls|pip\s+list|pip\s+freeze|brew\s+list)\b/.test(c) &&
			!/\|\s*(rg|grep|head|wc|sed|awk)\b/.test(c),
		hint: "Filter before dumping: `| rg <keyword>`, `| head -n 50`, or `| wc -l` to count first.",
	},
	{
		// log streams
		test: (c) => /(docker\s+logs|journalctl|tail\s+-f)/.test(c) && !/(--tail|-n\s*\d)/.test(c),
		hint: "Bound logs: `docker logs --tail 50 <container>`, `journalctl -n 50`, and add a time/keyword filter.",
	},
];

/** Return up to 3 rewrite hints for the command. */
export function suggestRewrites(command: string): string[] {
	const hints: string[] = [];
	for (const rule of RULES) {
		if (rule.test(command)) {
			hints.push(rule.hint);
			if (hints.length >= MAX_SUGGESTIONS) break;
		}
	}
	if (hints.length === 0) hints.push(GENERIC_HINT);
	return hints;
}

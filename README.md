# pi-extension-bash-guard

pi 插件：拦截 bash/powershell 的「大输出」，只回少量核心行 + 全文落盘路径 + **重写命令的提示**；
在**执行前**拦掉根目录为 `$HOME`、`/` 或系统目录（`/etc` 等）的无界扫描；并给搜索类命令
（`find`/`grep -r`/`rg`/`du`/`tree`）自动封顶 5 分钟超时；同时在会话开局注入一次输出纪律。
目标不是把输出截断，而是**逼模型把 shell 写对**。

## 行为

四件事，三硬一软：

1. **开局立规矩（软）**：会话第一次 agent run 时注入一条 `[BASH OUTPUT DISCIPLINE]`
   （`display: false`，只进模型上下文不进 TUI），告诉模型搜索/读文件/日志该怎么限量，
   以及被 guard 拦截后该怎么办。只注入一次，append-only，缓存安全。
2. **事前拦截无界扫描（硬）**：`tool_call` 阶段检测 `find`/`grep -r`/`rg`/`du`/`tree` 的扫描根目录；
   若为 `$HOME`（含 `~`、`$HOME`、`${HOME}`、字面 home 路径）、`/`、或精确的系统目录
   （`/etc`、`/var`、`/usr`、`/System`、`/Library`、`/Applications`、`/opt`、`/private`、`/bin`、`/sbin`、`/dev`、`/proc`），
   **直接 block** 并返回收窄建议（`rg -l <pattern> ~/Projects`、`mdfind -name '<name>'`，或加 `-g '!Library/**'`）。
   更深子目录（`/etc/nginx`、`~/Library/Preferences`）一律放行。动机：这类命令输出极小、现有字节 guard
   完全拦不住，却要遍历几十 GB（真实事故 934 秒）。
3. **搜索命令封顶 5 分钟（硬）**：`tool_call` 阶段，搜索类命令（`find`、递归 `grep`、`rg`、`du`、`tree`）
   若未给 `timeout`、或给了大于 300 秒的值，就把 `input.timeout` 原地改写为 **300**；模型给了更小的值
   则尊重（300 是上限，不是覆盖）。非搜索命令**完全不动**——`tail -f`/`watch`/前台 server 等长跑命令
   照旧运行。

   真实事故 `grep -rln ... ~/.pi ~/Projects ~/ensoai | grep -v ...` 因无 timeout 跑了 **5148 秒**；
   现在这类命令会被自动压到 5 分钟。
4. **超阈值硬拦截（硬）**：`tool_result` 阶段检查 bash/powershell 结果；超过阈值（默认
   **8KB 数据**）就把返回给模型的 content **替换**成：

```
[BASH OUTPUT GUARD] Output withheld: 1842 lines / 214.3KB (limit 8.0KB).

Preview — first 20 lines:
  <头 20 行，连续重复行折叠为 (×N)>
  ... [1795 lines omitted] ...
Preview — last 15 lines:
  <尾 15 行>

Error/warning lines:
  <自动抽取的报错/警告行，最多 15 条>

Full output saved to: /var/folders/.../pi-bash-guard-XXXX/output.txt
Read it selectively: the `read` tool with offset/limit, or `sed -n 'START,ENDp' <path>`, or `rg <pattern> <path>`.

Rewrite the command instead of repeating it. Do NOT re-run the same command, and do NOT just pipe it to
`less`/`more`. Suggestions:
  - Cap the search: `rg -l <pattern>` lists matching files only, `-c` counts per file, or `-m 5` / `--max-count=5` caps matches per file.
```

不做的事：**不预判输出大小**（不自动给命令加 `| head`，那会破坏重定向/管道语义），
也**不覆写安装的 `bash` 工具**（pi 内建已经做 2000 行/50KB 截断并落盘全文，本插件
在此基础上把阈值收紧并加「重写」指令）。命令级干预只有两处：上面第 2 条的
`$HOME`/`/`/系统目录扫描**事前 block**；以及第 3 条的**搜索命令封顶 5 分钟**（非搜索命令不碰）。

## 亮点

- **针对性建议**：按原命令特征给具体改写（`cat` → `read`/`sed`；无界 `rg` → `-l`/`-c`/`-m`；
  `git log` → `--oneline -n 20`；`find`/`ls -R`/`du -a`/`env`/`docker logs`……）。
- **错误不埋**：`isError` 时尾部预览加长，并先抽取 `Error`/`Traceback`/`npm ERR!` 等信号行顶到前面。
- **重复踩坑升级**：同一命令再次被拦截会提示「已拦截过」；本会话第 3 次起追加升级警告。
- **搜索有界、其余放手**：只给搜索类命令自动封顶 5 分钟，且尊重模型更小的显式预算；
  非搜索命令完全不碰，既不误伤长构建，也堵住「递归搜索跑几十分钟无人察觉」的洞。
- **全文可回查**：优先复用内建 bash 截断时落盘的**完整**输出；否则把当前文本写到本插件临时文件，
  会话结束自动清理。模型可 `read` + offset/limit 或对其 `rg`/`sed` 定向读取。
- **缓存安全**：只做 `tool_result` 的尾部 append-only 改写；不修改 systemPrompt、不动工具集、
  不注册 `context` 处理器。

## 安装

```bash
# 不安装、临时体验当前目录
pi -e .

# 或写进 settings 的本地包
pi install /Users/jooooody/Projects/pi-extension-bash-guard

# 或手动拷贝（单文件入口）
cp -r src ~/.pi/agent/extensions/bash-guard/
```

装完 `/reload` 热加载；`pi list` 查看已装包，`pi remove ...` 卸载。

## 配置

命令：

| 命令 | 效果 |
|---|---|
| `/bash-guard` | 开/关切换 |
| `/bash-guard on` / `off` | 显式开关 |
| `/bash-guard status` | 显示当前阈值、预览行数、扫描拦截开关、本会话拦截次数 |
| `/bash-guard scan on` / `off` | 单独开关「`$HOME`/`/`/系统目录的扫描事前拦截」 |
| `/bash-guard bytes 8192` | 改字节阈值（`0` = 不限字节） |
| `/bash-guard preview 25 15` | 改头/尾预览行数 |

配置通过 `pi.appendEntry` 持久化进会话，resume 时重放。

环境变量作为**新会话初值**（会话里有持久化配置时以持久化配置为准）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BASH_GUARD_DISABLED` | — | 设为非空非 0 值即默认关闭 |
| `PI_BASH_GUARD_ENABLED=0` | — | 默认关闭 |
| `PI_BASH_GUARD_SCAN_BLOCK=0` | — | 默认开启；设为 `0`/`false`/`off`/`no` 关闭扫描事前拦截 |
| `PI_BASH_GUARD_MAX_BYTES` | `8192` | 字节阈值，0 = 不限制字节 |
| `PI_BASH_GUARD_PREVIEW_HEAD` | `20` | 头部预览行数 |
| `PI_BASH_GUARD_PREVIEW_TAIL` | `15` | 尾部预览行数（成功时） |
| `PI_BASH_GUARD_ERROR_TAIL` | `25` | 尾部预览行数（失败时） |

状态栏：启用时显示 `🛡 bash-guard`，有拦截后显示 `🛡 bash-guard ×N`。

## 设计取舍

- **为什么用 `tool_result` 而不是 `tool_call`**：只有拿到输出才知道大不大；在 `tool_call`
  盲加 `| head` 会破坏重定向、改变退出码语义，还可能把错误截掉。
- **只限字节、不限行数**：上下文成本≈字节数（~4 字符/token），行数与 token 不直接相关；
  默认 8KB ≈ 2k token。行数多但每行短（如 2000 行 `a` ≈ 4KB）其实不贵，不应被拦。
- **为什么不覆写 `bash` 工具**：pi 内建已实现截断 + 全文落盘 + 会话环境注入 + 渲染器，
  覆写等于复制一份并长期跟随上游漂移；`tool_result` 的 content patch 足够。
- **为什么覆盖不到 `read`/`grep`/`find`**：这些内建工具本身就有结构化截断和
  offset/limit/head_limit 参数，v1 不重复处理。
- **为什么搜索命令注入 `timeout` 而不是 block**：`tool_call` 的 `input` 可变，直接把 `timeout`
  压到 300 秒即可生效，不必多一次「拦截→重发」往返；而且这是上限语义——模型给了更小预算就照用。
  代价是模型可能不知道被压过，但命中时 `[BASH TIMEOUT GUARD]` 的报错引导会兜底。
- **为什么其他命令全放开**：`tail -f`/`watch`/前台 server 的真实意图就是长跑，硬拦只会逼模型
  写 `timeout: 999999` 绕过；把约束只加在「搜索」这一唯一确定有界需求的类别上，摩擦最小。

## 开发

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm check:biome # lint + format 检查
```

目录：

```
src/index.ts          插件装配：事件、/bash-guard 命令、状态栏、临时文件生命周期
src/config.ts         阈值默认值、env 初值、命令参数解析、会话持久化重放
src/analyze.ts        尺寸评估、内建 footer 剔除、预览裁剪、重复行折叠、信号行抽取
src/suggest.ts        命令启发式 -> 重写建议
src/scan-guard.ts     扫描解析：引号感知段切分 + tokenizer + find/grep/rg/du/tree root 判定
src/timeout-guard.ts  搜索命令 5 分钟超时封顶（纯函数）
src/guard-message.ts  组装最终 guard 文本
tests/                纯函数 + 端到端（mockPi）用例
```

## License

MIT

# pi-extension-bash-guard

pi 插件：拦截 bash/powershell 的「大输出」，只回少量核心行 + 全文落盘路径 + **重写命令的提示**；
同时在会话开局注入一次输出纪律。目标不是把输出截断，而是**逼模型把 shell 写对**，而不是
`cat` 一大坨噪声进上下文。

## 行为

两件事，一软一硬：

1. **开局立规矩（软）**：会话第一次 agent run 时注入一条 `[BASH OUTPUT DISCIPLINE]`
   （`display: false`，只进模型上下文不进 TUI），告诉模型搜索/读文件/日志该怎么限量，
   以及被 guard 拦截后该怎么办。只注入一次，append-only，缓存安全。
2. **超阈值硬拦截（硬）**：`tool_result` 阶段检查 bash/powershell 结果；超过阈值（默认
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

不做的事：**不拦截命令执行**（不预判、不自动加 `| head`，那会破坏重定向/管道语义），
也**不覆写安装的 `bash` 工具**（pi 内建已经做 2000 行/50KB 截断并落盘全文，本插件
在此基础上把阈值收紧并加「重写」指令）。

## 亮点

- **针对性建议**：按原命令特征给具体改写（`cat` → `read`/`sed`；无界 `rg` → `-l`/`-c`/`-m`；
  `git log` → `--oneline -n 20`；`find`/`ls -R`/`du -a`/`env`/`docker logs`……）。
- **错误不埋**：`isError` 时尾部预览加长，并先抽取 `Error`/`Traceback`/`npm ERR!` 等信号行顶到前面。
- **重复踩坑升级**：同一命令再次被拦截会提示「已拦截过」；本会话第 3 次起追加升级警告。
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
| `/bash-guard status` | 显示当前阈值、预览行数、本会话拦截次数 |
| `/bash-guard bytes 8192` | 改字节阈值（`0` = 不限字节） |
| `/bash-guard preview 25 15` | 改头/尾预览行数 |

配置通过 `pi.appendEntry` 持久化进会话，resume 时重放。

环境变量作为**新会话初值**（会话里有持久化配置时以持久化配置为准）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BASH_GUARD_DISABLED` | — | 设为非空非 0 值即默认关闭 |
| `PI_BASH_GUARD_ENABLED=0` | — | 默认关闭 |
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

## 开发

```bash
pnpm install
pnpm test        # vitest，51 个用例
pnpm typecheck   # tsc --noEmit
pnpm check:biome # lint + format 检查
```

目录：

```
src/index.ts          插件装配：事件、/bash-guard 命令、状态栏、临时文件生命周期
src/config.ts         阈值默认值、env 初值、命令参数解析、会话持久化重放
src/analyze.ts        尺寸评估、内建 footer 剔除、预览裁剪、重复行折叠、信号行抽取
src/suggest.ts        命令启发式 -> 重写建议
src/guard-message.ts  组装最终 guard 文本
tests/                纯函数 + 端到端（mockPi）用例
```

## License

MIT

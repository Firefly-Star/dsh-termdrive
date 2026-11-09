# 终端驱动配方

## 1. 跑一个会崩的程序并抓下崩溃现场

默认形态（命令敲进存活的 shell）就是为这个设计的：

```
term_start {session: "c", command: "python main.py"}
# 等程序跑完/崩掉
term_screen {session: "c", history: 200}
```

程序退出后 shell 还在，最后一屏（含 traceback）留在屏幕上。会话不会跟着一起消失。

## 2. 驱动一个 TUI（固定尺寸 + 逐步确认）

```
term_start {session: "ui", command: "./app", cols: 100, rows: 30}
term_screen {session: "ui"}                          # 看首帧
term_key   {session: "ui", keys: ["Down", "Down"]}   # 移动高亮
term_screen {session: "ui"}                          # 确认高亮位置
term_key   {session: "ui", keys: ["Enter"]}          # 选中
term_screen {session: "ui"}                          # 确认结果
term_kill  {session: "ui"}
```

TUI 通常自己切 raw mode，所以**方向键不需要额外补 Enter**；但用 `term_send` 敲普通字符时
仍要注意第四节说的规范模式。拿不准就"发一次看一次"。

## 3. 回答一个交互式提问（y/n、路径、口令）

```
term_start {session: "i", command: "./setup.sh"}
term_screen {session: "i"}                 # 看清问什么、默认值是什么
term_send   {session: "i", text: "y"}      # enter 默认 true，直接回车提交
term_screen {session: "i"}
```

不要 `term_send` 一个长答案再补 `term_key Enter` —— 默认 `enter: true` 已经带了，
补两次回车会多吃掉一个后续提示。

## 4. 驱动 REPL（一行一结果）

```
term_start {session: "repl", command: "python3 -u -i"}
term_send {session: "repl", text: "1+1"}
term_screen {session: "repl"}              # 只关心新出来的那几行
term_send {session: "repl", text: "import sys; print(sys.version)"}
term_screen {session: "repl"}
```

`-u` 或 `-i` 保证输出及时刷出来。每次 `term_screen` 都会把整屏带回来，信息量大时
可以只用 `history` 缩小范围（`history: 0` 就是当前屏）。

## 5. 程序永远不返回（等待输入 / 死循环）

先判断是哪一种：

```
term_screen {session: "x"}     # 屏幕上有没有提示或光标位置？
```

- 有提示在等输入 → `term_send` / `term_key` 回应它；
- 真正死循环 → `term_key {keys: ["C-c"]}` 中断，或 `term_kill` 关掉。

**不要**在屏幕还停在同一个提示上时反复发同一个键。

## 6. 交接给用户

```
term_screen {session: "login"}    # 看到"请输入验证码"之类
term_attach {session: "login"}    # 拿到给人用的接入命令
```

把命令原样给用户，说清"卡在哪、需要他做什么"，然后**停手**。用户回话后用
`term_screen` 重新读状态再继续。

## 7. 平台上它落在哪

| 平台 | tmux 实际位置 | 说明 |
|---|---|---|
| Linux / macOS | 本机 | 直接调 `tmux` |
| Windows | WSL 里 | 走 `wsl -d <distro> -- tmux`，插件自动处理 |

`term_status` 的 `transport` 字段会告诉你落在哪。

**注意**：Windows 上被驱动的程序必须也跑在 WSL 里。从 WSL 的 PTY 启动**原生 Windows
程序**，那个程序报的 `isatty` 仍然是 False（实测：WSL↔Win32 这道边界会把终端性丢掉），
等于白套一层 tmux。原生 Windows 程序要终端，需要 ConPTY，不在本插件能力范围内。

## 8. 编码

插件已统一按 UTF-8 收发，并给 `wsl.exe` 设了 `WSL_UTF8=1`（不设的话它会转成控制台
代码页，中文路径读回来就是乱码）。

仍见到乱码时按这个顺序查：

1. 终端里 `locale` 是不是 UTF-8（`LANG=C.UTF-8`）；
2. 被驱动程序自己的输出编码（有些老工具按 GBK 输出）；
3. 别用 `escapes: true` 去读纯文本内容。

## 9. 多个 agent 共用

会话名就是隔离边界：各用各的（`session: "alice"` / `"bob"`），互不干扰。
`term_list` 能看到全部会话；**不要 kill 别人名字的会话**。会话名只允许
字母数字和 `_ . -`，插件会拒绝其它字符。

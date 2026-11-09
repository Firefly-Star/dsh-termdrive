---
name: termdrive
description: 在真实终端里驱动交互式程序：TUI、REPL、需要一步步输入的命令行工具、安装向导、要等按键/口令的程序。起 tmux 会话（程序因此有真正的控制终端），发按键、取渲染后的屏幕、必要时把会话交给用户亲手接管。
whenToUse: 程序需要一步步输入、会阻塞等按键、或行为在"你直接跑"和"人手动跑"之间不一致时。非交互的一次性命令不要用它，用 pwsh。
---

# 终端驱动手册

## 一、为什么需要它

**agent 自己的 shell 没有控制终端。** `isatty(stdin)` 是假的，于是程序走进另一条
代码分支：raw mode 不生效、`select` 行为不同、或者干脆卡在等输入上。

这不是猜测，是量出来的：

```
同一个程序，agent 直接跑     → isatty = False    （和走管道完全一样）
同一个程序，放进 tmux 里跑   → isatty = True
```

所以判据很简单：**如果这个程序"人手动跑得起来、你跑不起来"，就用 termdrive。**

## 二、四个动作

| 动作 | 工具 | 说明 |
|---|---|---|
| 起会话 | `term_start {session, command?}` | 默认先起一个**存活的 shell**，再把 command 敲进去 |
| 发输入 | `term_send {text}` / `term_key {keys: [...]}` | 文本用 send，方向键/回车/C-c 用 key |
| 取屏幕 | `term_screen {history?}` | **这就是终端的 DOM**，人眼看到的内容 |
| 收工 | `term_kill {session}` | 只关自己起的会话 |

`term_status` 先看底子（tmux 在哪、有哪些会话），`term_attach` 拿人接入的命令。

## 三、铁律：每个动作之后都要看屏幕

不要假设按下去发生了什么。终端程序的状态**只在屏幕上**，不在你的想象里。

```
term_start {session: "t", command: "./installer"}   → 等一会
term_screen {session: "t"}                          → 看清它在问什么
term_key   {session: "t", keys: ["Down", "Enter"]}  → 按
term_screen {session: "t"}                          → 确认结果，再决定下一步
```

**一次只做一步，然后看屏幕。** 连按是最常见的自毁方式：终端程序吞掉连按后状态就乱了。

## 四、起会话的两种形态

```
term_start {command: "..."}                  → 命令敲进一个存活的 shell（默认，推荐）
term_start {command: "...", asPaneCommand: true}  → 命令直接当 pane 命令
```

默认形态是为了**抓住崩溃现场**：`asPaneCommand: true` 时程序退出会话就没了，秒崩的程序
连堆栈都留不下。默认形态下程序崩了，shell 还在，`term_screen` 还能把堆栈读出来。

判据：**要抓输出/崩溃用默认；只是想要个干净的一次性运行才用 asPaneCommand。**

## 五、最常见的三个坑

**1. 按了键但程序没反应 —— 多半是规范模式。**
tmux 的 pty 默认是规范模式，`read(1)` 要等到行结束符才返回。你看到的字符只是终端回显：

```
term_send {text: "a", enter: false}   → 屏幕上出现 a，但程序还没收到
term_key  {keys: ["Enter"]}           → 这时程序才拿到
```

除非程序自己切了 raw mode（多数 TUI 都会），否则**按完要补一个 Enter**。

**2. 屏幕是空的 —— 多半是缓冲。**
程序输出走管道式缓冲，没 flush 就什么都看不到。让程序行缓冲：Python 用 `-u`，
多数程序有 `--line-buffered` / `stdbuf -oL`。**这是程序的问题，不是 termdrive 的。**

**3. TUI 排版乱 —— 固定终端尺寸。**
`term_start {cols: 100, rows: 30}` 把尺寸钉死，抓帧才可复现。不同宽度下换行位置不同，
"上一帧和这一帧对不上"经常只是宽度变了。

## 六、交接给用户：这是重点之一

需要口令、验证码、二次确认、扫码时，**停手，交回给用户**。人和 agent 用的是
**同一个会话**，不是副本 —— 你 `term_attach` 给出命令，用户在终端里接过键盘：

1. `term_screen` 看清卡在哪；
2. 一句话说清「需要你做什么」，附上 `term_attach` 给出的命令；
3. **停手等**。不要猜口令、不要反复重试、不要绕过；
4. 用户说好了，`term_screen` 确认状态，再接着干。

## 七、收工

`term_kill {session}`。会话是共享资源，**只关自己起的那个**；别人名字的会话先
`term_list` 看看，不要顺手清掉。

## 八、报错对照

| 现象 | 含义 | 处理 |
|---|---|---|
| `取屏幕失败: ... no server running` | 会话没了（程序退出且未保留，或被 kill） | `term_status` 确认，`term_start` 重开 |
| `起会话失败` | 同名会话还在 | 先 `term_kill`，或换个会话名 |
| `tmux 不可用` | 该环境没装 tmux | Windows 上确认 WSL 发行版里有 tmux |
| 中文路径显示成乱码 | 编码没走 UTF-8 | 插件已处理（`WSL_UTF8=1`）；仍乱码看 `references/patterns.md` |

更细的配方见 `references/patterns.md`。

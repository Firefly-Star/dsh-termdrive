# dsh-termdrive

让 [DSH](https://github.com/deepseek-ai/dsh) 的 agent 能像人一样操作**交互式终端程序**：TUI、REPL、需要一步步输入的命令行工具、安装向导、要等按键或口令的程序。

配套技能：`termdrive`（随包提供，手册在 [`assets/termdrive/`](assets/termdrive/SKILL.md)）。

## 为什么需要它

**agent 自己的 shell 没有控制终端。** `isatty(stdin)` 是假的，程序于是走进另一条代码分支：raw mode 不生效、`select` 行为不同、或者干脆卡在等输入上。所以经常出现"我手动跑得起来、agent 跑不起来"。

实测（同一台机器、同一个程序）：

| 启动方式 | `isatty(stdin)` |
|---|---|
| agent 直接跑 | `False`（和走管道完全一样） |
| 放进 tmux 的 pane 里跑 | `True` |

tmux 为每个 pane 分配真正的 PTY，程序因此走人手动运行时那条路径。对齐 CDP 的说法：

| CDP | termdrive |
|---|---|
| WebSocket 传输通道 | tmux 的 PTY |
| `DOM.getDocument` | `term_screen` —— tmux 已渲染好的字符网格，人眼看到的内容 |
| `Input.dispatchKeyEvent` | `term_send` / `term_key` |
| 人工开 DevTools | `term_attach` —— 人和 agent 用**同一个**会话，不是副本 |

另一个附带好处：**插件的工具跑在 DSH 宿主进程里，不受 agent 沙箱限制**。agent 自己的受限 shell 常常连不上 WSL、也会被管道限制挡住；走插件则不需要逐次申请提权。

## 安装

```bash
dsh plugin --profile web add github:Firefly-Star/dsh-termdrive
```

然后重启该 profile 让插件装载。验收标准：**新开一个 agent 会话，它的工具表里应该有 `term_status`**。

> **注意 `dsh plugin add` 的已知副作用**：若 pnpm 因"构建脚本未批准"（`ERR_PNPM_IGNORED_BUILDS`，通常由 profile 里**其它**包的 `postinstall` 触发）中途退出，DSH 的收尾步骤不会跑，`dsh.profile.bundles` 里就不会自动补上条目。此时依赖其实已经装好，只需手动把 `dsh-termdrive` 加进 profile `package.json` 的 `dsh.profile.bundles`（这正是收尾会做的事）。

## ⚠️ 本地开发用 `link:` 或正常安装，**别用 `file:`**

同一台机器、同一个插件、同一份代码，三种安装方式实测结果：

| 安装方式 | `node_modules` 里的形态 | import `@deepseek-ai/dsh-tools` |
|---|---|---|
| `link:<本地目录>` | Junction（链接型） | ✅ 可以 |
| `github:owner/repo` 或 registry | 普通目录，且**自带 `node_modules` 为空** | ✅ 可以 |
| `file:<本地目录>` | 指向 profile 之外的符号链接 | ❌ `ERR_MODULE_NOT_FOUND` |

失败的报错长这样：

```
failed to import: ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
  imported from C:\path\to\your-plugin\lib\index.js
```

注意锚点是**插件的原始目录**（在 profile 树之外）—— 从那里向上逐级找都碰不到任何
`node_modules/@deepseek-ai`，而 `file:` 这种形态又拿不到 DSH 提供的解析映射。

**结论：本地开发用 `link:`；发布后让使用者用 `github:` / registry；不要用 `file:` 指向本地目录。**

本插件同时把实际 import 的 `@deepseek-ai/*` 都写进 `peerDependencies`（版本用 `*`）。需要说明的是：**这并不能解决上面那道坎** —— 同样的声明，`file:` 下照样失败、`link:` 下照样成功。保留它的理由是：这是社区通行写法（`dsh-wsl-workspace` 就是这么声明的），而且 `*` 能避开 DSH 的 peer 版本门禁，升级 DSH 时不会因为版本不匹配被直接拒绝装载。别"清理"掉它们。

## 工具

| 工具 | 作用 |
|---|---|
| `term_status` | tmux 在哪（本机 / WSL）、版本、现有会话 |
| `term_start` | 起会话。默认先起存活的 shell 再敲命令，这样秒崩的程序也留得住堆栈 |
| `term_send` | 敲字面文本（`enter` 默认 true） |
| `term_key` | 具名按键：`Enter` / `Up` / `C-c` / `Escape` … |
| `term_screen` | 取屏幕（可带 `history` 滚动缓冲、`escapes` 保留颜色） |
| `term_list` | 列出会话 |
| `term_kill` | 关会话（幂等） |
| `term_attach` | 返回人接入同一会话的命令 |

## 配置

在 profile patch 里按 id 覆盖：

```yaml
- id: termdrive
  name: 'dsh-termdrive'
  config:
    via: auto            # auto | local | wsl
    distro: Ubuntu-22.04 # 仅 via=wsl 时有效；留空 = 用系统默认发行版
```

`via` 默认 `auto`：Windows 上走 WSL，其它平台用本机 tmux。`distro` 默认**留空**，即不传 `-d`、由 WSL 用自己的默认发行版 —— 这样仓库里不会写死某台机器的发行版名字。

## 平台

| 平台 | tmux 实际位置 |
|---|---|
| Linux / macOS | 本机 `tmux` |
| Windows | WSL 里，走 `wsl -- tmux` |

**Windows 上被驱动的程序也必须跑在 WSL 里。** 从 WSL 的 PTY 启动**原生 Windows 程序**，那个程序报的 `isatty` 仍然是 `False`（WSL↔Win32 这道边界会把终端性丢掉），等于白套一层 tmux。原生 Windows 程序要终端得用 ConPTY，不在本插件范围内 —— 但 `detectTransport()` 返回的就是一个传输描述，将来加第二种 transport 不必动 `lib/tools.js`。

依赖只有三样：一个 WSL 发行版、里面的 `tmux`、以及目标程序能在 WSL 里跑。**不需要** screen / expect / pyte / pexpect。

## 开发

```bash
node test/apply-contract.mjs   # 插件契约：桩 + 严格假 ctx，28 项
node test/selftest.mjs         # 真实 tmux 全流程，10 项（需要 tmux 与 WSL）
node test/smoke-plugin.mjs     # 用真实 SDK 校验工具规格（需 peer 可解析）
```

`apply-contract.mjs` 里的假 ctx **刻意复刻 Cordis 的严格性**（未在 `inject` 里声明的服务，做属性访问就抛错），末尾还有一条自证断言证明它确实会抛 —— 否则测试可能只是"假通过"。

## 踩过的坑

1. **`wsl.exe` 会吃掉以 `#` 开头的参数** —— 它把命令交给 shell 解释，`#` 起了注释。tmux 的格式串恰好都以 `#` 开头，症状是 `tmux: option requires an argument -- F`。修法：WSL 分支自己过一层 shell 并逐个参数加引号。
2. **`ctx.get()` 与 `ctx.xxx` 不等价** —— Cordis 对未注入的服务只允许 `ctx.get(name)` 读取；写成 `ctx.skills` 会抛 `cannot get property "skills" without inject`。而 `inject` 只有"必需"语义，没有 optional 列表。
3. **`remain-on-exit` 必须在会话建好之后设** —— 设早了它会落在一个"还没有任何会话、随即退出"的 server 上，设置丢失；秒崩的程序会把会话一起带走，堆栈随之消失。修法：先起存活的 shell，再把命令敲进去。
4. **`#{session_width}` 在 tmux 3.2 的 `list-sessions` 里求值为空** —— 尺寸要单独用 `list-windows -F '#{window_width}x#{window_height}'` 问。
5. **两层编码**：`wsl.exe` 会把输出转成控制台代码页（需 `WSL_UTF8=1`）；被管道接管的 Windows Python 默认按 ANSI 代码页写 stdout。两边都要按 UTF-8 处理，中文路径才不乱码。

## 许可

MIT

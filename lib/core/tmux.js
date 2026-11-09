/**
 * tmux 传输层：把「驱动一个交互式程序」压成四个动作 —— 起会话 / 发输入 / 取屏幕 / 关会话。
 *
 * 为什么是 tmux（而不是直接 spawn 一个进程）：
 * tmux 给每个 pane 分配一个真正的 PTY。程序因此拿到控制终端，走的就是人手动
 * 运行时那条代码路径（isatty 为真、raw mode 可用、终端尺寸可设）。agent 自己的
 * shell 通常没有 TTY，直接跑同一个程序会走另一条分支甚至卡死 —— 这就是
 * "在我这儿能跑、在 agent 那儿不行" 的全部原因。
 *
 * 环境适配：
 *   Linux/macOS —— 直接调本机 tmux。
 *   Windows     —— tmux 只活在 WSL 里，所以走 `wsl -d <distro> -- tmux ...`。
 *                  agent 的受限 shell 连不上 WSL（沙箱挡的），但本插件的工具跑在
 *                  DSH 宿主进程里，所以这条路不需要 agent 逐次申请提权。
 */
import { spawnSync } from 'node:child_process';

/** 会话名只允许安全字符：它会被拼进 tmux 参数，杜绝任何注入面。 */
const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 默认会话名。多 agent 并存时各自用不同名字即可。 */
export const DEFAULT_SESSION = 'dsh';

/**
 * 判断往哪儿发 tmux 命令。
 *
 * `distro` 留空表示"用系统默认的 WSL 发行版" —— 不传 `-d`，所以不会把某台机器
 * 上的发行版名字写死进仓库。
 *
 * @param {{via?:'auto'|'local'|'wsl', distro?:string}} [config]
 * @returns {{kind:'local'|'wsl', distro?:string}}
 */
export function detectTransport(config = {}) {
  const via = config.via ?? 'auto';
  const wsl = config.distro ? { kind: 'wsl', distro: config.distro } : { kind: 'wsl' };
  if (via === 'local') return { kind: 'local' };
  if (via === 'wsl') return wsl;
  // auto：Windows 上没有原生 tmux，一律走 WSL；其它平台用本机 tmux。
  if (process.platform === 'win32') return wsl;
  return { kind: 'local' };
}

/**
 * POSIX 单引号转义：把 argv 拼成一条能在 shell 里安全执行的命令。
 * @param {string[]} argv
 * @returns {string}
 */
function shellQuote(argv) {
  return argv.map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`).join(' ');
}

/**
 * 拼出完整的命令行（argv 数组）。
 * @param {{kind:string, distro?:string}} transport
 * @param {string[]} args tmux 的参数
 * @returns {string[]}
 */
export function tmuxArgv(transport, args) {
  if (transport.kind === 'wsl') {
    // WSL 分支必须自己过一层 shell 并逐个参数加引号。
    //
    // 原因：wsl.exe 会把命令交给 shell 解释，于是**以 `#` 开头的参数被当成注释
    // 整段吃掉**。tmux 的格式串恰好都以 `#` 开头，症状是
    // `tmux: option requires an argument -- F` —— 格式串根本没送到 tmux。
    // 实测：`-F '#{session_name}'` 失败，`-F 'N=#{session_name}'` 正常。
    // 自己加引号之后，参数原样抵达，这类问题一次消失。
    //
    // 没配置 distro 就不传 -d，让 wsl 用它自己的默认发行版。
    const target = transport.distro ? ['-d', transport.distro] : [];
    return ['wsl', ...target, '--', 'bash', '-lc', shellQuote(['tmux', ...args])];
  }
  // 本机 tmux：直接 exec，不过 shell，因此没有引号问题。
  return ['tmux', ...args];
}

/**
 * 跑一条 tmux 命令。
 *
 * WSL_UTF8=1 是必需的：否则 wsl.exe 会把输出转成控制台代码页（这里是 936），
 * UTF-8 的中文路径读回来就是乱码。
 *
 * @param {{kind:string, distro?:string}} transport
 * @param {string[]} args
 * @param {{timeoutMs?:number}} [options]
 * @returns {{code:number, stdout:string, stderr:string, timedOut:boolean}}
 */
export function run(transport, args, options = {}) {
  const proc = spawnSync(tmuxArgv(transport, args)[0], tmuxArgv(transport, args).slice(1), {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WSL_UTF8: '1' },
  });
  return {
    code: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    timedOut: proc.error?.code === 'ETIMEDOUT',
  };
}

/**
 * tmux 在不在、什么版本。
 * @param {object} transport
 * @returns {{available:boolean, version:string, error:string}}
 */
export function probe(transport) {
  const result = run(transport, ['-V'], { timeoutMs: 10000 });
  if (result.code === 0) return { available: true, version: result.stdout.trim(), error: '' };
  const detail = (result.stderr || result.stdout || '').trim();
  return { available: false, version: '', error: detail || `exit ${result.code}` };
}

/** 校验会话名，非法就抛（并且说清合法形状）。 */
export function assertSessionName(name) {
  if (!SESSION_RE.test(name)) {
    throw new Error(`会话名不合法: ${JSON.stringify(name)}；只允许字母数字和 _ . -，最长 64。`);
  }
  return name;
}

/** 会话存在吗。 */
export function hasSession(transport, session) {
  return run(transport, ['has-session', '-t', assertSessionName(session)]).code === 0;
}

/** 列出会话，没有会话时返回空数组而不是报错。 */
export function listSessions(transport) {
  // 注意：`#{session_width}` / `#{session_height}` 在 tmux 3.2 的 list-sessions
  // 上下文里求值为空，尺寸要单独问（见 sessionSize）。
  const result = run(transport, ['list-sessions', '-F', '#{session_name}\t#{session_windows}']);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, windows] = line.split('\t');
      return { name, windows };
    });
}

/** 某个会话当前窗口的尺寸，形如 "100x30"。 */
export function sessionSize(transport, session) {
  // 用 list-windows 而不是 display-message：后者的格式化参数在不同 tmux 版本里
  // 行为不一致（3.2 上会把默认消息打回来），list-windows -F 是稳的。
  const result = run(transport, [
    'list-windows', '-t', assertSessionName(session), '-F', '#{window_width}x#{window_height}',
  ]);
  if (result.code !== 0) return '';
  return (result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0]) ?? '';
}

/**
 * 起一个会话。
 *
 * 两个刻意的选择，都是踩出来的：
 *  1. 默认先起一个**存活的 shell**，再把命令敲进去，而不是让目标程序直接当 pane
 *     的命令。因为秒崩的程序会把会话一起带走 —— 在 `remain-on-exit` 生效之前
 *     就没了，堆栈随之丢失。而"在 shell 里敲命令"本来也就是人的操作方式。
 *     真要让程序自己当 pane 命令，用 asPaneCommand。
 *  2. `remain-on-exit` 必须在会话建好**之后**设。设早了它会落在一个"还没有任何
 *     会话、随即退出"的 server 上，设置直接丢失。
 *
 * @param {object} transport
 * @param {{session:string, command?:string, cols?:number, rows?:number, asPaneCommand?:boolean}} spec
 */
export function startSession(transport, spec) {
  const session = assertSessionName(spec.session);
  const cols = spec.cols ?? 100;
  const rows = spec.rows ?? 30;
  const command = (spec.command ?? '').trim();

  // 起新的之前先清掉同名会话，否则 new-session 会失败。
  run(transport, ['kill-session', '-t', session]);

  const paneCommand = spec.asPaneCommand && command ? command : 'bash -l';
  const created = run(transport, [
    'new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), paneCommand,
  ]);
  if (created.code !== 0) {
    throw new Error(`起会话失败: ${(created.stderr || created.stdout).trim()}`);
  }

  // 会话存在之后再设：崩溃留下的最后一屏（堆栈）才留得住。
  run(transport, ['set-window-option', '-t', session, 'remain-on-exit', 'on']);

  const typed = Boolean(command) && !spec.asPaneCommand;
  if (typed) {
    sendLiteral(transport, session, command);
    sendKeys(transport, session, ['Enter']);
  }
  return { session, cols, rows, command, typedIntoShell: typed };
}

/** 发字面文本（`-l`，所以 "Enter" 这种名字不会被当成按键名解释）。 */
export function sendLiteral(transport, session, text) {
  const result = run(transport, ['send-keys', '-t', assertSessionName(session), '-l', text]);
  if (result.code !== 0) throw new Error(`发送文本失败: ${(result.stderr || result.stdout).trim()}`);
}

/** 发具名按键（Enter / C-c / Up / Space / Escape ...）。 */
export function sendKeys(transport, session, keys) {
  const name = assertSessionName(session);
  for (const key of keys) {
    const result = run(transport, ['send-keys', '-t', name, key]);
    if (result.code !== 0) throw new Error(`发送按键 ${key} 失败: ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * 取屏幕 —— 这就是"终端的 DOM"：tmux 已经把转义序列渲染成字符网格了，
 * 拿到的就是人眼看到的内容，而不是一堆 \x1b[ 字节。
 *
 * @param {object} transport
 * @param {{session:string, history?:number, escapes?:boolean}} spec history>0 时带上滚动缓冲
 */
export function captureScreen(transport, spec) {
  const args = ['capture-pane', '-p', '-t', assertSessionName(spec.session)];
  if (spec.history) args.push('-S', `-${spec.history}`);
  // -e 保留颜色等转义序列（默认丢掉，给出纯文本）
  if (spec.escapes) args.push('-e');
  const result = run(transport, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `取屏幕失败: ${detail}\n` +
      `会话多半已经不存在了 —— 先 term_status 看看，或 term_start 重开。`
    );
  }
  // 去掉尾部空行，省下模型的 token
  const lines = result.stdout.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return { text: lines.join('\n'), lines: lines.length };
}

/** 关会话（不存在也算成功）。 */
export function killSession(transport, session) {
  const name = assertSessionName(session);
  const existed = hasSession(transport, name);
  run(transport, ['kill-session', '-t', name]);
  return { session: name, killed: existed };
}

/**
 * 给人看的接入命令：人和 agent 用的是**同一个**会话，不是副本。
 * @param {object} transport
 * @param {string} session
 */
export function attachCommand(transport, session) {
  const name = assertSessionName(session);
  if (transport.kind === 'wsl') {
    const target = transport.distro ? `-d ${transport.distro} ` : '';
    return `wsl ${target}-- tmux attach -t ${name}`;
  }
  return `tmux attach -t ${name}`;
}

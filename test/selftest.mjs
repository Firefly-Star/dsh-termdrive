/**
 * 自检：用真实的 tmux 跑通「起会话 → 取屏幕 → 发输入 → 取屏幕 → 关会话」，
 * 并验证两个容易回归的性质。
 *
 * 不依赖 Cordis：直接调 lib/core/tmux.js，所以 `node test/selftest.mjs` 就能跑。
 *
 * 注意：在 agent 的受限 shell 里跑它会失败（Node 的 child_process 管道被沙箱挡，
 * 报 EPERM）。换个说法：**这个自检本身就说明了插件为什么必须是插件** ——
 * 插件跑在 DSH 宿主进程里，不受 agent 沙箱限制。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureScreen,
  detectTransport,
  killSession,
  listSessions,
  probe,
  sendKeys,
  sendLiteral,
  sessionSize,
  startSession,
} from '../lib/core/tmux.js';

const SESSION = 'termdrive-selftest';
const BREAK_SESSION = 'termdrive-selftest-break';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询屏幕直到出现期望的内容。
 *
 * 不要用固定 sleep：WSL 里从 /mnt/c 读脚本、拉解释器都偏慢，固定等待会抓到
 * 命令回显而不是程序输出（这正是第一版自检踩的坑）。
 */
async function waitFor(transport, session, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = captureScreen(transport, { session }).text;
    if (pattern.test(last)) return last;
    await sleep(250);
  }
  return last;
}

/** Windows 路径转成 WSL 能用的 /mnt/<drive>/... */
function shellPath(file) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(file);
  if (!match) return file.split(path.sep).join('/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].split('\\').join('/')}`;
}

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function main() {
  const transport = detectTransport();
  console.log(`transport = ${transport.kind}${transport.distro ? ` (${transport.distro})` : ''}\n`);

  const availability = probe(transport);
  if (!availability.available) {
    console.log(`  FAIL  tmux 不可用: ${availability.error}`);
    return 1;
  }
  console.log(`tmux ${availability.version}\n`);

  // 清掉可能残留的会话，保证从干净状态开始
  killSession(transport, SESSION);
  killSession(transport, BREAK_SESSION);

  console.log('scenario 1: 交互程序拿得到真 TTY');
  const probeScript = shellPath(path.join(HERE, 'probe-tty.py'));
  startSession(transport, {
    session: SESSION,
    command: `python3 -u ${probeScript}`,
    cols: 100,
    rows: 30,
  });
  let screen = await waitFor(transport, SESSION, /READY/);
  check('屏幕报告 isatty(stdin) = True', /isatty\(stdin\) = True/.test(screen), screen);
  check('程序已就绪', /READY/.test(screen), screen);
  const size = sessionSize(transport, SESSION);
  check('终端尺寸被固定为 100x30', size === '100x30', `实际: ${JSON.stringify(size)}`);

  console.log('\nscenario 2: 输入真的送到程序里');
  sendLiteral(transport, SESSION, 'hello');
  sendKeys(transport, SESSION, ['Enter']);
  screen = await waitFor(transport, SESSION, /DONE/);
  check('程序收到了 hello', /received: 'hello/.test(screen), screen);
  check('程序正常收尾', /DONE/.test(screen), screen);

  console.log('\nscenario 3: 秒失败的命令不会把会话带走（这条是踩出来的回归）');
  startSession(transport, { session: BREAK_SESSION, command: 'nonexistent-command-xyz' });
  screen = await waitFor(transport, BREAK_SESSION, /not found/i);
  check('失败信息留在了屏幕上', /not found/i.test(screen), screen);
  const survived = listSessions(transport).some((s) => s.name === BREAK_SESSION);
  check('会话仍在', survived, JSON.stringify(listSessions(transport)));

  console.log('\nscenario 4: 会话名校验');
  let rejected = false;
  try {
    startSession(transport, { session: 'bad name; rm -rf /', command: 'true' });
  } catch {
    rejected = true;
  }
  check('非法会话名被拒', rejected);

  console.log('\n清理');
  check('关掉主会话', killSession(transport, SESSION).killed);
  check('关掉失败场景会话', killSession(transport, BREAK_SESSION).killed);

  console.log(`\n${passed} 项通过, ${failures.length} 项失败`);
  if (failures.length) {
    console.log('失败项:');
    for (const item of failures) console.log(`  - ${item}`);
  }
  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n自检异常: ${error.message}`);
    try {
      killSession(detectTransport(), SESSION);
      killSession(detectTransport(), BREAK_SESSION);
    } catch { /* 清理失败不影响结论 */ }
    process.exit(1);
  });

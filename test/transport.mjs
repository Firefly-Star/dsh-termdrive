/**
 * 传输层的纯函数单测 —— 没有 I/O，不需要 tmux，也不需要 WSL。
 *
 * 覆盖的都是实打实咬过人的点：
 *   * 默认不把某台机器的发行版名字写死；
 *   * 只有显式配置 distro 才传 `-d`；
 *   * WSL 分支的每个 tmux 参数都被单引号包住（否则 `#` 开头的格式串会被 shell 当注释吃掉）。
 */
import assert from 'node:assert/strict';
import { attachCommand, detectTransport, tmuxArgv } from '../lib/core/tmux.js';

let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${label}`); }
  catch (error) { failures.push(label); console.log(`  FAIL  ${label}\n        ${error.message}`); }
}

console.log('detectTransport');
check('auto 在 Windows 上选 wsl', () => {
  if (process.platform !== 'win32') return; // 非 Windows 跳过这半条
  assert.equal(detectTransport().kind, 'wsl');
});
check('auto 不写死发行版（distro 为 undefined）', () => {
  const t = detectTransport();
  if (t.kind === 'wsl') assert.equal(t.distro, undefined);
});
check('auto 在非 Windows 上选 local', () => {
  if (process.platform === 'win32') return;
  assert.equal(detectTransport().kind, 'local');
});
check('via=local 强制本机', () => assert.equal(detectTransport({ via: 'local' }).kind, 'local'));
check('via=wsl 强制 WSL', () => assert.equal(detectTransport({ via: 'wsl' }).kind, 'wsl'));
check('显式 distro 会被带上', () => assert.equal(detectTransport({ distro: 'Debian' }).distro, 'Debian'));

console.log('\ntmuxArgv');
check('配置了 distro 才出现 -d', () => {
  const argv = tmuxArgv(detectTransport({ distro: 'Ubuntu-22.04' }), ['-V']);
  assert.deepEqual(argv.slice(0, 3), ['wsl', '-d', 'Ubuntu-22.04']);
});
check('没配置 distro 时不出现 -d', () => {
  const argv = tmuxArgv({ kind: 'wsl' }, ['-V']);
  assert.equal(argv[0], 'wsl');
  assert.ok(!argv.includes('-d'), `不应出现 -d：${argv.join(' ')}`);
});
check('WSL 分支经过 bash -lc', () => {
  const argv = tmuxArgv({ kind: 'wsl' }, ['-V']);
  assert.ok(argv.includes('bash'));
  assert.ok(argv.includes('-lc'));
});
check('tmux 参数逐个加单引号（# 开头不会被当注释）', () => {
  const argv = tmuxArgv({ kind: 'wsl' }, ['list-sessions', '-F', '#{session_name}']);
  const command = argv[argv.length - 1];
  assert.ok(command.includes("'#{session_name}'"), command);
  assert.ok(command.startsWith("'tmux'"), command);
});
check('单引号自身被正确转义', () => {
  // 期望形态：a'b  ->  'a'\''b'
  const argv = tmuxArgv({ kind: 'wsl' }, ['-F', "a'b"]);
  const command = argv[argv.length - 1];
  assert.ok(command.includes(`'a'\\''b'`), command);
});
check('本机分支不经过 shell', () => {
  assert.deepEqual(tmuxArgv({ kind: 'local' }, ['-V']), ['tmux', '-V']);
});

console.log('\nattachCommand');
check('WSL 无 distro', () => assert.equal(attachCommand({ kind: 'wsl' }, 'dsh'), 'wsl -- tmux attach -t dsh'));
check('WSL 有 distro', () =>
  assert.equal(attachCommand({ kind: 'wsl', distro: 'Ubuntu-22.04' }, 'dsh'), 'wsl -d Ubuntu-22.04 -- tmux attach -t dsh'));
check('本机', () => assert.equal(attachCommand({ kind: 'local' }, 'dsh'), 'tmux attach -t dsh'));
check('非法会话名被拒（防注入）', () =>
  assert.throws(() => attachCommand({ kind: 'local' }, 'bad name; rm -rf /'), /不合法/));

console.log(`\n${passed} 项通过, ${failures.length} 项失败`);
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(failures.length ? 1 : 0);

/**
 * 临时排查：定位 `-F '#{...}'` 为什么到不了 tmux。
 * 假设：以 `#` 开头的参数在 Windows→WSL 传递过程中被当成注释丢掉。
 * 若成立，把格式串改成不以 `#` 开头即可绕过。
 */
import { run, detectTransport, startSession, killSession } from '../lib/core/tmux.js';

const S = 'termdrive-debug-fmt';
const transport = detectTransport();

killSession(transport, S);
startSession(transport, { session: S, command: 'sleep 60', cols: 100, rows: 30 });
await new Promise((r) => setTimeout(r, 1000));

const cases = [
  ['1 以#开头 (list-sessions)', ['list-sessions', '-F', '#{session_name}']],
  ['2 不以#开头 (list-sessions)', ['list-sessions', '-F', 'N=#{session_name}']],
  ['3 以#开头 (list-windows)', ['list-windows', '-t', S, '-F', '#{window_width}']],
  ['4 不以#开头 (list-windows)', ['list-windows', '-t', S, '-F', 'W=#{window_width}x#{window_height}']],
  ['5 -F 放在 -t 之前', ['list-windows', '-F', '#{window_width}', '-t', S]],
];

for (const [label, args] of cases) {
  const r = run(transport, args);
  console.log(`${label}`);
  console.log(`   args   = ${JSON.stringify(args)}`);
  console.log(`   code   = ${r.code}`);
  console.log(`   stdout = ${JSON.stringify(r.stdout)}`);
  const err = r.stderr.split('\n').filter((l) => !l.includes('localhost')).join(' ').trim();
  console.log(`   stderr = ${JSON.stringify(err)}`);
}

killSession(transport, S);

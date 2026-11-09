/**
 * apply() 契约测试 —— 不需要 DSH、不需要 tmux、不联网。
 *
 * 存在的理由（踩过的坑）：termdrive 第一次装载失败，报的是
 *   `cannot get property "skills" without inject`
 * 因为代码里写了 `ctx.skills` 这种**属性访问**，而 Cordis 的上下文代理对未在
 * `inject` 里声明的服务只允许用 `ctx.get(name)` 读。
 *
 * 所以这里的假 ctx **刻意复刻那种严格性**：未声明的服务一被属性访问就抛。
 * 末尾还有一条自证断言 —— 先证明这个假 ctx 确实会抛，否则测试可能只是"假通过"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, inject, name } from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

const tools = [];
const providers = [];
const warnings = [];
const declared = new Set(Array.isArray(inject) ? inject : []);

const target = {
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  logger: { info() {}, warn(message) { warnings.push(String(message)); } },
};

/** ctx.get 是文档明确的"不需要 inject"的读取口子。 */
const services = {
  skills: { registerProvider(factory) { providers.push(factory()); } },
};

const ctx = new Proxy(target, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    if (prop === 'get') return (serviceName) => services[serviceName];
    if (prop in target) return target[prop];
    if (declared.has(prop)) return target[prop];
    // 复刻 Cordis 的 proxy trap
    throw new Error(`cannot get property "${String(prop)}" without inject`);
  },
});

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
}

console.log('模块契约');
check('导出 name', name === 'termdrive', String(name));
check('inject 声明了 tools', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject));

console.log('\napply() 能在严格 ctx 下跑完');
let threw = null;
try { apply(ctx, {}); } catch (error) { threw = error; }
check('没有抛错', threw === null, threw ? `${threw.message}` : '');
check('apply 是同步返回的（无需 await）', true);

console.log('\n工具注册');
check('注册了 8 个工具', tools.length === 8, `实际 ${tools.length}`);
check('工具名都带 term_ 前缀', tools.every((t) => t.name.startsWith('term_')), tools.map((t) => t.name).join(', '));
for (const tool of tools) {
  const ok = tool.description && tool.parameters && tool.output?.schema
    && typeof tool.output.render === 'function' && typeof tool.execute === 'function';
  check(`${tool.name} 规格完整`, Boolean(ok));
}

console.log('\n技能提供者');
check('注册了 1 个技能提供者', providers.length === 1, `实际 ${providers.length}`);
check('没有因为没有 skills 服务而告警', warnings.length === 0, warnings.join(' | '));

const provider = providers[0];
const list = await provider.list();
check('list() 返回 termdrive', list.length === 1 && list[0].name === 'termdrive', JSON.stringify(list.map((c) => c.name)));
const candidate = list[0];
check('source 是 bundled', candidate.source === 'bundled', String(candidate.source));
check('rank 是 600', candidate.rank === 600, String(candidate.rank));
check('模型与用户都可调用', candidate.invocation?.modelInvocable === true && candidate.invocation?.userInvocable === true,
  JSON.stringify(candidate.invocation));
check('whenToUse 非空', typeof candidate.whenToUse === 'string' && candidate.whenToUse.length > 0);

const got = await provider.get(candidate);
check('正文非空', typeof got.content === 'string' && got.content.length > 200, `长度 ${got.content?.length}`);
check('正文里没有 frontmatter 残留', !got.content.startsWith('---'), got.content.slice(0, 20));

console.log('\n技能资源');
const resourceDir = candidate.resourceBase?.path;
check('resourceBase 指向存在的目录', Boolean(resourceDir) && fs.existsSync(resourceDir), String(resourceDir));
check('SKILL.md 在资源目录里', fs.existsSync(path.join(resourceDir ?? '', 'SKILL.md')));
check('references/patterns.md 随包存在', fs.existsSync(path.join(resourceDir ?? '', 'references', 'patterns.md')));
check('locator 指向包内', String(candidate.locator).startsWith(PACKAGE_ROOT));

console.log('\n自证：这个假 ctx 确实会捕获当初那个 bug');
let trapped = null;
try { void ctx.skills; } catch (error) { trapped = error; }
check('未声明的服务做属性访问会抛错', trapped !== null && /without inject/.test(trapped.message),
  trapped ? trapped.message : '没有抛错 —— 说明这个测试是假通过');

console.log(`\n${passed} 项通过, ${failures.length} 项失败`);
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(failures.length ? 1 : 0);

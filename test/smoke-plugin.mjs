/**
 * 装载冒烟测试：不启动 DSH，直接调插件的 apply()，用一个假 ctx 看它到底注册了什么。
 *
 * 价值在于 `defineTool` 会按真实 DSL 校验工具规格 —— 参数类型写错、output.schema
 * 缺字段之类的问题，在这里就会炸，而不是等装进 profile 才炸。
 *
 * 需要 peer 依赖可解析，所以要带 NODE_PATH 指到 DSH 自己的 node_modules：
 *   $env:NODE_PATH='C:\D\VScodeLanguage\JavaScript\node_modules\@deepseek-ai\dsh\node_modules'
 */
import { apply, inject, name } from '../lib/index.js';

const tools = [];
const providers = [];

const ctx = {
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  get(service) {
    if (service === 'skills') {
      return { registerProvider: (factory) => providers.push(factory()) };
    }
    return undefined;
  },
  logger: { info: (m) => console.log(`[info] ${m}`), warn: (m) => console.log(`[warn] ${m}`) },
};

apply(ctx, {});

console.log(`插件名   : ${name}`);
console.log(`注入服务 : ${JSON.stringify(inject)}`);
console.log(`注册工具 : ${tools.length} 个`);
for (const tool of tools) {
  const params = Object.keys(tool.parameters ?? {});
  console.log(`  - ${tool.name}  参数: ${params.length ? params.join(', ') : '(无)'}`);
}

console.log(`技能提供者: ${providers.length} 个`);
for (const provider of providers) {
  const list = await provider.list();
  console.log(`  ${provider.name}: ${list.map((c) => `${c.name}(source=${c.source}, rank=${c.rank})`).join(', ')}`);
  const one = await provider.get(list[0]);
  console.log(`  正文长度: ${one.content.length} 字符`);
  console.log(`  资源目录: ${JSON.stringify(list[0].resourceBase)}`);
  console.log(`  可调用  : ${JSON.stringify(list[0].invocation)}`);
}

// 规格自检：这几个字段缺一个，DSH 装载时就会出问题
const problems = [];
for (const tool of tools) {
  if (!tool.name || !tool.description) problems.push(`${tool.name ?? '?'}: 缺 name/description`);
  if (!tool.output?.schema) problems.push(`${tool.name}: 缺 output.schema`);
  if (typeof tool.output?.render !== 'function') problems.push(`${tool.name}: 缺 output.render`);
  if (typeof tool.execute !== 'function') problems.push(`${tool.name}: 缺 execute`);
}
console.log(problems.length ? `\n规格问题:\n  ${problems.join('\n  ')}` : '\n规格检查: 全部合规');
process.exit(problems.length ? 1 : 0);

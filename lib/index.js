/**
 * dsh-termdrive —— 让 agent 能像人一样操作交互式终端程序。
 *
 * 三件事，按重要性排序：
 *  1. **给程序一个真正的控制终端。** tmux 为每个 pane 分配 PTY，程序因此走的是
 *     人手动运行时那条路径。agent 自己的 shell 没有 TTY —— 这正是"你能跑、我跑
 *     不行"的全部原因，也是本插件的第一存在理由。
 *  2. **把 tmux 暴露成工具**，agent 不必再拼 `wsl -d ... -- bash -c "..."` 这种
 *     引号地狱，也不会因为沙箱禁止而每次都要申请提权（工具跑在宿主进程里）。
 *  3. **随包附一个 termdrive 技能** —— 真正让 agent 会用终端的是它，而不是工具本身。
 *
 * @module dsh-termdrive
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { parseFrontmatter } from './core/frontmatter.js';
import { detectTransport } from './core/tmux.js';
import { buildToolSpecs } from './tools.js';

/** Cordis 插件名。 */
export const name = 'termdrive';

/** 依赖的服务。`skills` 是可选用的。 */
export const inject = ['tools'];

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = path.join(PACKAGE_ROOT, 'assets');
const SKILL_NAMES = ['termdrive'];

/**
 * 读一个随包的 SKILL.md。
 * @param {string} directory
 * @returns {{name:string, description:string, whenToUse?:string, content:string}}
 */
function readSkill(directory) {
  const file = path.join(directory, 'SKILL.md');
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!meta.name || !meta.description) {
    throw new Error(`termdrive: ${file} 的 frontmatter 需要 name 和 description`);
  }
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content: body,
  };
}

/**
 * 公告本包随附技能的服务。
 * @returns {{name:string, list:Function, get:Function}}
 */
function createSkillProvider() {
  const candidates = SKILL_NAMES.map((skillName) => {
    const directory = path.join(SKILL_ROOT, skillName);
    const skill = readSkill(directory);
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-termdrive',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: path.join(directory, 'SKILL.md'),
      // references/ 跟着技能走：模型按需读 patterns.md，不必每轮都付这份 token。
      resourceBase: { kind: 'directory', path: directory.split(path.sep).join('/') },
    };
  });

  return {
    name: 'dsh-termdrive',
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      const skill = readSkill(path.dirname(candidate.locator));
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: skill.content };
    },
  };
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{via?:'auto'|'local'|'wsl', distro?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const transport = detectTransport(config);
  const where = transport.kind === 'wsl'
    ? `wsl${transport.distro ? `:${transport.distro}` : '(默认发行版)'}`
    : 'local';
  ctx.logger?.info?.(`termdrive: transport=${where}`);

  // 技能是可选的：拿不到 skills 服务，工具照样能用，只是手册进不了会话目录。
  //
  // 这里必须用 ctx.get(...) 的**返回值**，不能写 ctx.skills：
  // Cordis 的上下文代理对未在 inject 里声明的服务，属性访问会直接抛
  //   `cannot get property "skills" without inject`
  // （inject 只有"必需"语义，没有 optional 列表）。
  // ctx.get(name) 才是不声明也能安全读取的口子 —— 已装载成功的
  // dsh-skill-filesystem 就是这么读 fs 的（inject 里只有 skills）。
  const skills = ctx.get('skills');
  if (skills !== undefined && skills !== null) {
    skills.registerProvider(() => createSkillProvider());
  } else {
    ctx.logger?.warn?.('termdrive: 没有 skills 服务，termdrive 技能不会出现在会话目录里');
  }

  const specs = buildToolSpecs({ transport });
  for (const spec of specs) ctx.tools.register(defineTool(spec));
}

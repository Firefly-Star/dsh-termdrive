/**
 * 极简 YAML frontmatter 读取器（与 dsh-edge-cdp 一致的做法）。
 *
 * SKILL.md 的 frontmatter 只是一张扁平的字符串表，为此引入完整 YAML 解析器
 * 不值得。遇到不规则的行就跳过，而不是猜。
 */

/**
 * 解析文件开头 `---` 包围的块。
 * @param {string} raw 整个文件内容
 * @returns {{meta:Record<string,string>, body:string}}
 */
export function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error('缺少 YAML frontmatter（文件必须以 --- 开头）');
  /** @type {Record<string,string>} */
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

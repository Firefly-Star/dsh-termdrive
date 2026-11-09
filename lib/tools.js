/**
 * 面向 agent 的工具规格。
 *
 * 本模块只返回 {@link defineTool} 的普通选项对象，SDK 只在插件入口里 import。
 * 这样每个工具的主体都能脱离 Cordis 上下文单独测试。
 *
 * 两条纪律（沿用 dsh-edge-cdp 的做法）：
 *  - 工具不打印。它只返回 output.schema 承诺的那个值。
 *  - 会改变终端状态的操作（发输入、关会话）都必须指名会话，写清楚动的是谁。
 */
import * as tmux from './core/tmux.js';

const SESSION_PARAM = {
  type: 'string',
  description: `会话名，默认 ${tmux.DEFAULT_SESSION}。多个 agent 各用各的名字，互不干扰。`,
};

const TIMEOUT_PARAM = {
  type: 'integer',
  description: '超时毫秒，默认 15000。',
};

/** 把工具返回值渲染给模型：字符串原样，其余 JSON。 */
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** 工具返回的唯一内容块。 */
const renderText = (value) => [{ type: 'text', text: asText(value) }];

/**
 * 输出对象 schema；开放性显式写出来，因为这套 DSL 要求如此。
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
const out = (properties, required = []) => ({
  type: 'object',
  additionalProperties: true,
  properties: Object.fromEntries(
    Object.entries(properties).map(([key, spec]) => [key, required.includes(key) ? { ...spec, required: true } : spec])
  ),
});

/**
 * 为一个已解析的插件配置生成全部工具规格。
 *
 * @param {{ transport: ReturnType<typeof tmux.detectTransport> }} context
 * @returns {Array<Record<string, unknown>>} defineTool 的选项对象
 */
export function buildToolSpecs(context) {
  const { transport } = context;
  const sessionOf = (args) => args.session ?? tmux.DEFAULT_SESSION;

  return [
    {
      name: 'term_status',
      description: '看终端驱动的底子：tmux 在哪（本机还是 WSL 里）、什么版本、现有哪些会话。动手之前先调它。',
      parameters: {},
      output: {
        schema: out({
          transport: { type: 'string', description: 'local（本机 tmux）或 wsl（WSL 里的 tmux）' },
          distro: { type: 'string' },
          platform: { type: 'string' },
          available: { type: 'boolean' },
          version: { type: 'string' },
          sessions: { type: 'array', items: { type: 'json' } },
          note: { type: 'string' },
        }, ['transport', 'available', 'note']),
        render: (_args, value) => renderText(value),
      },
      async execute() {
        const probe = tmux.probe(transport);
        const sessions = probe.available ? tmux.listSessions(transport) : [];
        return {
          transport: transport.kind,
          distro: transport.distro ?? '(系统默认)',
          platform: process.platform,
          available: probe.available,
          version: probe.version,
          sessions,
          note: probe.available
            ? `tmux 可用（${transport.kind}${transport.distro ? `:${transport.distro}` : ''}），${sessions.length} 个会话。`
            : `tmux 不可用：${probe.error}。${transport.kind === 'wsl' ? '确认该 WSL 发行版里装了 tmux。' : ''}`,
        };
      },
    },

    {
      name: 'term_start',
      description:
        '起一个会话。默认先起存活的 shell 再把 command 敲进去 —— 这样秒崩的程序也留得住最后一屏（堆栈不会随会话消失）。' +
        '要抓的是一次性输出，就给它 command；要的是持续交互，就不给，之后用 term_send / term_key。',
      parameters: {
        session: SESSION_PARAM,
        command: { type: 'string', description: '要执行的命令。不给就只起一个 shell。' },
        cols: { type: 'integer', description: '终端宽，默认 100。TUI 排版对宽度敏感，抓帧前固定下来更可复现。' },
        rows: { type: 'integer', description: '终端高，默认 30。' },
        asPaneCommand: {
          type: 'boolean',
          description: 'true 时让 command 直接当 pane 的命令（程序退出=会话结束）。想抓崩溃现场就别开。',
        },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          session: { type: 'string' },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
          typedIntoShell: { type: 'boolean' },
          attach: { type: 'string', description: '人接入同一会话的命令' },
        }, ['session', 'attach']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const result = tmux.startSession(transport, {
          session: sessionOf(args),
          command: args.command,
          cols: args.cols,
          rows: args.rows,
          asPaneCommand: args.asPaneCommand === true,
        });
        return { ...result, attach: tmux.attachCommand(transport, result.session) };
      },
    },

    {
      name: 'term_send',
      description: '往会话里敲字面文本。enter 默认为 true（敲完回车），要模拟"只按键不回车"就设 false。',
      parameters: {
        session: SESSION_PARAM,
        text: { type: 'string', required: true, description: '要敲的文本，按字面发送，不解释成按键名。' },
        enter: { type: 'boolean', description: '敲完是否回车，默认 true。' },
      },
      output: {
        schema: out({ session: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' } }, ['session', 'text']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const session = sessionOf(args);
        const enter = args.enter !== false;
        tmux.sendLiteral(transport, session, String(args.text));
        if (enter) tmux.sendKeys(transport, session, ['Enter']);
        return { session, text: String(args.text), enter };
      },
    },

    {
      name: 'term_key',
      description:
        '发具名按键：Enter / Escape / Space / Tab / Up / Down / Left / Right / C-c / C-d / Backspace 等。' +
        '非交互程序里的"任意键继续"、TUI 的方向键都用它。',
      parameters: {
        session: SESSION_PARAM,
        keys: { type: 'array', items: { type: 'string' }, required: true, description: '按键名数组，按顺序发送。' },
      },
      output: {
        schema: out({ session: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }, ['session', 'keys']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const session = sessionOf(args);
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
        if (!keys.length) throw new Error('term_key 需要至少一个按键名。');
        tmux.sendKeys(transport, session, keys);
        return { session, keys };
      },
    },

    {
      name: 'term_screen',
      description:
        '取屏幕 —— 这是"终端的 DOM"。tmux 已经把转义序列渲染成字符网格，拿到的是人眼看到的内容，不是 \\x1b[ 字节。' +
        '定位失败先看它，别去猜程序状态。',
      parameters: {
        session: SESSION_PARAM,
        history: { type: 'integer', description: '额外带回多少行滚动缓冲（默认 0，只要当前屏）。' },
        escapes: { type: 'boolean', description: '保留颜色等转义序列，默认 false 给纯文本。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          session: { type: 'string' },
          screen: { type: 'string' },
          lines: { type: 'integer' },
        }, ['screen']),
        render: (_args, value) => renderText(value.screen),
      },
      async execute(args) {
        const session = sessionOf(args);
        const captured = tmux.captureScreen(transport, {
          session,
          history: args.history,
          escapes: args.escapes === true,
        });
        return { session, screen: captured.text, lines: captured.lines };
      },
    },

    {
      name: 'term_list',
      description: '列出所有会话及窗口尺寸。接手别人留下的会话之前先看这个。',
      parameters: {},
      output: {
        schema: out({ sessions: { type: 'array', items: { type: 'json' } } }, ['sessions']),
        render: (_args, value) => renderText(value.sessions),
      },
      async execute() {
        return { sessions: tmux.listSessions(transport) };
      },
    },

    {
      name: 'term_kill',
      description: '关掉会话。不存在也算成功（幂等）。共享会话收工前只关自己起的那个。',
      parameters: { session: SESSION_PARAM },
      output: {
        schema: out({ session: { type: 'string' }, killed: { type: 'boolean' } }, ['session', 'killed']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        return tmux.killSession(transport, sessionOf(args));
      },
    },

    {
      name: 'term_attach',
      description:
        '返回人接入**同一个**会话的命令（不是副本）。需要用户亲手输入口令、扫码、做二次确认，或只是想让他看着你操作时用它，' +
        '然后停手等用户回话。',
      parameters: { session: SESSION_PARAM },
      output: {
        schema: out({ session: { type: 'string' }, attach: { type: 'string' } }, ['session', 'attach']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const session = sessionOf(args);
        return { session, attach: tmux.attachCommand(transport, session) };
      },
    },
  ];
}

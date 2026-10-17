/**
 * dsh-profile-stylist —— 写入层 + 宿主入口。
 *
 * 一句话：**你说要什么样的人设，它写出来并把资料页填好** ——
 * 文案交给宿主的模型服务生成，头像从你的素材库里挑（或按名字合成），
 * 然后走浏览器把这些写进你自己的账号。
 *
 * 三条刻意的默认值：
 *   1. **默认 dry-run**：`profile_apply` 不传 `confirm: true` 就只做体检+展示，**不碰任何站点**；
 *   2. **只写资料**：档案里没有密码/邮箱/安全设置，插件也不会去点；
 *   3. **写前摊开**：要写什么、写到哪个站、用的是哪张图，提交前整份给人的眼睛过一遍。
 *
 * @module dsh-profile-stylist
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AVATAR_SPEC,
  DEFAULTS,
  FIELDS,
  PLUGIN_NAME,
} from './constants.js';
import { draftProfile, ensureAssetDir, listAvatarAssets, llmOf, readImageBase64, renderDraft } from './author.js';
import { checkAgainstHost, describeHost, hostProfile, listHosts, normalizeHost } from './hosts.js';
import { AVATAR_SIZE, AVATAR_TEMPLATES, buildComposeScript, decodePngDataUrl, normalizeTemplate, paletteFor, pickInitials } from './compose.js';

/** 插件身份。 */
export const name = PLUGIN_NAME;

/** 需要宿主注入的服务（browser / llm 用 ctx.get 拿，拿不到给明确错误）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 215;
const TOOL_TIMEOUT_MS = 180000;

/** 素材库目录：放在用户的 .dsh 下（用户自己能往里放图）。 */
const ASSET_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', PLUGIN_NAME, 'assets', 'avatars');

/** 面向模型的公告。 */
export const PROFILE_STYLIST_GUIDANCE = [
  '本机已安装 **dsh-profile-stylist（个人资料配置）**：你说"我想要个什么样的个人主页"，它把文案写出来并把资料页填好。',
  '工具：`profile_author`（按需求**生成草稿**：昵称/简介/标语/所在地/链接 + 头像建议，**不写任何站点**）、`profile_apply`（体检 + 写入；**默认 dry-run，只有 `confirm:true` 才真的动站点**）、`profile_assets`（看素材库里有哪些图）。',
  '内置站点档案：GitHub（选择器已真机验证，含头像上传：`#avatar_upload` + DataTransfer + 「Set new profile picture」）、Gitee（选择器**未实测**）。',
  '**素材从哪来**：本机没有图像生成服务 —— 头像只有三条来源：① 素材库（`%USERPROFILE%\\.dsh\\dsh-profile-stylist\\assets\\avatars`，用户自己往里放图）；② 用户指定的本地图片路径；③ 页面内 canvas 合成（把名字/标语画进图，零外部依赖）。',
  '**红线（硬编码在档案里）**：只写资料字段，**不碰密码、邮箱、安全设置、支付**；写入前会把"要写什么、写到哪"整份摊开；不认识的站点直接拒绝，不猜选择器。',
  '典型流程：`profile_author wish:"…" host:"github"` → 用户看一眼草稿 → `profile_apply draft:{…} confirm:true`。',
].join('\n');

/** 动态取 defineTool（宿主里用真的，单测退化成恒等）。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 取浏览器服务（拿不到就是 null，不抛）。
 * @param {object} ctx
 * @returns {object|null}
 */
export function browserOf(ctx) {
  try {
    const browser = typeof ctx?.get === 'function' ? ctx.get('browser') : undefined;
    if (browser && typeof browser.open === 'function' && typeof browser.execute === 'function') return browser;
  } catch {
    /* 没有浏览器插件 */
  }
  return null;
}

/**
 * 生成页面侧的"填资料 + 装头像"脚本。
 *
 * 设计要点：
 *   · 头像字节随参数**以 data URL 形式**带进页面（本机没有别的通道）；
 *   · 仍然走已验证的 `File → DataTransfer → input.files → change` 路径交给站点自己的 JS；
 *   · 所有结果都回报，**不许静默失败**。
 *
 * @returns {string} 可 execute 的表达式
 */
export function buildWriterScript() {
  return `(async function () {
  try {
    var req = window.__dshStylistReq || {};
    var host = req.host || {};
    var fields = req.fields || {};
    var out = { ok: true, filled: [], missing: [], warnings: [], avatar: null };
    var F = host.fields || {};

    // ---------- 1) 文本字段 ----------
    for (var key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      var sel = F[key];
      if (!sel) { out.missing.push(key); continue; }
      var el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el) { out.missing.push(key); continue; }
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, fields[key]); else el.value = fields[key];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        out.filled.push(key);
      } else {
        // contenteditable
        el.textContent = fields[key];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        out.filled.push(key);
      }
    }

    // ---------- 2) 头像 ----------
    var av = host.avatar || {};
    if (req.avatarDataUrl && av.input) {
      var menu = av.menu ? document.querySelector(av.menu) : null;
      if (menu) { try { menu.click(); } catch (e) {} }
      var box = av.container ? document.querySelector(av.container) : null;
      var input = document.querySelector(av.input);
      if (!input) {
        out.avatar = { ok: false, reason: '页面里没有头像控件（' + av.input + '）' };
      } else {
        var blob = await fetch(req.avatarDataUrl).then(function (r) { return r.blob(); });
        var file = new File([blob], req.avatarName || 'avatar.png', { type: blob.type || 'image/png' });
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // 等站点自己把图传上去（出现确认按钮即为就绪）
        var ready = false;
        for (var i = 0; i < 30; i++) {
          await new Promise(function (r) { setTimeout(r, 1000); });
          var texts = av.confirmText || [];
          var buttons = [].slice.call(document.querySelectorAll('button, input[type=submit]'));
          var hit = null;
          for (var b = 0; b < buttons.length; b++) {
            var t = (buttons[b].textContent || buttons[b].value || '').trim();
            for (var c = 0; c < texts.length; c++) { if (t.indexOf(texts[c]) >= 0) { hit = buttons[b]; break; } }
            if (hit) break;
          }
          if (!hit && box && /has-uploaded|is-uploaded/.test(box.className || '')) hit = 'state';
          if (hit) {
            if (hit !== 'state') { try { hit.click(); } catch (e) {} }
            ready = true;
            break;
          }
        }
        out.avatar = { ok: ready, bytes: file.size, confirmed: ready };
        if (!ready) out.warnings.push('头像传上去了但没等到确认按钮（可能站点改版或网络慢）');
      }
    }

    // ---------- 3) 文本保存 ----------
    if (req.save !== false && out.filled.length > 0) {
      var savers = (host.form && host.form.save) || [];
      for (var s = 0; s < savers.length; s++) {
        var btn = null;
        try { btn = document.querySelector(savers[s]); } catch (e) { btn = null; }
        if (btn) { try { btn.click(); out.saved = true; break; } catch (e) {} }
      }
      if (!out.saved) out.warnings.push('没找到保存按钮 —— 字段已填好，请手动点保存');
    }

    delete window.__dshStylistReq;
    return JSON.stringify(out);
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})()`;
}

/**
 * 组装一次"体检/写入"的结果（纯函数，便于单测）。
 * @param {{host:string, fields:Record<string,string>, avatar:object|null}} plan
 * @returns {{host:string, profile:object|null, check:object, avatar:object|null, summary:string}}
 */
export function planApply(plan) {
  const key = normalizeHost(plan.host);
  const profile = key === null ? null : hostProfile(key);
  const check = checkAgainstHost(plan.host, plan.fields ?? {});
  const lines = [
    profile ? `站点：${profile.name}（${profile.verified ? '选择器已实测' : '选择器未实测'}）` : `站点：${plan.host}（不认识的站点）`,
    `要写：`,
    renderDraft(check.supported, check.warnings),
  ];
  if (plan.avatar) lines.push(`头像：${plan.avatar.label}`);
  if (check.unsupported.length > 0) lines.push(`⚠ 这些字段这个站点写不了：${check.unsupported.join('、')}`);
  return { host: key ?? plan.host, profile, check, avatar: plan.avatar ?? null, summary: lines.join('\n') };
}

/** 把一次写入的结果压成给模型看的话。 */
function renderApplyText(value) {
  if (value.ok === false) return `profile_apply 失败：${String(value.error ?? '未知错误')}`;
  const lines = [];
  if (value.mode === 'dry-run') {
    lines.push('🧪 profile_apply｜**dry-run（什么都没动）**');
  } else {
    lines.push('🖋️ profile_apply｜已写入');
  }
  lines.push(value.summary);
  if (Array.isArray(value.result?.missing) && value.result.missing.length > 0) {
    lines.push(`  页面上没找到这些字段：${value.result.missing.join('、')}`);
  }
  if (value.result?.avatar) {
    lines.push(`  头像：${value.result.avatar.ok ? '✅ 已上传并确认' : '⚠ ' + (value.result.avatar.reason ?? '未确认')}`);
  }
  for (const warning of value.result?.warnings ?? []) lines.push(`  ⚠ ${warning}`);
  if (value.hint) lines.push(`  ${value.hint}`);
  return lines.join('\n');
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{announceToAgent?:boolean,enabled?:boolean,assetDir?:string}} [config]
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const assetDir = typeof cfg.assetDir === 'string' && cfg.assetDir !== '' ? cfg.assetDir : ASSET_DIR;
  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    // ---------- ① 素材 ----------
    disposers.push(ctx.tools.register(defineTool({
      name: 'profile_assets',
      description: [
        '看个人资料插件能用的头像素材：素材库目录、有哪些图（名字/体积）。',
        '素材库目录固定为 `${USERPROFILE}\\.dsh\\dsh-profile-stylist\\assets\\avatars` —— 往里丢图就能用。',
        '本机没有图像生成服务，所以头像只有三条来源：素材库 / 用户给的本地路径 / 页面内 canvas 合成。',
      ].join('\n'),
      timeoutMs: 30000,
      parameters: {
        target: { type: 'string', description: '可选：只查某个目标站点能用什么（github / gitee），用于回显字段能力' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            dir: { type: 'string' },
            created: { type: 'boolean' },
            count: { type: 'number' },
            assets: { type: 'json' },
            hosts: { type: 'json' },
            hint: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === false) return [{ type: 'text', text: `profile_assets 失败：${String(value.error)}` }];
          const rows = (value.assets ?? []).map((a) => `  · ${a.file}（${Math.round(a.bytes / 1024)}KB）`);
          const hosts = (value.hosts ?? []).map((h) => `  · ${h.key} — ${h.name}${h.verified ? '' : '（选择器未实测）'}`);
          const lines = [
            `🖼️ 素材库：${value.dir}${value.created ? '（刚建好）' : ''}`,
            rows.length > 0 ? rows.join('\n') : '  （空的 —— 往里放 png/jpg 就能用）',
            '可写站点：',
            hosts.join('\n'),
          ];
          if (value.hint) lines.push(`  ${value.hint}`);
          return [{
            type: 'text',
            text: lines.join('\n'),
          }];
        },
      },
      async execute(args) {
        try {
          const info = await ensureAssetDir(assetDir);
          const assets = await listAvatarAssets(assetDir);
          const hosts = listHosts();
          const out = { ok: true, dir: info.dir, created: info.created, count: assets.length, assets, hosts };
          if (typeof args?.target === 'string' && args.target !== '') out.hint = describeHost(args.target);
          return out;
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    })));

    // ---------- ② 生成草稿 ----------
    disposers.push(ctx.tools.register(defineTool({
      name: 'profile_author',
      description: [
        '按"你想要什么样的个人主页"生成一份资料草稿：昵称 / 简介 / 标语 / 所在地 / 链接，**只出草稿，不写任何站点**。',
        '文案由宿主的模型服务生成（插件不持有任何 API key）；写不出的字段它宁可不写，也不编。',
        '头像另说：本机没有图像生成服务，头像要么从素材库挑（profile_assets 看清单），要么给一个本地图片路径。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        wish: { type: 'string', description: '必填：你想要什么样的资料（一句话，比如"一个给主人打工的 AI 小助手，可爱但专业"）' },
        host: { type: 'string', description: '站点（github 默认 / gitee）—— 影响字数上限与可写字段' },
        current: { type: 'string', description: '可选：当前资料的 JSON 字符串（可沿用可改写）' },
        maxFields: { type: 'number', description: `可选：最多写几个字段（默认 ${DEFAULTS.maxFields}）` },
        provider: { type: 'string', description: '可选：覆盖模型 provider' },
        model: { type: 'string', description: '可选：覆盖模型' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            host: { type: 'string' },
            fields: { type: 'json' },
            notes: { type: 'json' },
            preview: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === false) return [{ type: 'text', text: `profile_author 失败：${String(value.error)}` }];
          return [{
            type: 'text',
            text: [
              `✍️ 草稿（${value.host}）—— 还没写任何站点：`,
              value.preview,
              '下一步：确认文案后调 `profile_apply`（**默认 dry-run**，加 `confirm:true` 才真的写）。',
            ].join('\n'),
          }];
        },
      },
      async execute(args) {
        const host = normalizeHost(args?.host) ?? 'github';
        try {
          const llm = llmOf(ctx);
          let current = undefined;
          if (typeof args?.current === 'string' && args.current.trim() !== '') {
            try {
              current = JSON.parse(args.current);
            } catch {
              current = { note: args.current };
            }
          }
          const draft = await draftProfile(ctx, llm, {
            wish: args?.wish,
            host,
            current,
            maxFields: args?.maxFields,
            provider: args?.provider,
            model: args?.model,
          });
          return {
            ok: true,
            host,
            fields: draft.fields,
            notes: draft.notes,
            preview: renderDraft(draft.fields, draft.notes),
          };
        } catch (error) {
          return { ok: false, host, error: error instanceof Error ? error.message : String(error) };
        }
      },
    })));

    // ---------- ③ 写入（默认 dry-run） ----------
    disposers.push(ctx.tools.register(defineTool({
      name: 'profile_apply',
      description: [
        '把一份资料草稿写进你自己的账号（内置档案：GitHub / Gitee，两份选择器都已在真机核对过）。',
        '**默认 dry-run**：不传 `confirm: true` 就只做体检 + 展示"要写什么、写到哪"，**不打开页面、不点任何按钮**。',
        '`confirm: true` 才会真的打开资料页填字段、并把头像交给站点的上传控件（仍然由站点自己的 JS 完成入库）。',
        `头像四选一：\`avatarPath\`（本地图片）/ \`avatarFromAssets\`（素材库里的文件名）/ \`avatarTemplate\`（**页面里 canvas 当场合成**：${Object.entries(AVATAR_TEMPLATES).map(([k, v]) => `${k}=${v.label}`).join('、')}）/ 都不给则不换头像。`,
        '**红线**：只写资料字段，不碰密码/邮箱/安全设置/支付。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        fields: { type: 'string', description: '必填：要写的字段，JSON 字符串（如 {"name":"大肥鱼","bio":"…"}）' },
        host: { type: 'string', description: '站点（github 默认 / gitee）' },
        avatarPath: { type: 'string', description: '可选：本地头像图片的绝对路径' },
        avatarFromAssets: { type: 'string', description: '可选：素材库里的文件名（配合 profile_assets 使用）' },
        avatarTemplate: { type: 'string', description: `可选：没有素材图时当场合成一张 —— ${Object.keys(AVATAR_TEMPLATES).join(' / ')}（initials 纯色底+首字 / gradient 渐变底+首字 / tagline 深色底+名字+标语）` },
        avatarTagline: { type: 'string', description: '可选：tagline 模板里的那行标语（一句短话）' },
        avatarText: { type: 'string', description: '可选：合成头像用的名字（默认取 fields.name）' },
        confirm: { type: 'boolean', description: '**必须显式 true 才真的写入**；不传或 false = dry-run' },
        session: { type: 'string', description: '可选：复用哪个浏览器会话键（默认用插件自己的）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            mode: { type: 'string' },
            host: { type: 'string' },
            summary: { type: 'string' },
            result: { type: 'json' },
            hint: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderApplyText(value) }],
      },
      async execute(args) {
        // ---- 解析字段 ----
        let fields = {};
        try {
          fields = typeof args?.fields === 'string' ? JSON.parse(args.fields) : (args?.fields ?? {});
        } catch {
          return { ok: false, mode: 'dry-run', host: 'github', summary: '', error: 'fields 不是合法 JSON' };
        }
        if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
          return { ok: false, mode: 'dry-run', host: 'github', summary: '', error: 'fields 必须是对象' };
        }

        // ---- 头像（先只定位，不读内容） ----
        let avatar = null;
        let composeRequest = null;
        if (typeof args?.avatarTemplate === 'string' && args.avatarTemplate !== '') {
          const template = normalizeTemplate(args.avatarTemplate);
          if (template === null) {
            return { ok: false, mode: 'dry-run', host: 'github', summary: '', error: `avatarTemplate 只能是 ${Object.keys(AVATAR_TEMPLATES).join(' / ')}` };
          }
          const nameText = String(fields.name ?? args?.avatarText ?? '').trim();
          if (AVATAR_TEMPLATES[template].needTagline && nameText === '') {
            return { ok: false, mode: 'dry-run', host: 'github', summary: '', error: `${template} 模板需要名字（fields.name 或 avatarText）` };
          }
          composeRequest = {
            template,
            name: nameText === '' ? '?' : nameText,
            initials: pickInitials(nameText),
            tagline: typeof args?.avatarTagline === 'string' ? args.avatarTagline : '',
            palette: paletteFor(nameText),
            size: AVATAR_SIZE,
          };
          avatar = { kind: 'composed', template, label: `合成头像（${AVATAR_TEMPLATES[template].label}）` };
        } else if (typeof args?.avatarPath === 'string' && args.avatarPath !== '') {
          avatar = { kind: 'file', path: args.avatarPath, label: args.avatarPath };
        } else if (typeof args?.avatarFromAssets === 'string' && args.avatarFromAssets !== '') {
          avatar = { kind: 'asset', file: args.avatarFromAssets, label: `素材库：${args.avatarFromAssets}` };
        }

        const plan = planApply({ host: args?.host ?? 'github', fields, avatar });
        const dryRun = args?.confirm !== true;

        if (dryRun) {
          return {
            ok: true,
            mode: 'dry-run',
            host: plan.host,
            summary: plan.summary,
            hint: '这是 dry-run —— 什么都没动。确认无误后加 `confirm: true` 再调一次。',
          };
        }

        // ---- 真写 ----
        if (plan.profile === null) {
          return { ok: false, mode: 'apply', host: plan.host, summary: plan.summary, error: `不认识的站点：${args?.host}（内置只有 ${listHosts().map((h) => h.key).join(' / ')}）` };
        }
        const browser = browserOf(ctx);
        if (!browser) {
          return { ok: false, mode: 'apply', host: plan.host, summary: plan.summary, error: '没有可用的浏览器服务（ctx.get("browser") 为空）' };
        }

        try {
          const sessionKey = typeof args?.session === 'string' && args.session !== '' ? args.session : PLUGIN_NAME;
          const session = await browser.open(sessionKey);

          // 头像：要么读成 data URL（页面侧靠它装配成 File），要么**当场画一张**。
          let avatarDataUrl = null;
          let avatarName = null;
          if (composeRequest !== null) {
            await browser.execute(session, {
              script: `window.__dshComposeReq = ${JSON.stringify(composeRequest)}; true`,
              timeoutMs: 10000,
            });
            const drawn = await browser.execute(session, { script: buildComposeScript(), timeoutMs: 20000 });
            let payload = null;
            try {
              payload = typeof drawn?.value === 'string' ? JSON.parse(drawn.value) : drawn?.value ?? null;
            } catch {
              payload = null;
            }
            if (payload?.ok !== true || typeof payload.dataUrl !== 'string') {
              throw new Error(`合成头像失败：${String(payload?.error ?? '页面没有返回图片')}`);
            }
            const decoded = decodePngDataUrl(payload.dataUrl);
            if (decoded.ok !== true) throw new Error(`合成头像失败：${decoded.error}`);
            avatarDataUrl = payload.dataUrl;
            avatarName = `composed-${composeRequest.template}.png`;
            avatar = { ...avatar, bytes: decoded.bytes, label: `${avatar.label}（${Math.round(decoded.bytes / 1024)}KB）` };
          } else if (avatar !== null) {
            const source = avatar.kind === 'file' ? avatar.path : join(assetDir, avatar.file);
            const image = await readImageBase64(source);
            avatarDataUrl = `data:${image.mime};base64,${image.base64}`;
            avatarName = image.file;
            avatar = { ...avatar, bytes: image.bytes, label: `${avatar.label}（${Math.round(image.bytes / 1024)}KB）` };
          }
          if (avatar !== null) {
            plan.avatar = avatar;
            plan.summary = planApply({ host: plan.host, fields: plan.check.supported, avatar }).summary;
          }

          await browser.openUrl(session, { url: plan.profile.profileUrl });

          const script = buildWriterScript();
          const request = {
            host: {
              fields: plan.profile.fields,
              form: plan.profile.form,
              avatar: plan.profile.avatar,
            },
            fields: plan.check.supported,
            avatarDataUrl,
            avatarName,
          };
          const executed = await browser.execute(session, {
            script: `window.__dshStylistReq = ${JSON.stringify(request)}; true`,
            timeoutMs: 20000,
          });
          if (executed && executed.ok === false) throw new Error('页面注入失败：' + String(executed.exception ?? ''));

          const written = await browser.execute(session, { script, timeoutMs: 90000 });
          if (written && written.ok === false) throw new Error('写入脚本失败：' + String(written.exception ?? ''));
          let result = null;
          try {
            result = typeof written?.value === 'string' ? JSON.parse(written.value) : written?.value ?? null;
          } catch {
            result = { ok: false, error: '页面没有回报可解析的结果' };
          }
          if (result && result.ok === false) throw new Error('页面侧报错：' + String(result.error ?? 'unknown'));
          return { ok: true, mode: 'apply', host: plan.host, summary: plan.summary, result };
        } catch (error) {
          return { ok: false, mode: 'apply', host: plan.host, summary: plan.summary, error: error instanceof Error ? error.message : String(error) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:profile-stylist',
      order: SECTION_ORDER,
      text: PROFILE_STYLIST_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-profile-stylist: teardown');
  }
}

/** 供测试直接使用。 */
export { ASSET_DIR, renderApplyText };

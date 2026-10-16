/**
 * dsh-profile-stylist —— 常量与纯工具（无 DOM、无网络、无 ctx，可单测）。
 *
 * @module dsh-profile-stylist/constants
 */

/** 插件名。 */
export const PLUGIN_NAME = 'dsh-profile-stylist';

/** 头像素材目录（放在用户的 .dsh 下，插件与用户都能往里放图）。 */
export const ASSET_DIR_HINT = '%USERPROFILE%\\.dsh\\dsh-profile-stylist\\assets\\avatars';

/** 头像目标规格：GitHub/Gitee 展示都在 460px 以内，512 足够且体积可控。 */
export const AVATAR_SPEC = Object.freeze({
  width: 512,
  height: 512,
  /** 编码成 JPEG 的质量（照片素材用）—— PNG 素材会尽量保留 PNG。 */
  jpegQuality: 88,
  /** 允许的最大输入体积（超过就先本地缩放）。 */
  maxSourceBytes: 12 * 1024 * 1024,
});

/** 文案字段（哪些能写、写到哪）。 */
export const FIELDS = Object.freeze({
  name: '昵称 / 显示名',
  bio: '一句话简介',
  company: '公司 / 组织',
  location: '所在地',
  blog: '主页 / 博客链接',
  social: '社交链接',
  tagline: '标语（写进简介的开头）',
});

/** 写站点的默认行为：默认只出草稿。 */
export const DEFAULTS = Object.freeze({
  /** 默认不落盘：只生成 + 展示将写入什么。 */
  apply: false,
  /** 文案语言（跟用户说话的语言）。 */
  lang: 'zh',
  /** 单次生成的字段上限（避免模型跑飞）。 */
  maxFields: 6,
  /** 文本生成的 token 上限。 */
  maxTokens: 1200,
  /** 模型调用超时（毫秒）。 */
  llmTimeoutMs: 45000,
});

/** 站点档案名（内置的适配档案）。 */
export const HOSTS = Object.freeze({
  github: 'github',
  gitee: 'gitee',
});

/** 头像的三条来源。 */
export const AVATAR_SOURCES = Object.freeze({
  library: '本地素材库（.dsh/dsh-profile-stylist/assets/avatars 下的图）',
  file: '用户指定的本地图片路径',
  compose: '页面内合成（把名字/标语画进一张图，零外部依赖）',
});

/**
 * 把任意文本压成单行（生成结果里常带换行，落进表单要单行）。
 * @param {string} text
 * @returns {string}
 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 按站点上限截断文本（GitHub bio 上限 160 字符）。
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clampText(text, limit) {
  const value = oneLine(text);
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

/**
 * 校验一个网址（只允许 http/https）。
 * @param {string} url
 * @returns {string} 合法则返回原值，否则返回空串
 */
export function safeUrl(url) {
  const value = String(url ?? '').trim();
  if (value === '') return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return value;
  } catch {
    return '';
  }
}

/**
 * 从模型回复里挖出 JSON 对象（可能与 dsh-inpage-translator 同源的容错）。
 * @param {string} raw
 * @returns {object|null}
 */
export function extractJsonObject(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const direct = tryParse(text);
  if (direct) return direct;
  const braced = firstBalancedObject(text);
  if (braced) return tryParse(braced);
  return null;
}

/**
 * 把模型给的自由文本收敛成一份可写的草稿（缺的字段不编）。
 * @param {object} parsed
 * @param {{maxFields?:number, limits?:Record<string,number>}} [options]
 * @returns {{fields:Record<string,string>, notes:string[]}}
 */
export function normalizeDraft(parsed, options = {}) {
  const limits = options.limits ?? {};
  const maxFields = Number(options.maxFields) || DEFAULTS.maxFields;
  const fields = {};
  const notes = [];
  if (!parsed || typeof parsed !== 'object') return { fields, notes: ['模型没有给出可用对象'] };
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) continue;
    if (typeof value !== 'string') continue;
    const text = clampText(value, limits[key]);
    if (text === '') continue;
    fields[key] = text;
    if (Object.keys(fields).length >= maxFields) break;
  }
  const rawBio = oneLine(parsed.bio ?? '');
  if (rawBio && limits.bio && rawBio.length > limits.bio) {
    notes.push(`简介被截到 ${limits.bio} 字（原 ${rawBio.length} 字）`);
  }
  return { fields, notes };
}

/** 内部：JSON.parse 容错。 */
function tryParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 内部：找第一段括号平衡的 {...}（跳过字符串里的括号）。 */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

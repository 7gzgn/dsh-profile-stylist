/**
 * dsh-profile-stylist —— 生成层：**写什么**。
 *
 * 两件事：
 *   ① 文案（昵称/简介/标语/所在地…）—— 交给宿主的 LLM 服务（插件不持有任何 API key）；
 *   ② 头像 —— 本机没有图像生成服务，所以走三条**看得见摸得着**的来源：
 *      · 本地素材库（用户自己的图 + 插件预置素材）
 *      · 用户指定的本地图片路径
 *      · 页面内 canvas 合成（把名字/标语画进图里，零外部依赖）
 * 所有素材都要经过**统一规格化**（缩放居中 + 体积可控），避免把 5MB 的原图直接喂给站点。
 *
 * @module dsh-profile-stylist/author
 */

import { readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

import { AVATAR_SPEC, DEFAULTS, FIELDS, clampText, extractJsonObject, normalizeDraft, oneLine, safeUrl } from './constants.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * 取宿主 LLM 服务（拿不到就给一句能读懂的话）。
 * @param {object} ctx
 * @returns {object}
 */
export function llmOf(ctx) {
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (llm === null || llm === undefined) {
    const error = new Error('宿主没有提供 LLM 服务（ctx.get("llm") 为空），无法生成文案');
    error.code = 'llm-unavailable';
    throw error;
  }
  return llm;
}

/**
 * 解析这次该用哪个 provider/model 路线。
 *
 * 三种来源，按优先级：
 *   ① 调用方显式给的 `provider`/`model`；
 *   ② 宿主的默认模型选择（settings 命名空间 `agent-default-model`，服务名
 *      `ctx.get('agentDefaultModel')` → `currentSelection()`）；
 *   ③ 都没有 → **明确报错**，绝不瞎猜 provider
 *      （否则会撞上 `no adapter registered for provider "undefined"`）。
 *
 * @param {object} ctx
 * @param {{provider?:string,model?:string}} [request]
 * @returns {{provider:string,model:string,source:string}}
 */
export function resolveRoute(ctx, request = {}) {
  const explicitProvider = typeof request.provider === 'string' ? request.provider.trim() : '';
  const explicitModel = typeof request.model === 'string' ? request.model.trim() : '';
  if (explicitProvider !== '' && explicitModel !== '') {
    return { provider: explicitProvider, model: explicitModel, source: 'explicit' };
  }
  let selection = null;
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    if (service && typeof service.currentSelection === 'function') selection = service.currentSelection();
  } catch {
    selection = null;
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  if (provider !== '' && model !== '') return { provider, model, source: 'agent-default-model' };
  const error = new Error(
    '解析不出要用的模型：调用方没给 provider/model，宿主也没暴露默认模型（ctx.get("agentDefaultModel")）—— 请显式传 provider 与 model',
  );
  error.code = 'no-model-route';
  throw error;
}

/**
 * 调一次模型，拿回纯文本。
 * 调用形状与宿主里已验证的先例一致：resolveCallConfig → prepareCall → stream。
 * @param {object} llm
 * @param {{system:string,user:string,maxTokens?:number,timeoutMs?:number,route:{provider:string,model:string}}} request
 * @returns {Promise<string>}
 */
export async function generateText(llm, request) {
  if (typeof llm.resolveCallConfig !== 'function') {
    const error = new Error('宿主 LLM 服务缺少 resolveCallConfig —— 版本不兼容');
    error.code = 'llm-incompatible';
    throw error;
  }
  const route = request?.route;
  if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string' || route.provider === '' || route.model === '') {
    const error = new Error('generateText 需要一条已解析的模型路线（route.provider / route.model）');
    error.code = 'no-model-route';
    throw error;
  }
  const requested = { maxTokens: Number(request.maxTokens) || DEFAULTS.maxTokens, provider: route.provider, model: route.model };
  const base = await llm.resolveCallConfig(requested);
  const prepared = typeof llm.prepareCall === 'function' ? await llm.prepareCall(base) : { stream: (r) => llm.stream(r) };

  const timeoutMs = Number(request.timeoutMs) || DEFAULTS.llmTimeoutMs;
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  let text = '';
  let failure = null;
  for await (const chunk of prepared.stream({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    system: request.system,
    ...(signal ? { signal } : {}),
  })) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure ?? chunk.reason;
  }
  text = text.trim();
  if (text === '' && failure) throw new Error('模型调用失败：' + (failure.message ?? JSON.stringify(failure)));
  return text;
}

/**
 * 让模型按"用户需求"写一份资料草稿（**只出草稿，不写任何站点**）。
 *
 * @param {object} ctx 宿主上下文（用来解析默认模型路线）
 * @param {object} llm 宿主 LLM 服务
 * @param {{wish:string, host?:string, lang?:string, current?:object, maxFields?:number, provider?:string, model?:string}} request
 * @returns {Promise<{fields:Record<string,string>, notes:string[], raw:string, route:object}>}
 */
export async function draftProfile(ctx, llm, request) {
  const wish = oneLine(request?.wish ?? '');
  if (wish === '') throw new Error('profile_author 需要一句"你想要什么样的资料"（wish）');
  const host = request?.host ?? 'github';
  const limits = hostSummary(host)?.limits ?? {};
  const current = request?.current && typeof request.current === 'object' ? request.current : null;

  const system = [
    '你是个人主页文案助手。按用户描述，写一份**真实、克制、不浮夸**的资料。',
    '规则：',
    '1. 只输出一个 JSON 对象，键只能从这些里选：' + Object.keys(FIELDS).join('、') + '。',
    '2. 写不出的键就别写，**不许编造**（没有公司就别编公司，没有博客就别编网址）。',
    `3. 简介（bio）必须 ≤ ${limits.bio ?? 160} 字符，单行，不换行，不用引号包裹。`,
    '4. 昵称（name）≤ 40 字符；标语（tagline）≤ 40 字符，风格与简介一致。',
    '5. 语言跟用户描述的语言一致（中文描述就写中文）。',
    '6. 不要 markdown、不要代码块、不要解释，只给 JSON。',
  ].join('\n');
  const user = [
    `站点：${host}`,
    `用户需求：${wish}`,
    current ? `当前资料（可沿用可改写）：${JSON.stringify(current)}` : '',
  ].filter(Boolean).join('\n');

  const route = resolveRoute(ctx, { provider: request?.provider, model: request?.model });
  const raw = await generateText(llm, {
    system,
    user,
    route,
    maxTokens: request?.maxTokens,
    timeoutMs: request?.timeoutMs,
  });
  const parsed = extractJsonObject(raw);
  const { fields, notes } = normalizeDraft(parsed ?? {}, { limits, maxFields: request?.maxFields });
  if (Object.keys(fields).length === 0) notes.push('模型没给出可用字段（原文已附在 raw 里）');

  // 网址字段做一次安全校验（只收 http/https）
  if (fields.blog) {
    const checked = safeUrl(fields.blog);
    if (checked === '') {
      delete fields.blog;
      notes.push('模型给的博客地址不合法，已丢弃（不写进任何站点）');
    } else fields.blog = checked;
  }
  return { fields, notes, raw, route };
}

/**
 * 站点档案的简要说明（给模型与回执用）。
 * @param {string} host
 * @returns {{name:string,limits:Record<string,number>}|null}
 */
export function hostSummary(host) {
  const table = {
    github: { name: 'GitHub 个人资料', limits: { name: 40, bio: 160, company: 40, location: 40, blog: 120, social: 120, tagline: 40 } },
    gitee: { name: 'Gitee 个人资料（部分字段名未实测，谨慎）', limits: { name: 40, bio: 160, company: 40, location: 40, blog: 120, social: 120, tagline: 40 } },
  };
  return table[host] ?? null;
}

/**
 * 列出本地素材库里能用的图（只读）。
 * @param {string} dir
 * @returns {Promise<Array<{file:string,path:string,bytes:number}>>}
 */
export async function listAvatarAssets(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue;
      const path = join(dir, entry.name);
      const info = await stat(path);
      out.push({ file: basename(entry.name), path, bytes: info.size });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

/**
 * 确保素材库存在（不存在就建空目录 —— 不替用户塞图）。
 * @param {string} dir
 * @returns {Promise<{dir:string,created:boolean,count:number}>}
 */
export async function ensureAssetDir(dir) {
  let created = false;
  try {
    await stat(dir);
  } catch {
    await mkdir(dir, { recursive: true });
    created = true;
  }
  const assets = await listAvatarAssets(dir);
  return { dir, created, count: assets.length };
}

/**
 * 把一张本地图片读成 base64（供页面侧装配成 File）。
 * 只读、只在本机内存里过一道；调用方负责体积上限。
 * @param {string} path
 * @returns {Promise<{base64:string,mime:string,bytes:number,file:string}>}
 */
export async function readImageBase64(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('不是文件：' + path);
  if (info.size > AVATAR_SPEC.maxSourceBytes) {
    throw new Error(`图片太大（${info.size} 字节 > ${AVATAR_SPEC.maxSourceBytes}）—— 请先自己缩一下再放进素材库`);
  }
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error('不支持的图片格式：' + ext);
  const buf = await readFile(path);
  const mime = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
        : 'image/jpeg';
  return { base64: buf.toString('base64'), mime, bytes: buf.length, file: basename(path) };
}

/**
 * 汇总一次"要写什么"的草稿回执（给人和模型看）。
 * @param {Record<string,string>} fields
 * @param {string[]} notes
 * @returns {string}
 */
export function renderDraft(fields, notes = []) {
  const lines = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    lines.push(`  · ${FIELDS[key] ?? key}：${value}`);
  }
  if (lines.length === 0) lines.push('  （没有可写字段）');
  if (notes.length > 0) {
    lines.push('  注意：');
    for (const note of notes) lines.push(`    - ${note}`);
  }
  return lines.join('\n');
}

/** 供测试与调用方复用的截断包装。 */
export { clampText };

/**
 * dsh-profile-stylist · compose —— 没有素材图时，**在页面里用 canvas 画一张头像**。
 *
 * 为什么在页面里画：本机没有图像生成服务，宿主进程里也没有 canvas。
 * 但浏览器**本来就在**（插件借 ctx.browser 工作），页面里的 canvas 是零依赖的绘图板。
 * 画完 `toDataURL('image/png')` 拿回 base64，就和"用户给了一张图"走同一条上传路径。
 *
 * 三个模板（都是 460×460 方图，社交平台的头像框都是圆的，所以内容留在内切圆里）：
 *   - `initials`：纯色底 + 名字首字（最稳，永远好看）；
 *   - `gradient`：双色渐变底 + 首字；
 *   - `tagline`：深色底 + 名字 + 一行标语（适合当"名片头像"）。
 *
 * @module dsh-profile-stylist/compose
 */

/** 可用的合成模板。 */
export const AVATAR_TEMPLATES = Object.freeze({
  initials: { label: '纯色底 + 名字首字', needTagline: false },
  gradient: { label: '渐变底 + 名字首字', needTagline: false },
  tagline: { label: '深色底 + 名字 + 标语', needTagline: true },
});

/** 画布边长（px）。 */
export const AVATAR_SIZE = 460;

/**
 * 取名字的"首字"：中文取第一个字，英文取首字母（最多两个）。
 * @param {string} text 名字
 * @returns {string} 首字
 */
export function pickInitials(text) {
  const value = String(text ?? '').trim();
  if (value === '') return '?';
  // 中文/日文/韩文：取第一个字
  if (/^[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value)) return value.slice(0, 1);
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return value.slice(0, 1).toUpperCase();
}

/**
 * 由文本稳定地挑一组配色（同一名字每次生成同一个颜色，不做随机）。
 * @param {string} text 名字
 * @returns {{from:string,to:string,ink:string}} 颜色
 */
export function paletteFor(text) {
  const palettes = [
    { from: '#1f6feb', to: '#0b3d91', ink: '#ffffff' },
    { from: '#2ea043', to: '#0f5323', ink: '#ffffff' },
    { from: '#a371f7', to: '#5b2ea6', ink: '#ffffff' },
    { from: '#f0883e', to: '#9e4a0b', ink: '#ffffff' },
    { from: '#db61a2', to: '#7d2b5a', ink: '#ffffff' },
    { from: '#2bb3c0', to: '#0b5560', ink: '#ffffff' },
  ];
  let hash = 0;
  for (const ch of String(text ?? '')) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
  return palettes[hash % palettes.length];
}

/**
 * 校验模板名。
 * @param {string} name
 * @returns {string|null} 合法名或 null
 */
export function normalizeTemplate(name) {
  const value = String(name ?? '').trim().toLowerCase();
  return Object.hasOwn(AVATAR_TEMPLATES, value) ? value : null;
}

/**
 * 页面侧脚本：读 `window.__dshComposeReq`，画一张 PNG，返回 data URL。
 *
 * 铁律与 writer 一致：内联属性、不拼 HTML、只用 canvas API。
 *
 * @returns {string} 可直接 execute 的表达式
 */
export function buildComposeScript() {
  return `(function(){
  try {
    var req = window.__dshComposeReq;
    if (!req || typeof req !== 'object') return JSON.stringify({ ok: false, error: 'no-request' });
    var size = Number(req.size) > 0 ? Number(req.size) : ${AVATAR_SIZE};
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return JSON.stringify({ ok: false, error: 'no-canvas' });
    var template = String(req.template || 'initials');
    var palette = req.palette || { from: '#1f6feb', to: '#0b3d91', ink: '#ffffff' };
    var initials = String(req.initials || '?');
    var name = String(req.name || '');
    var tagline = String(req.tagline || '');

    // 底
    if (template === 'gradient' || template === 'tagline') {
      var grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, palette.from);
      grad.addColorStop(1, palette.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = palette.from;
    }
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (template === 'tagline') {
      ctx.font = '600 ' + Math.round(size * 0.22) + 'px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(name || initials, size / 2, size * 0.42, size * 0.82);
      if (tagline) {
        ctx.globalAlpha = 0.86;
        ctx.font = Math.round(size * 0.085) + 'px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(tagline, size / 2, size * 0.63, size * 0.8);
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.font = '700 ' + Math.round(size * 0.46) + 'px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(initials, size / 2, size * 0.52, size * 0.78);
    }

    return JSON.stringify({ ok: true, dataUrl: canvas.toDataURL('image/png'), size: size, template: template });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})()`;
}

/**
 * data URL → base64（只接受 PNG，避免把别的东西当头像传上去）。
 * @param {string} dataUrl
 * @returns {{ok:boolean, base64?:string, bytes?:number, error?:string}} 结果
 */
export function decodePngDataUrl(dataUrl) {
  const value = String(dataUrl ?? '');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return { ok: false, error: '不是 PNG data URL' };
  const base64 = match[1];
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (bytes < 64) return { ok: false, error: 'PNG 太小，像是画失败了' };
  return { ok: true, base64, bytes };
}

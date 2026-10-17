/**
 * dsh-profile-stylist —— 适配层：**往哪写**。
 *
 * 每个站点一份档案，声明四件事：
 *   ① `profileUrl` —— 资料页；
 *   ② `fields` —— 每个字段的选择器；
 *   ③ `avatar` —— 头像控件的选择器与上传姿势；
 *   ④ `save` —— 怎么落盘（按顺序试，不硬编码一个按钮）。
 *
 * **只写"用户自己给的账号"**：档案里没有密码/邮箱/安全设置，插件也不会去碰。
 * 选择器一旦失效，回执里会明确说"这个站点的档案可能过期了"，而不是静默失败。
 *
 * 依据：GitHub 那份的选择器与上传姿势是 2026-10-17 在本机真机上实测过的
 * （`#user_display_name` / `#user_profile_bio` / `#avatar_upload` +
 * `file-attachment[data-upload-policy-url="/upload/policies/avatars"]`）。
 *
 * @module dsh-profile-stylist/hosts
 */

/** 字段名 → GitHub 选择器（真机实测）。 */
const GITHUB_FIELDS = Object.freeze({
  name: '#user_display_name',
  bio: '#user_profile_bio',
  company: '#user_profile_company',
  location: '#user_profile_location',
  blog: '#user_profile_blog',
  social: 'input[name="user[profile_social_accounts][][url]"]',
});

/**
 * 字段名 → Gitee 选择器（**2026-10-17 真机核对**：gitee.com/profile 的 `form.edit_user`）。
 *
 * 注意 Gitee 没有"所在地"文本框：它是 `#user_province` + `#user_city` 两级下拉，
 * 所以 location 这里**不支持**（调用时会出现在 `unsupported` 里，不会静默失败）。
 */
const GITEE_FIELDS = Object.freeze({
  name: '#user_name',
  bio: '#user_bio',
  company: '#user_company',
  blog: '#user_blog',
});

/** 站点档案表。 */
export const HOST_PROFILES = Object.freeze({
  github: {
    name: 'GitHub',
    /** 用户可能填的各种写法，都归一到同一个档案。 */
    aliases: ['github', 'github.com', 'gh'],
    profileUrl: 'https://github.com/settings/profile',
    fields: GITHUB_FIELDS,
    /** 文本字段所在的表单与提交方式（表单是 put；页面上有 Save/Update profile 按钮就点它）。 */
    form: {
      /** 表单本身（用来判断页面是否就绪）。 */
      selector: 'form[aria-label="Profile picture"], form.edit_user',
      /** 可能的保存按钮，按顺序试。 */
      save: ['button[type=submit]', 'button.js-profile-editable-submit', 'input[type=submit]'],
    },
    avatar: {
      /** 打开头像编辑菜单的元素（真机实测：details 里那个 label）。 */
      menu: 'details.dropdown label.dropdown-item, details.dropdown summary',
      /** 隐藏的 file input。 */
      input: '#avatar_upload',
      /** GitHub 自己接管的容器（用它判断"传上去了没"）。 */
      container: 'file-attachment[data-upload-policy-url="/upload/policies/avatars"]',
      /** 传完必须点的确认按钮。 */
      confirm: ['button.js-avatar-upload-confirm', 'button:has-text("Set new profile picture")'],
      /** 确认按钮的文字（用于按文本找，跨语言兜底）。 */
      confirmText: ['Set new profile picture'],
    },
    limits: { name: 40, bio: 160, company: 40, location: 40, blog: 120, social: 120 },
    /** 这个档案是否经过真机验证。 */
    verified: true,
  },
  gitee: {
    name: 'Gitee',
    aliases: ['gitee', 'gitee.com'],
    profileUrl: 'https://gitee.com/profile',
    fields: GITEE_FIELDS,
    form: {
      /** 真机：`<form id="edit_user_17709543" class="edit_user">` —— id 带用户号，所以按 class 找。 */
      selector: 'form.edit_user',
      save: ['button[name=commit]', 'input[name=commit]', 'button[type=submit]'],
    },
    avatar: {
      /** 没有菜单，直接是隐藏 input（真机：`<input id="avatar-input" type="file" accept="image/jpg,...">`）。 */
      menu: '',
      input: '#avatar-input',
      container: '',
      /** 传完要点「确定」（真机：`<div id="confirm-avatar">确定</div>`，不是 button）。 */
      confirm: ['#confirm-avatar'],
      confirmText: ['确定', '保存'],
    },
    /** 真机核对到的上限：姓名的 maxlength=60；其余字段页面上没设 maxlength。 */
    limits: { name: 60 },
    /** 2026-10-17 在 gitee.com/profile 真机核对过字段 id 与头像控件。 */
    verified: true,
  },
});

/**
 * 把用户给的站点名归一到档案键。
 * @param {string} host
 * @returns {string|null}
 */
export function normalizeHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (value === '') return 'github';
  for (const [key, profile] of Object.entries(HOST_PROFILES)) {
    if (key === value) return key;
    if (Array.isArray(profile.aliases) && profile.aliases.includes(value)) return key;
  }
  return null;
}

/**
 * 取档案。
 * @param {string} host
 * @returns {object|null}
 */
export function hostProfile(host) {
  const key = normalizeHost(host);
  return key === null ? null : HOST_PROFILES[key];
}

/**
 * 校验一份草稿能不能写进这个站点（字段是否被支持、长度是否超限）。
 * @param {string} host
 * @param {Record<string,string>} fields
 * @returns {{ok:boolean, supported:Record<string,string>, unsupported:string[], warnings:string[]}}
 */
export function checkAgainstHost(host, fields) {
  const profile = hostProfile(host);
  const supported = {};
  const unsupported = [];
  const warnings = [];
  if (profile === null) {
    return { ok: false, supported, unsupported: Object.keys(fields ?? {}), warnings: ['不认识的站点：' + host] };
  }
  for (const [key, value] of Object.entries(fields ?? {})) {
    const selector = profile.fields[key];
    if (typeof selector !== 'string' || selector === '') {
      unsupported.push(key);
      continue;
    }
    const limit = profile.limits?.[key];
    if (Number.isFinite(limit) && String(value).length > limit) {
      warnings.push(`${key} 超过该站上限 ${limit} 字符，会被截断`);
    }
    supported[key] = String(value);
  }
  if (profile.verified !== true) warnings.push(`${profile.name} 的字段选择器尚未真机验证，可能要按现场调整`);
  return { ok: unsupported.length === 0, supported, unsupported, warnings };
}

/**
 * 生成"写入脚本"的说明（给调用方与模型看，不是可执行代码）。
 * @param {string} host
 * @returns {string}
 */
export function describeHost(host) {
  const profile = hostProfile(host);
  if (profile === null) return `不认识的站点：${host}（内置只有 ${Object.keys(HOST_PROFILES).join(' / ')}）`;
  const fieldList = Object.keys(profile.fields).join('、');
  const lines = [
    `${profile.name}｜资料页 ${profile.profileUrl}${profile.verified ? '' : '（选择器未实测）'}`,
    `  可写字段：${fieldList}`,
    `  头像控件：${profile.avatar?.input || '（无）'}`,
  ];
  if (profile.key === 'gitee' || profile.name === 'Gitee') {
    lines.push('  说明：Gitee 的所在地是省/市两级下拉，不在这份字段表里（不会静默失败，会进 unsupported）');
  }
  return lines.join('\n');
}

/**
 * 列出所有内置档案。
 * @returns {Array<{key:string,name:string,verified:boolean,url:string}>}
 */
export function listHosts() {
  return Object.entries(HOST_PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    verified: profile.verified === true,
    url: profile.profileUrl,
  }));
}

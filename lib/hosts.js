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

/** 字段名 → Gitee 选择器（**未实测**，按常见表单命名猜的；失效要按现场改）。 */
const GITEE_FIELDS = Object.freeze({
  name: '#user_name',
  bio: '#user_intro',
  company: '#user_company',
  location: '#user_location',
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
      selector: 'form',
      save: ['button[type=submit]', 'input[type=submit]', 'button:has-text("保存")'],
    },
    avatar: {
      menu: '',
      input: 'input[type=file]',
      container: '',
      confirm: [],
      confirmText: ['保存', '确定'],
    },
    limits: { name: 40, bio: 160, company: 40, location: 40, blog: 120 },
    /** 未实测：选择器是猜的，真机上要按现场改。 */
    verified: false,
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
  return [
    `${profile.name}｜资料页 ${profile.profileUrl}${profile.verified ? '' : '（选择器未实测）'}`,
    `  可写字段：${fieldList}`,
    `  头像控件：${profile.avatar?.input || '（无）'}`,
  ].join('\n');
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

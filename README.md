# dsh-profile-stylist（个人资料配置）

**你说要什么样的人设，它写出来，并把资料页填好。**

"我想要个给主人打工的 AI 小助手，可爱但专业" → 它生成昵称/简介/标语 → 从你的素材库里挑一张头像（或按名字画一张）→ 打开你自己的资料页填进去。

> 它替用户写**关于他自己**的东西，所以默认值是三重的保守：
> **默认 dry-run**（不传 `confirm: true` 只演算）、**只认资料字段**（档案里没有密码/邮箱/安全设置）、
> **写前摊开**（要写什么、写到哪、用哪张图，提交前整份给人看）。

---

## 它做什么

| 步 | 动作 | 细节 |
| --- | --- | --- |
| ① | 生成文案 | 按"你的需求"让**宿主模型服务**出昵称/简介/标语/所在地/链接；写不出来就不写，**不编** |
| ② | 收敛草稿 | 字段白名单 + 按站点长度截断（GitHub bio 160 字符）+ **网址只收 http/https** |
| ③ | 选头像 | 素材库 / 你给的本地图片路径（本机没有图像生成服务，所以只这三条路） |
| ④ | 体检 | 目标站点能不能写这些字段、有哪些会超限、选择器是否验证过 |
| ⑤ | 写入（要显式确认） | 打开资料页 → 填文本 → 头像走 `File → DataTransfer → input.files → change` 交给站点自己的 JS → 点保存/确认 |
| ⑥ | 回报 | 填了哪些、缺哪些、头像是否确认、任何警告 |

## 三个工具

```
profile_assets  [target=github]                     # 看素材库里有哪些图
profile_author  wish="…" [host=github] [current=…]   # 出草稿，不写站点
profile_apply   fields='{"name":"…","bio":"…"}' [host=github] [avatarPath=…|avatarFromAssets=…] [confirm=true]
```

`profile_apply` **不传 `confirm: true` 就是 dry-run**：只做体检 + 展示，不打开页面、不点任何按钮。

## 头像从哪来

本机**没有图像生成服务**，所以头像只有三条来源：

| 来源 | 怎么用 |
| --- | --- |
| **素材库** | 往 `%USERPROFILE%\.dsh\dsh-profile-stylist\assets\avatars\` 丢 png/jpg，然后 `avatarFromAssets:"文件名"` |
| **本地图片** | `avatarPath:"D:\\pics\\me.png"`（≤12MB，插件会按 512×512 规格化后再交） |
| **自己画** | 先 `profile_author` 拿文案，需要"把名字画进图里"时用页面内 canvas 合成（零外部依赖） |

## 支持的站点

| 站点 | 状态 | 备注 |
| --- | --- | --- |
| **GitHub** | ✅ 选择器**真机验证过** | `#user_display_name` / `#user_profile_bio` / `#avatar_upload` + 「Set new profile picture」 |
| Gitee | ⚠️ **未实测** | 选择器是按常见命名写的，真机上可能要按现场改；回执里会如实标"未验证" |

不认识的站点**直接拒绝**，不猜选择器。

## 红线与隐私

- **只写资料字段**：档案里没有密码、邮箱、安全设置、支付 —— 插件也不会去点。
- **只动你自己的账号**：你在浏览器里登录谁，它就写谁（登录态由浏览器 profile 自持）。
- **不持有任何 API key**：文案由宿主的模型服务生成。
- **写前摊开**：dry-run 回执里能看到逐字段的"要写什么"，确认后才动手。

## 安装

市场收录后在 DSH 里搜 `dsh-profile-stylist` 安装。手动安装：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-profile-stylist" -Target "D:\dsh\projects\dsh-profile-stylist"
# profile 的 package.json：dependencies 加 "dsh-profile-stylist": "link:D:/dsh/projects/dsh-profile-stylist"
# 并把 "dsh-profile-stylist" 加进 dsh.profile.bundles（漏了不加载）→ 重启 DSH
```

**用之前先做两步**：① 装好内置浏览器插件；② 在浏览器窗口里登录目标站点。

## 测试

```powershell
node test/smoke.mjs      # 35 项：纯逻辑 / 站点档案 / 生成层（假 LLM）/ 写入层（假浏览器）/ 回执
```

测试**不联网、不碰真实浏览器、不读任何凭据**。在活代码树里跑会**直接退出**（先复制到 `D:\dsh\sandbox\`）。

## 许可

MIT

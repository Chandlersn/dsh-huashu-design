# 花叔设计插件：品牌与真实资产约束

日期：2026-11-11。适用于 DSH 原生「花叔设计」面板的三个设计方向。

## 品牌事实

品牌名称沿用「花叔设计 / Huashu Design」，方法与样张上游为 [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design)。本次 Host catalog 指向本地快照 3.3.0，commit `e8d1148a80d5a281d4247cffe320add3df017928`。实际界面代码已读：[当前 Client 实现](<D:/视频skills/dsh-huashu-design/lib/client.js>)。这是已安装插件的 UI 设计，不是为上游重新做官网。

已读本插件[图标源文件](<D:/视频skills/dsh-huashu-design/icon.svg>)：128×128 SVG，深绿圆角底 `#24594b`、米白线条 `#f6f5ec`、中心方形及径向连线。这是本插件现有资产，可保留；不能称为已经核实的上游官方 logo。面板内现用 `Icon` 组件也来自现有代码。未找到独立的上游 VI/字体规范，不凭图标色强制宿主控件改色。

Figma 与 Adobe Express 只出现在分析引用中，不在产品界面展示其 logo，不制造合作关系。设计师名字也是研究方法归因，不是署名背书。

## 宿主主题

容器、文本、分隔、输入框和按钮使用现有 Client 已采用的以下 token；不复制样张 hex 为全局皮肤。

| 用途 | token |
|---|---|
| 根背景 | `--dsw-alias-bg-base` |
| 组件/输入区层级 | `--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2` |
| 正文 | `--dsw-alias-label-primary` |
| 次要说明 | `--dsw-alias-label-secondary` |
| 分隔与边框 | `--dsw-alias-border-l1`、`--dsw-alias-border-l2` |
| 选中、主要操作、键盘焦点 | `--dsw-alias-brand-primary` |

本任务调用过 `Theme.listTokens`，Client inspect 超时，未获得当前主题的实时 token 值、完整可用列表或浅深色对比度。上表仅是已读现有代码中的真实名称，不是实时值验证。文字放在 brand 背景上时，不可直接认定 `bg-base` 就是合格的反白色；后续应查精确 foreground token 或以实测对比度选择合适的宿主控件表达。可以优先用品牌色边框/文字与常规背景表达主要按钮，满足可读性后再确定实底。

浅深主题都保留图像自己的颜色，不给样张套整页灰度/暗化滤镜。若 UI 色阶变化，只来自宿主主题。字体优先宿主/系统无衬线，避免 CDN 字体依赖。样张中的中文字体是作品内容的一部分，不全局覆盖它。

## 已亲眼看到的上游真实样张

以下均已由 `read_image` 打开原图（1200×750）。它们是上游风格示例，内部题材、姓名、价格、数据均不成为本产品事实。

| 样张 | 实际看到的视觉内容 | 可借之处与限制 |
|---|---|---|
| [网页13 Bento](<D:/视频skills/dsh-huashu-design/upstream/assets/style-specimens/web/13-glassmorphism-bento.jpg>) | 黑底、居中「为严肃写作者打造的 AI 写作工具」、下部一大多小功能格、蓝紫微光 | 可借主次模块关系；图内94%等示例指标不得提取成产品统计 |
| [东亚05 汉字海报](<D:/视频skills/dsh-huashu-design/upstream/assets/style-specimens/east/05-hanzi-experimental-poster.jpg>) | 巨型「市」字占左半幅、红色竖笔、右侧五笔分解与展览说明 | 可借把内容拆成步骤的思路；不将巨字当面板导航，不借示例展期 |
| [网页20 白盒画廊](<D:/视频skills/dsh-huashu-design/upstream/assets/style-specimens/web/20-kenya-hara-white-gallery.jpg>) | 左侧短文、右侧错落图格、图下名称价格，图内本身标「照片位」 | 可借图片与信息分离。图内照片位是上游样张自身的诚实占位，不应裁成真实摄影或假称用户作品 |
| [网页17 功能主义网格](<D:/视频skills/dsh-huashu-design/upstream/assets/style-specimens/web/17-functional-brutalism.jpg>) | 左主列表右辅助栏、细分隔、蓝链接、两层行文字 | 可借目录密度与分组关系；投票、评论与居民数均为图内示例，不进入插件UI |
| [App01 硬件面板](<D:/视频skills/dsh-huashu-design/upstream/assets/style-specimens/app/01-hardware-panel.jpg>) | 三个手机内有采样垫、波形切片与混音推子，黑底橙色操作 | 可借稳定操作分组；不把旋钮/推子用作没有连续参数含义的需求输入 |

运行时样张直接使用 catalog 返回的 `specimenUrl`。当前其形式为 `/huashu-design/assets/assets/style-specimens/...jpg`，双 `assets` 是真实返回值，不能擅自“纠正”。分析文件引用本机真实路径，后续原生面板继续用已存在的资源路由，不复制 upstream、不批量重新下载、不发明截图。

## 版权与诚实展示

主体 MIT，保留上游版权与许可。小红书鸟类贴纸目录是 PolyForm-Shield-1.0.0 例外，样张浏览需保留来源说明，正式新作品按上游指引替换为自有素材。本次三版可以展示真实上游小红书样张，但不可抽出贴纸冒充新作或用户资产。

固定说明可用：「风格样张来自花叔设计上游示例；借用版式与气质，作品内容以你的真实材料为准。」空作品库只展示空状态，不将样张自动登记成作品。页面不要增加虚构客户评价、人物头像、收入、评分、转化率、创作次数或使用趋势。

## 未执行项

未安装、未启浏览器、未改运行时代码、未改 upstream，未核验当前可见界面截图。按用户的只写文档范围，没有运行会写外观账/偏好库/版本检查日期的技能脚本，也没有生成新的 HTML、图片或审批记录。实际 UI 是否合格要在三个原生初稿实现后观察。

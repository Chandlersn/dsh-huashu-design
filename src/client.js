import { parseHandbook, resolveHandbookTarget, handbookText } from '../lib/handbook.js';
import { highlight } from '../lib/highlight.js';
import { loadHandbook } from '../lib/handbook-load.js';
import { mountPrintpress, requestPrintpressEdit } from '../dist/printpress/embedded.js';
import { printpressAction, editorMode, workPreviewUrl, outputModeFor } from './printpress/handoff.js';
import { THEME_PRESETS, readThemePreference, saveThemePreference, normalizeColor, themeVariables } from './themes.js';
import printpressCSS from '../dist/printpress/style.css';
import { PREVIEW_SANDBOX, htmlPreviewable, htmlThumbnailUrl, createWorkPreviewCache, previewCacheKey, miniatureDocument, createPreviewSession, createPreviewBridge } from './work-preview.js';

window.__ModuleLoader__.load({
  id: 'dsh-huashu-design',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'huashu-design';
    const dicts = {
      zh: {
        title:'花叔设计', studio:'创作', styles:'风格库', works:'我的作品', workflows:'工作流', guide:'指南', printpress:'批印坊', ppLoading:'正在连接批印坊本地引擎…', ppRetry:'重新连接',
        subtitle:'把内容变成作品', headline:'想法有了，\n让它看得见。', intro:'网页、演示、图文与动画。从你的内容开始，找到合适的表达。',
        start:'开始一个新作品', explore:'先逛逛风格库', formats:'选择一种表达', formatHint:'先定媒介，再让内容决定风格。',
        selected:'已选', taskLabel:'创作类型', briefLabel:'这次，想做什么？', briefHint:'写下主题、给谁看、希望表达什么。也可以粘贴正文或参考链接。',
        styleLabel:'视觉参考', freeStyle:'让内容决定方向', changeStyle:'浏览并选择风格', clearStyle:'取消参考', draft:'准备创作草稿', preparing:'正在准备…',
        draftLabel:'你的创作草稿', open:'去新对话继续创作', draftHelp:'草稿不会自动发送；进入新对话后，还可以补充内容。', directionHint:'新设计会先给出三个方向，选定后再完成。',
        search:'搜索风格、用途或关键词', all:'全部', web:'网页', ppt:'幻灯片', info:'信息图', app:'App', east:'中文与东亚', xhs:'小红书',
        preview:'查看样张', useStyle:'用这个风格', details:'设计说明', back:'返回', sampleLabel:'上游风格样张', inspiration:'从一张样张开始', inspirationHint:'看见版式，才更容易说清想要什么。',
        styleHint:'样张里的题材与数字是示例，借用版式，内容用你的真实材料。',
        emptyWorks:'第一份作品，从这里开始', emptyHint:'登记成品和源文件，后续可继续修改，也可沿用风格做下一份。', add:'登记本机作品', save:'登记作品', cancel:'取消',
        titleLabel:'作品标题', pathLabel:'本机文件的绝对路径', noteLabel:'下次复用时，需要记住什么？', reuse:'做同款', download:'打开 / 下载', remove:'移出作品库', confirmRemove:'确认移出', removeHelp:'只移除记录，原文件会保留。',
        delete:'删除', confirmDelete:'确认永久删除', deleteHelp:'会一并删除成品文件、关联源码和原生工程文件，无法恢复。', deleted:'作品及文件已删除', deleteSkipped:'被保留的文件：', allTypes:'全部',
        recent:'最近的作品', allWorks:'查看作品库', noMatches:'没有找到匹配内容', previous:'上一页', next:'下一页', loading:'正在打开设计工作台…', retry:'重新加载', refresh:'刷新',
        saved:'作品已登记', removed:'作品已移出', close:'收起', readSkill:'完整设计方法', resource:'设计手册', more:'继续阅读',
        workflowIntro:'找到适合这一次的做法', workflowHint:'从探索方向到交付检查，让每一步都有依据。', useWorkflow:'使用工作流',
        guideIntro:'先给内容，再选方向。', guideHint:'选择媒介和工作区，写需求并发送。完成后保留源文件并登记，后续可以继续修改。',
        countStyles:'种风格', countTasks:'种媒介', countFlows:'个工作流', countWorks:'份作品',
        directionLabel:'界面布局', directionHintUI:'默认画廊，也可以切换为目录工作台。', compare:'比较六个候选', hideCompare:'收起候选',
        gallery:'作品画廊', desk:'左右编辑台', index:'目录工作台',
        galleryDesc:'先看样张，再开始创作', deskDesc:'需求和参考并排，减少来回切换', indexDesc:'按媒介查找，直接进入任务',
        concept1:'作品画廊', concept2:'左右编辑台', concept3:'模板货架', concept4:'目录工作台', concept5:'功能舞台', concept6:'汉字海报',
        alternate:'备选', fullDraft:'完整初稿', mediaTitle:'设计的起点，是内容。', mediaHint:'先选一种媒介，作品会沿着它展开。',
        selectedFormat:'当前媒介', browseForTask:'为这个媒介找参考', latestStyles:'可用的风格参考', keepCreating:'继续创作',
        noReference:'还没有选择参考', noReferenceHint:'可以自由探索，也可以从右侧选一张样张。', formatGuide:'模块指南',
        viewAll:'查看全部', taskGuide:'阅读这类作品的制作方法', workPath:'文件位置',
        method1:'核实内容与素材', method2:'比较三个方向', method3:'制作、验证与交付', method4:'登记作品，复用风格',
        docContents:'章节目录', docFindChapter:'查找章节', docRaw:'查看原文', docFormatted:'排版阅读', docCopy:'复制全文', docCopied:'已复制当前载入的手册内容。', docCopyFailed:'复制未完成，可切换原文后手动复制。', docClose:'返回工作台', docReadTime:'阅读约', docMinutes:'分钟', docChapters:'个章节', docLoading:'正在载入手册', docPartial:'部分内容已载入', docPartialHint:'当前显示已载入的部分，继续阅读会追加余下内容。', docEnd:'全文已载入', docTop:'回到顶部', docCode:'代码示例', docCodeCopy:'复制', docCodeCopied:'已复制', docTable:'手册表格，可横向滚动', docTask:'手册任务标记', docImage:'手册插图', docAnchorMissing:'未找到该章节；如正文尚未载全，请继续加载后再定位。',
        revisionWorkflowHint:'正在修改已有作品：可使用“评审与打磨”；如需探索新作品，请先在创作区退出修改模式。',
        showNotes:'展开说明', hideNotes:'收起说明', suitable:'适合用在哪里', visualDNA:'版式与视觉特征', buildNotes:'实现方式与限制', fontPair:'字体搭配', inspirationSource:'参考来源', samplePalette:'示例色板', paletteHint:'色值和字体是上游示例，实际作品应结合内容与品牌推导。', readFullGuide:'完整风格手册', upstreamEstimate:'上游 HTML 还原度估计', notesLoading:'正在读取这张素材的说明…', toneBold:'大胆', toneNeutral:'中性', toneQuiet:'安静',
        finishSource:'请先保存或关闭源码编辑器中的修改，再发送消息。', wrongWorkspace:'请选择包含该作品源文件的工作区。', conflictHelp:'编辑框保留了你的改动。请先复制需保留的内容，再读取磁盘版本合并。', discardReload:'放弃缓冲并读取磁盘',
        workspace:'工作区', chooseWorkspace:'选择工作区', workspacePath:'已有文件夹的绝对路径', addWorkspace:'添加工作区', useWorkspace:'添加并选用', noWorkspaces:'尚无工作区，请先添加文件夹', workspaceLoading:'正在读取工作区…',
        send:'发送并开始创作', sendEdit:'发送修改需求', sending:'正在发送…', previewPrompt:'预览指令', draftOptional:'可以编辑下面的指令，再发送到所选工作区。', sent:'消息已发送', viewSession:'查看会话',
        editWork:'继续修改', editSource:'编辑源码', editHeading:'修改已有作品', editBrief:'描述要修改的内容、版式或交互。', editHint:'在原作品和源文件上修改，保留既定方向。', exitEdit:'退出修改', projectFolder:'作品所在文件夹',
        editLayers:'编辑图层', editImage:'编辑图片', openingEditor:'正在打开编辑器…', projectDownload:'工程包', imageOnlyHint:'图片编辑：可裁剪、修补并保存；原图中的文字与图形没有独立图层。', published:'当前版本已保存回作品库。',
        layeredPublished:'图层工程已生成并登记到作品库，可立即进入批印坊手动编辑。', editNow:'立即编辑',
        outputLabel:'输出格式', outputLayered:'图片 + 图层工程', outputStandard:'常规输出', outputLayeredHint:'文字、形状、线条与图片分别保留为可编辑图层，同时交付 PNG 预览和工程包。',
        saveBeforeDownload:'请先保存文字修改', inlineEditHint:'双击文字编辑', inlineSave:'保存修改', inlineSaving:'正在保存…', inlineSaved:'已保存',
        fullscreenWork:'全屏查看', previewWork:'作品查看', previewLoading:'正在载入作品预览…', previewClose:'关闭预览', previewRetry:'重新载入', previewReadOnly:'此作品未关联可编辑源码，可查看预览与下载。', previewBusy:'正在读取或保存作品，请稍候…', previewSaved:'作品已保存；当前预览保留编辑状态。', previewDraftHelp:'关闭预览会保留当前页面；再次点击该作品可继续编辑。', previewDraftFailure:'浏览器草稿未能缓存，请保持预览打开并保存到作品：', previewDiscardHelp:'预览有未保存的编辑。重新载入或切换作品前，请先保存需要保留的内容。', previewDiscard:'仍继续打开',
        palette:'配色', paletteOptions:'工作台配色', themeOcean:'海蓝', themeEmerald:'翡翠', themeWisteria:'紫藤', themeRose:'玫瑰', themeAmber:'琥珀', themeCoral:'珊瑚', themeHost:'跟随宿主', themeCustom:'自选强调色', workbenchPaletteHint:'配色用于工作台；作品本身的颜色保持不变。',
        linkSource:'关联源文件', sourceLabel:'可编辑源文件（可选，绝对路径）', sourceHint:'图片、PDF、视频请关联 HTML 或源工程文件。HTML 和 SVG 默认直接编辑自身。', sourceEditor:'源码编辑', sourceSave:'保存修改', sourceReload:'重新读取磁盘', sourceBackup:'保存时自动备份；文件在外部变化时会阻止覆盖。', sourceSaved:'修改已保存，原内容已备份到：', sourceChanged:'有未保存的修改', discardSource:'放弃修改并关闭', sourceExport:'导出文件需关联源文件后才能编辑。', editorLimit:'直接编辑适用于 128 KiB 内的 UTF-8 文本源文件；较大的工程请用“继续修改”。',
        noteEmpty:'还没有作品记录', artCaption:'真实样张，来自随插件保存的风格库', motionCaption:'动画分镜的舞台与运动视觉参考', critiqueCaption:'版式、数据与信息层级的评审参考', openImage:'打开原始样张'
      },
      en: {
        title:'Huashu Design', studio:'Create', styles:'Styles', works:'My work', workflows:'Workflows', guide:'Guide', printpress:'PrintPress', ppLoading:'Connecting to the local PrintPress engine…', ppRetry:'Reconnect',
        subtitle:'Content into something tangible', headline:'An idea in mind.\nA work in sight.', intro:'Websites, decks, visual stories and motion. Start with your content and find its form.',
        start:'Start a new piece', explore:'Explore the styles', formats:'Choose a medium', formatHint:'Start with the medium. Let the content guide the style.',
        selected:'Selected', taskLabel:'Format', briefLabel:'What are we making?', briefHint:'Describe the topic, audience and message. Add your content or reference links.',
        styleLabel:'Visual reference', freeStyle:'Let the content guide the direction', changeStyle:'Browse and choose a style', clearStyle:'Clear reference', draft:'Prepare creative brief', preparing:'Preparing…',
        draftLabel:'Your creative brief', open:'Continue in a new conversation', draftHelp:'The draft is not sent automatically. Add more content in the conversation.', directionHint:'New designs start with three directions for you to choose from.',
        search:'Search styles, uses or keywords', all:'All', web:'Web', ppt:'Decks', info:'Infographics', app:'App', east:'Chinese & East Asian', xhs:'Xiaohongshu',
        preview:'View specimen', useStyle:'Use this style', details:'Design notes', back:'Back', sampleLabel:'Upstream style specimen', inspiration:'Begin with a specimen', inspirationHint:'A visible layout makes the direction easier to describe.',
        styleHint:'Subjects and numbers are examples. Reuse the visual language with your own verified content.',
        emptyWorks:'Your first piece starts here', emptyHint:'Register the deliverable and editable source to revise it later or reuse its style.', add:'Register local work', save:'Register work', cancel:'Cancel',
        titleLabel:'Title', pathLabel:'Absolute local file path', noteLabel:'What should we remember for the next piece?', reuse:'Make another like this', download:'Open / download', remove:'Remove from library', confirmRemove:'Confirm removal', removeHelp:'Only the record is removed. The source file stays.',
        delete:'Delete', confirmDelete:'Delete permanently', deleteHelp:'Also deletes the deliverable, its linked editable source and its native project file. This cannot be undone.', deleted:'Work and files deleted', deleteSkipped:'Files kept:', allTypes:'All',
        recent:'Recent work', allWorks:'Open library', noMatches:'No matching content', previous:'Previous', next:'Next', loading:'Opening your design studio…', retry:'Try again', refresh:'Refresh',
        saved:'Work registered', removed:'Work removed', close:'Close', readSkill:'Full design method', resource:'Design handbook', more:'Read more',
        workflowIntro:'Find a method for this piece', workflowHint:'From exploration to delivery checks, give each step a reason.', useWorkflow:'Use workflow',
        guideIntro:'Content first. Direction next.', guideHint:'Choose a medium and workspace, then send your brief. Keep and register the editable source so you can revise the result later.',
        countStyles:'styles', countTasks:'mediums', countFlows:'workflows', countWorks:'works',
        directionLabel:'Workspace layout', directionHintUI:'Gallery by default, with a medium index alternative.', compare:'Compare six candidates', hideCompare:'Hide candidates',
        gallery:'Specimen gallery', desk:'Editing desk', index:'Medium index',
        galleryDesc:'See the work, then begin', deskDesc:'Brief and references, side by side', indexDesc:'Find your medium and go straight in',
        concept1:'Specimen gallery', concept2:'Editing desk', concept3:'Template shelf', concept4:'Medium index', concept5:'Bento stage', concept6:'Hanzi poster',
        alternate:'Alternative', fullDraft:'Full draft', mediaTitle:'Content is the starting point.', mediaHint:'Choose a medium and let the piece grow from it.',
        selectedFormat:'Selected medium', browseForTask:'Find a reference for this medium', latestStyles:'Style references', keepCreating:'Continue creating',
        noReference:'No reference selected', noReferenceHint:'Explore freely or choose a specimen on the right.', formatGuide:'Module guide',
        viewAll:'View all', taskGuide:'Read the making guide for this medium', workPath:'File location',
        method1:'Verify content and materials', method2:'Compare three directions', method3:'Produce, verify and deliver', method4:'Register work and reuse its style',
        docContents:'Contents', docFindChapter:'Find a chapter', docRaw:'View source', docFormatted:'Reading view', docCopy:'Copy text', docCopied:'Loaded handbook text copied.', docCopyFailed:'Copy failed. Switch to source view to copy manually.', docClose:'Back to studio', docReadTime:'About', docMinutes:'min read', docChapters:'chapters', docLoading:'Loading handbook', docPartial:'Partially loaded', docPartialHint:'Continue reading to load the rest of this document.', docEnd:'Full document loaded', docTop:'Back to top', docCode:'Code example', docCodeCopy:'Copy', docCodeCopied:'Copied', docTable:'Handbook table; scroll horizontally', docTask:'Handbook task marker', docImage:'Handbook illustration', docAnchorMissing:'Chapter not found. Load the rest of the document before locating it again.',
        revisionWorkflowHint:'You are revising an existing piece. Review & polish is available; exit revision mode in Create before exploring a new piece.',
        showNotes:'Show notes', hideNotes:'Hide notes', suitable:'Suitable uses', visualDNA:'Layout and visual traits', buildNotes:'Implementation and limits', fontPair:'Typography', inspirationSource:'References', samplePalette:'Example palette', paletteHint:'Colors and fonts are upstream examples. Derive the final choices from your content and brand.', readFullGuide:'Full style handbook', upstreamEstimate:'Upstream HTML fidelity estimate', notesLoading:'Loading this specimen’s notes…', toneBold:'Bold', toneNeutral:'Neutral', toneQuiet:'Quiet',
        finishSource:'Save or close your source changes before sending a message.', wrongWorkspace:'Choose a workspace containing this source file.', conflictHelp:'Your edits remain in the editor. Copy what you need before loading and merging the current disk version.', discardReload:'Discard buffer and load from disk',
        workspace:'Workspace', chooseWorkspace:'Choose a workspace', workspacePath:'Absolute path of an existing folder', addWorkspace:'Add workspace', useWorkspace:'Add and select', noWorkspaces:'No workspaces yet. Add an existing folder.', workspaceLoading:'Loading workspaces…',
        send:'Send and start creating', sendEdit:'Send revision request', sending:'Sending…', previewPrompt:'Preview instructions', draftOptional:'Edit the instructions below, then send them to the selected workspace.', sent:'Message sent', viewSession:'Open conversation',
        editWork:'Revise this work', editSource:'Edit source', editHeading:'Revise existing work', editBrief:'Describe the changes to content, layout or interaction.', editHint:'Revise the existing files while preserving the chosen direction.', exitEdit:'Exit revision', projectFolder:'Project folder',
        editLayers:'Edit layers', editImage:'Edit image', openingEditor:'Opening editor…', projectDownload:'Project package', imageOnlyHint:'Image editing supports cropping, retouching and saving. Text and graphics in the original image are not separate layers.', published:'This version has been saved to your work library.',
        layeredPublished:'The layered project is in your library. Open it in PrintPress for manual editing.', editNow:'Edit now',
        outputLabel:'Output format', outputLayered:'Image + layered project', outputStandard:'Standard output', outputLayeredHint:'Keep text, shapes, lines and images as separate editable layers. Deliver a PNG preview and project package.',
        saveBeforeDownload:'Save text changes before downloading', inlineEditHint:'Double-click text to edit', inlineSave:'Save changes', inlineSaving:'Saving…', inlineSaved:'Saved',
        fullscreenWork:'View fullscreen', previewWork:'Work viewer', previewLoading:'Loading work preview…', previewClose:'Close preview', previewRetry:'Reload preview', previewReadOnly:'This work has no associated editable source. You can preview or download it.', previewBusy:'Reading or saving this work…', previewSaved:'Work saved. The current preview keeps its editing state.', previewDraftHelp:'Closing keeps this page open. Click the same work to continue editing.', previewDraftFailure:'The browser draft could not be cached. Keep the preview open and save the work: ', previewDiscardHelp:'This preview has unsaved edits. Save anything you need before reloading or switching works.', previewDiscard:'Continue opening',
        palette:'Colors', paletteOptions:'Workspace colors', themeOcean:'Ocean', themeEmerald:'Emerald', themeWisteria:'Wisteria', themeRose:'Rose', themeAmber:'Amber', themeCoral:'Coral', themeHost:'Follow host', themeCustom:'Custom accent', workbenchPaletteHint:'Colors apply to the workspace. The artwork keeps its own colors.',
        linkSource:'Link editable source', sourceLabel:'Editable source file (optional, absolute path)', sourceHint:'Link an HTML or project source to images, PDFs and videos. HTML and SVG can be edited directly.', sourceEditor:'Source editor', sourceSave:'Save changes', sourceReload:'Read current disk version', sourceBackup:'Saving creates a backup. External changes prevent overwriting.', sourceSaved:'Changes saved. Original backed up at: ', sourceChanged:'Unsaved changes', discardSource:'Discard changes and close', sourceExport:'Link an editable source to revise this exported work.', editorLimit:'Direct editing supports UTF-8 text up to 128 KiB. Use “Revise this work” for larger projects.',
        noteEmpty:'No work registered yet', artCaption:'Real specimens from the bundled style library', motionCaption:'Visual references for motion storyboards and stages', critiqueCaption:'References for layout, data and information hierarchy', openImage:'Open original specimen'
      }
    };
    const CSS = `
.hs-design{position:relative;container-type:inline-size;height:100%;min-width:0;overflow:auto;overscroll-behavior:contain;scroll-behavior:smooth;background:var(--hs-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
.hs-design *{box-sizing:border-box}.hs-design h1,.hs-design h2,.hs-design h3,.hs-design p{margin:0}.hs-design h1{font-size:20px;font-weight:650;letter-spacing:-.5px;line-height:1.3}.hs-design h2{font-size:25px;font-weight:620;line-height:1.35;letter-spacing:-.7px}.hs-design h3{font-size:16px;font-weight:600;line-height:1.5}.hs-design img{display:block;max-width:100%}.hs-design button,.hs-design input,.hs-design textarea,.hs-design select{font:inherit;color:inherit}.hs-design button,.hs-design a{ -webkit-tap-highlight-color:transparent}.hs-design button{cursor:pointer}.hs-design button:disabled{opacity:.48;cursor:default}.hs-design a{color:inherit;text-decoration:none}.hs-design button:focus-visible,.hs-design a:focus-visible,.hs-design input:focus-visible,.hs-design textarea:focus-visible,.hs-design select:focus-visible{outline:2px solid var(--hs-accent-ink);outline-offset:4px}
.hs-design .hs-wrap{max-width:1320px;padding:24px 36px 32px;margin:auto}.hs-design .hs-wrap.is-printpress{max-width:none}.hs-design .hs-printpress-panel[hidden],.hs-design [hidden]{display:none!important}.hs-design .hs-muted{color:var(--dsw-alias-label-secondary)}.hs-design .hs-small{font-size:12px}.hs-design .hs-topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 0 20px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-brand{display:flex;align-items:center;gap:12px;flex-shrink:0}.hs-design .hs-brand svg{color:var(--hs-accent-ink)}.hs-design .hs-brand-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}.hs-design .hs-nav{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.hs-design .hs-button,.hs-design .hs-nav button,.hs-design .hs-filter,.hs-design .hs-text-button{min-height:44px;min-width:44px;padding:10px 15px;border-radius:8px;border:1px solid var(--hs-border-l2);background:var(--hs-bg-layer-1);display:inline-flex;align-items:center;justify-content:center;gap:8px;line-height:1.4;transition:background .16s,border-color .16s,transform .16s}.hs-design .hs-button:hover,.hs-design .hs-filter:hover{background:var(--hs-bg-layer-2)}.hs-design .hs-nav button,.hs-design .hs-text-button{background:transparent;border-color:transparent}.hs-design .hs-nav button[aria-selected=true]{background:var(--hs-bg-layer-2);font-weight:650}.hs-design .hs-nav button:hover,.hs-design .hs-text-button:hover{background:var(--hs-bg-layer-2)}.hs-design .hs-primary{background:var(--hs-accent);color:var(--hs-on-accent);border-color:var(--hs-accent-ink);font-weight:600}.hs-design .hs-primary:hover{background:var(--hs-accent);box-shadow:0 0 0 2px var(--hs-accent-soft)}.hs-design .hs-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hs-design .hs-danger{color:var(--dsw-alias-state-error-primary)}
.hs-design .hs-direction{padding:16px 0 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.hs-design .hs-direction-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-direction-switch{display:flex;padding:3px;gap:3px;border:1px solid var(--hs-border-l1);border-radius:10px;background:var(--hs-bg-layer-1)}.hs-design .hs-direction-switch button{min-height:44px;border:0;background:transparent;border-radius:7px;padding:8px 12px;font-size:13px}.hs-design .hs-direction-switch button[aria-pressed=true]{background:var(--hs-bg-layer-2);box-shadow:0 0 0 1px var(--hs-border-l2);font-weight:650}.hs-design .hs-message{border-radius:9px;padding:12px 16px;margin:10px 0 20px;border:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-1)}.hs-design .hs-message[role=alert]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.hs-design .hs-message[role=status]{color:var(--dsw-alias-state-success-primary)}.hs-design .hs-published{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.hs-design .hs-published>span{flex:1;min-width:180px}
.hs-design .hs-hero{display:grid;grid-template-columns:minmax(270px,.85fr) minmax(0,1.15fr);gap:36px;align-items:center;padding:20px 0 38px}.hs-design .hs-hero h2{font-size:clamp(32px,3.5cqw,48px);font-weight:630;line-height:1.25;letter-spacing:-1.5px;white-space:pre-line}.hs-design .hs-hero-copy>p{max-width:380px;color:var(--dsw-alias-label-secondary);margin:18px 0 24px;line-height:1.9}.hs-design .hs-hero-art{display:grid;grid-template-columns:1.15fr 1fr;grid-template-rows:1fr 1fr;gap:10px;height:290px;min-width:0}.hs-design .hs-hero-art button{padding:0;border:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-2);border-radius:9px;overflow:hidden;min-width:0;position:relative}.hs-design .hs-hero-art button:first-child{grid-row:1/3}.hs-design .hs-hero-art img{width:100%;height:100%;object-fit:cover;object-position:center}.hs-design .hs-hero-art button:hover img{transform:scale(1.035)}.hs-design .hs-hero-art img{transition:transform .25s}.hs-design .hs-art-caption{grid-column:1/-1;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px}.hs-design .hs-section{margin:0 0 32px}.hs-design .hs-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:18px}.hs-design .hs-section-title p{color:var(--dsw-alias-label-secondary);font-size:14px;margin-top:4px}.hs-design .hs-section-title h2{font-size:20px;letter-spacing:-.4px}.hs-design .hs-format-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}.hs-design .hs-format-tile{border:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-1);padding:15px 10px;border-radius:10px;text-align:left;min-height:88px;min-width:0}.hs-design .hs-format-tile svg{display:block;margin-bottom:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-format-tile strong{display:block;font-size:14px;font-weight:550}.hs-design .hs-format-tile[aria-pressed=true]{border-color:var(--hs-accent-ink);background:color-mix(in srgb,var(--hs-accent-ink) 7%,var(--hs-bg-base))}.hs-design .hs-format-tile[aria-pressed=true] svg{color:var(--hs-accent-ink)}.hs-design .hs-format-tile:hover{background:var(--hs-bg-layer-2)}
.hs-design .hs-composer{border:1px solid var(--hs-border-l2);border-radius:14px;background:var(--hs-bg-layer-1);padding:24px;min-width:0}.hs-design .hs-composer-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:18px}.hs-design .hs-composer h2{font-size:23px;letter-spacing:-.5px}.hs-design .hs-format-select{display:flex;align-items:center;gap:8px;white-space:nowrap}.hs-design label{display:block;font-size:12px;font-weight:550}.hs-design input,.hs-design textarea,.hs-design select{display:block;width:100%;border:1px solid var(--hs-border-l2);border-radius:8px;background:var(--hs-bg-base);padding:11px 12px;min-height:44px}.hs-design .hs-format-select select{min-width:150px;font-size:13px;padding:8px 10px}.hs-design .hs-brief{margin-bottom:18px}.hs-design .hs-brief textarea{min-height:132px;resize:vertical;font-size:16px;line-height:1.85;padding:15px 16px;font-weight:400}.hs-design textarea::placeholder,.hs-design input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.85}.hs-design .hs-compose-bottom{display:flex;align-items:center;justify-content:space-between;gap:16px}.hs-design .hs-reference{display:flex;align-items:center;gap:10px;max-width:65%;min-width:0}.hs-design .hs-reference img{width:58px;height:42px;object-fit:cover;border:1px solid var(--hs-border-l1);border-radius:5px}.hs-design .hs-reference-text{min-width:0}.hs-design .hs-reference-name{display:block;max-width:260px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hs-design .hs-reference .hs-text-button{padding:0;min-height:44px;font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-reference-none{min-height:44px;border:1px dashed var(--hs-border-l2);border-radius:7px;background:transparent;padding:9px 13px;font-size:13px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-direction-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:14px}.hs-design .hs-draft{border-top:1px solid var(--hs-border-l1);margin-top:22px;padding-top:20px}.hs-design .hs-draft label{font-size:14px;margin-bottom:10px}.hs-design .hs-draft textarea{min-height:230px;resize:vertical;line-height:1.85;font-size:14px;font-weight:400}.hs-design .hs-draft-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px}.hs-design .hs-draft-foot p{font-size:12px;max-width:300px;color:var(--dsw-alias-label-secondary)}
.hs-design .hs-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px 18px}.hs-design .hs-style-card{min-width:0}.hs-design .hs-style-art{padding:0;width:100%;border:1px solid var(--hs-border-l1);border-radius:9px;background:var(--hs-bg-layer-2);overflow:hidden;position:relative;aspect-ratio:1.6;display:block}.hs-design .hs-style-art img{width:100%;height:100%;object-fit:cover;object-position:top;transition:transform .2s}.hs-design .hs-style-art:hover img{transform:scale(1.035)}.hs-design .hs-style-meta{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding-top:11px}.hs-design .hs-style-meta h3{font-size:14px;font-weight:550}.hs-design .hs-style-meta p{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px}.hs-design .hs-style-meta .hs-text-button{flex:none;min-width:44px;min-height:44px;padding:8px}.hs-design .hs-style-card[data-category=app] .hs-style-art,.hs-design .hs-style-card[data-category=xhs] .hs-style-art{background:var(--hs-bg-layer-2)}.hs-design .hs-style-card[data-category=app] .hs-style-art img,.hs-design .hs-style-card[data-category=xhs] .hs-style-art img{object-fit:contain}.hs-design .hs-style-card.is-chosen .hs-style-art{outline:2px solid var(--hs-accent-ink);outline-offset:3px}.hs-design .hs-filterbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:22px}.hs-design .hs-search{position:relative;flex:1;min-width:200px;max-width:340px}.hs-design .hs-search svg{position:absolute;left:13px;top:14px;pointer-events:none;color:var(--dsw-alias-label-secondary)}.hs-design .hs-search input{padding-left:39px;font-size:14px}.hs-design .hs-filter{border-color:transparent;background:transparent;padding:9px 12px;font-size:13px;gap:7px}.hs-design .hs-filter span{font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-filter[aria-pressed=true]{background:var(--hs-bg-layer-2);border-color:var(--hs-border-l1);font-weight:600}.hs-design .hs-page-title{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin:14px 0 24px}.hs-design .hs-page-title p{margin-top:9px;color:var(--dsw-alias-label-secondary);max-width:660px}.hs-design .hs-pagebar{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:28px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.hs-design .hs-preview{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(240px,.8fr);border:1px solid var(--hs-border-l1);border-radius:12px;overflow:hidden;margin-bottom:26px;background:var(--hs-bg-layer-1)}.hs-design .hs-preview-art{background:var(--hs-bg-layer-2);padding:18px;min-width:0}.hs-design .hs-preview-art img{width:100%;height:340px;object-fit:contain}.hs-design .hs-preview-copy{padding:24px;display:flex;flex-direction:column;align-items:flex-start;gap:14px}.hs-design .hs-preview-copy p{font-size:14px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-preview-copy>.hs-actions{margin-top:auto}.hs-design .hs-preview-top{display:flex;justify-content:space-between;width:100%;gap:10px}.hs-design .hs-preview-copy h3{font-size:20px}.hs-design .hs-preview-copy .hs-category{font-size:12px;color:var(--dsw-alias-label-secondary)}
.hs-design .hs-desk-layout{display:grid;grid-template-columns:minmax(320px,.85fr) minmax(0,1.15fr);gap:26px;align-items:start}.hs-design .hs-desk-brief{position:sticky;top:0}.hs-design .hs-desk-brief .hs-composer-head{display:block}.hs-design .hs-desk-brief .hs-format-select{margin-top:16px}.hs-design .hs-desk-brief .hs-format-select select{width:100%}.hs-design .hs-desk-brief .hs-brief textarea{min-height:220px}.hs-design .hs-desk-brief .hs-compose-bottom,.hs-design .hs-desk-brief .hs-draft-foot{align-items:stretch;flex-direction:column}.hs-design .hs-desk-brief .hs-reference{max-width:100%}.hs-design .hs-desk-samples .hs-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 14px}.hs-design .hs-desk-intro{margin-bottom:22px;padding:4px 0 22px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-desk-intro h2{font-size:28px;margin-bottom:10px}.hs-design .hs-desk-intro p{color:var(--dsw-alias-label-secondary)}
.hs-design .hs-index-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:32px;align-items:start}.hs-design .hs-index-rail{position:sticky;top:0;border-right:1px solid var(--hs-border-l1);padding:8px 18px 14px 0}.hs-design .hs-index-rail h2{font-size:14px;margin-bottom:12px;color:var(--dsw-alias-label-secondary);font-weight:500}.hs-design .hs-index-rail button{display:flex;justify-content:space-between;width:100%;min-height:48px;padding:11px 10px;border:0;border-radius:6px;background:transparent;text-align:left;font-size:14px}.hs-design .hs-index-rail button[aria-pressed=true]{background:var(--hs-bg-layer-2);font-weight:600}.hs-design .hs-index-rail button:hover{background:var(--hs-bg-layer-1)}.hs-design .hs-index-rail small{font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-index-heading{display:flex;gap:22px;align-items:center;margin-bottom:24px;padding:8px 0 22px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-index-heading img{width:180px;height:112px;object-fit:cover;border-radius:6px}.hs-design .hs-index-heading h2{font-size:30px;margin-bottom:8px}.hs-design .hs-index-heading p{color:var(--dsw-alias-label-secondary)}.hs-design .hs-index-meta{display:flex;gap:18px;flex-wrap:wrap;margin:14px 0 22px;font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-index-samples{display:flex;gap:12px;overflow:auto;padding:5px 4px 12px;margin:0 -4px 20px;scroll-snap-type:x proximity}.hs-design .hs-index-samples .hs-style-card{flex:0 0 200px;scroll-snap-align:start}.hs-design .hs-index-samples .hs-style-meta p{display:none}.hs-design .hs-index-samples .hs-style-meta h3{font-size:13px}
.hs-design .hs-flow-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.hs-design .hs-flow{padding:24px;border:1px solid var(--hs-border-l1);border-radius:10px;background:var(--hs-bg-layer-1);display:grid;grid-template-columns:44px minmax(0,1fr);gap:18px}.hs-design .hs-flow>svg{color:var(--hs-accent-ink);margin-top:2px}.hs-design .hs-flow h3{font-size:18px;margin-bottom:8px}.hs-design .hs-flow p{font-size:14px;color:var(--dsw-alias-label-secondary);margin-bottom:18px}.hs-design .hs-method{display:flex;gap:0;margin:24px 0 28px;border:1px solid var(--hs-border-l1);border-radius:10px;overflow:hidden}.hs-design .hs-method div{flex:1;padding:18px;background:var(--hs-bg-layer-1);font-size:14px}.hs-design .hs-method div+div{border-left:1px solid var(--hs-border-l1)}.hs-design .hs-method svg{display:block;margin-bottom:13px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-guide-list{border-top:1px solid var(--hs-border-l1)}.hs-design .hs-guide-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-guide-row p{font-size:14px;color:var(--dsw-alias-label-secondary);margin-top:3px}.hs-design .hs-guide-row .hs-button{flex:none}.hs-design .hs-doc{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.95 ui-monospace,monospace;margin:18px 0}.hs-design .hs-docbox{padding:24px;border:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-1);border-radius:10px;margin:24px 0}.hs-design .hs-path{font:12px/1.7 ui-monospace,monospace;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.hs-design .hs-empty{display:grid;grid-template-columns:180px minmax(0,450px);justify-content:center;align-items:center;gap:30px;padding:46px 30px;border:1px solid var(--hs-border-l1);border-radius:12px;background:var(--hs-bg-layer-1)}.hs-design .hs-empty-art{display:grid;grid-template-columns:1fr 1fr;gap:6px;transform:rotate(-5deg)}.hs-design .hs-empty-art img{height:72px;width:100%;object-fit:cover;border:1px solid var(--hs-border-l2);border-radius:5px}.hs-design .hs-empty-art img:first-child{margin-top:14px}.hs-design .hs-empty h3{font-size:22px;margin-bottom:10px}.hs-design .hs-empty p{color:var(--dsw-alias-label-secondary);font-size:14px;margin-bottom:20px}.hs-design .hs-work{border:1px solid var(--hs-border-l1);border-radius:10px;overflow:hidden;min-width:0;background:var(--hs-bg-layer-1)}.hs-design .hs-work-cover{height:150px;display:flex;align-items:center;justify-content:center;background:var(--hs-bg-layer-2);border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-work-cover>img{width:100%;height:100%;object-fit:contain}.hs-design .hs-work-cover>svg{color:var(--dsw-alias-label-secondary)}.hs-design .hs-work-copy{padding:18px}.hs-design .hs-work-copy h3{margin:6px 0 9px}.hs-design .hs-work-copy>p{font-size:14px;color:var(--dsw-alias-label-secondary);margin-bottom:13px}.hs-design .hs-work-copy>.hs-actions{margin-top:12px}.hs-design .hs-add-form{max-width:740px;margin:0 0 28px}.hs-design .hs-add-form label{margin-bottom:16px}.hs-design .hs-add-form input,.hs-design .hs-add-form select{margin-top:6px}.hs-design .hs-form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.hs-design .hs-concepts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:26px}.hs-design .hs-concept{border:1px solid var(--hs-border-l1);border-radius:9px;overflow:hidden;background:var(--hs-bg-layer-1)}.hs-design .hs-concept-scene{height:156px;display:grid;gap:6px;padding:12px;background:var(--hs-bg-layer-2);overflow:hidden}.hs-design .hs-concept-scene img{width:100%;height:100%;object-fit:cover;min-height:0;min-width:0}.hs-design .hs-concept-scene strong{font-size:18px;line-height:1.3;letter-spacing:-.5px}.hs-design .hs-concept-scene small{font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-concept-scene em{font-style:normal;font-size:12px;display:block;padding:7px;border:1px solid var(--hs-border-l2);background:var(--hs-bg-base);border-radius:4px}.hs-design .hs-concept-scene>div{min-width:0;overflow:hidden}.hs-design .hs-concept[data-thumb="1"] .hs-concept-scene{grid-template-columns:1fr 1.3fr;align-items:center}.hs-design .hs-concept[data-thumb="2"] .hs-concept-scene{grid-template-columns:1fr 1fr;border-bottom:3px solid var(--dsw-alias-label-primary)}.hs-design .hs-concept[data-thumb="2"] strong{font-size:18px}.hs-design .hs-concept[data-thumb="3"] .hs-concept-scene{grid-template-columns:1fr 1fr}.hs-design .hs-concept[data-thumb="3"] .hs-concept-scene>div{display:flex;flex-direction:column;gap:7px}.hs-design .hs-concept[data-thumb="4"] .hs-concept-scene{grid-template-columns:55px 1fr 1fr}.hs-design .hs-concept[data-thumb="5"] .hs-concept-scene{grid-template-columns:65px 1fr}.hs-design .hs-concept[data-thumb="6"] .hs-concept-scene{grid-template-columns:1fr 1fr;gap:20px}.hs-design .hs-concept[data-thumb="6"] strong{font-family:serif;writing-mode:vertical-rl;font-size:28px}.hs-design .hs-concept-caption{padding:12px;display:flex;align-items:center;justify-content:space-between;gap:6px}.hs-design .hs-concept-caption strong{font-size:13px}.hs-design .hs-concept-caption small{font-size:12px;color:var(--dsw-alias-label-secondary)}
@container(max-width:1000px){.hs-design .hs-wrap{padding:22px 24px 28px}.hs-design .hs-topbar{align-items:flex-start}.hs-design .hs-brand-note{display:none}.hs-design .hs-nav button{padding:10px}.hs-design .hs-format-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.hs-design .hs-hero{gap:24px}.hs-design .hs-hero-art{height:260px}.hs-design .hs-hero h2{font-size:36px}.hs-design .hs-desk-layout{grid-template-columns:minmax(280px,.85fr) minmax(0,1fr);gap:20px}.hs-design .hs-composer{padding:20px}.hs-design .hs-index-layout{grid-template-columns:160px minmax(0,1fr);gap:22px}.hs-design .hs-compose-bottom{flex-wrap:wrap}.hs-design .hs-reference{max-width:100%}.hs-design .hs-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hs-design .hs-concepts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container(max-width:720px){.hs-design .hs-topbar{display:block}.hs-design .hs-nav{margin-top:14px;gap:3px}.hs-design .hs-nav button{flex:1;font-size:13px;padding:10px 8px}.hs-design .hs-direction{display:block;padding:14px 0 20px}.hs-design .hs-direction-switch{margin-top:8px;width:max-content;max-width:100%;flex-wrap:wrap}.hs-design .hs-direction-switch button{font-size:13px;padding:8px 10px;min-height:44px}.hs-design .hs-direction>.hs-text-button{margin-top:4px}.hs-design .hs-hero{grid-template-columns:1fr;gap:24px;padding-top:8px}.hs-design .hs-hero h2{font-size:38px}.hs-design .hs-hero-copy>p{max-width:100%;margin:14px 0 20px}.hs-design .hs-hero-art{height:250px}.hs-design .hs-desk-layout{grid-template-columns:1fr}.hs-design .hs-desk-brief{position:static}.hs-design .hs-desk-brief .hs-brief textarea{min-height:150px}.hs-design .hs-index-layout{grid-template-columns:1fr;gap:16px}.hs-design .hs-index-rail{position:static;border-right:0;border-bottom:1px solid var(--hs-border-l1);display:flex;gap:5px;overflow:auto;padding:0 0 12px}.hs-design .hs-index-rail h2{display:none}.hs-design .hs-index-rail button{flex:0 0 auto;width:auto;gap:14px}.hs-design .hs-index-heading{gap:16px}.hs-design .hs-index-heading img{width:140px;height:100px}.hs-design .hs-index-heading h2{font-size:25px}.hs-design .hs-preview{grid-template-columns:1fr}.hs-design .hs-preview-art img{height:280px}.hs-design .hs-method{display:grid;grid-template-columns:1fr 1fr}.hs-design .hs-method div+div{border-left:0}.hs-design .hs-method div:nth-child(even){border-left:1px solid var(--hs-border-l1)}.hs-design .hs-method div:nth-child(n+3){border-top:1px solid var(--hs-border-l1)}.hs-design .hs-flow-list{grid-template-columns:1fr}}
@container(max-width:450px){.hs-design .hs-wrap{padding:18px 16px 24px;font-size:16px}.hs-design .hs-guide-row p,.hs-design .hs-flow p,.hs-design .hs-work-copy>p,.hs-design .hs-page-title p,.hs-design .hs-preview-copy p{font-size:16px}.hs-design .hs-hero h2{font-size:34px}.hs-design .hs-hero-art{height:215px}.hs-design .hs-format-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hs-design .hs-format-tile{min-height:72px;display:flex;gap:12px;align-items:center;padding:13px}.hs-design .hs-format-tile svg{margin:0;flex:none}.hs-design .hs-composer-head{display:block}.hs-design .hs-format-select{margin-top:14px}.hs-design .hs-format-select select{width:100%}.hs-design .hs-composer{padding:18px}.hs-design .hs-composer h2{font-size:22px}.hs-design .hs-compose-bottom,.hs-design .hs-draft-foot{display:flex;align-items:stretch;flex-direction:column}.hs-design .hs-compose-bottom>.hs-button{width:100%}.hs-design .hs-grid,.hs-design .hs-desk-samples .hs-grid{grid-template-columns:1fr}.hs-design .hs-page-title{display:block}.hs-design .hs-page-title>.hs-actions{margin-top:16px}.hs-design .hs-filterbar{gap:3px}.hs-design .hs-search{max-width:none;flex-basis:100%;margin-bottom:8px}.hs-design .hs-empty{grid-template-columns:1fr;padding:28px 22px;gap:24px}.hs-design .hs-empty-art{width:160px;margin:auto}.hs-design .hs-form-row{grid-template-columns:1fr;gap:0}.hs-design .hs-guide-row{align-items:flex-start;flex-direction:column;gap:12px}.hs-design .hs-concepts{grid-template-columns:1fr}.hs-design .hs-index-heading img{width:100px;height:100px}.hs-design .hs-index-heading h2{font-size:23px}.hs-design .hs-direction-switch{width:100%}.hs-design .hs-direction-switch button{flex:1;white-space:nowrap;font-size:13px;padding:8px 5px}}
.hs-design .hs-hero-art{animation:hs-media-enter .24s ease-out}.hs-design .hs-hero-art[data-media=app] img,.hs-design .hs-hero-art[data-media=xiaohongshu] img{object-fit:contain}@keyframes hs-media-enter{from{opacity:.25;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
.hs-design .hs-style-meta{display:block}.hs-design .hs-style-meta h3{margin-bottom:10px;line-height:1.55}.hs-design .hs-style-tags{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-style-tags>span{border:1px solid var(--hs-border-l1);padding:3px 7px;border-radius:5px;background:var(--hs-bg-layer-1)}.hs-design .hs-style-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px}.hs-design .hs-style-actions>.hs-text-button{padding:6px 0}.hs-design .hs-style-actions>.hs-text-button:last-child{padding:6px 10px;border:1px solid var(--hs-border-l1);border-radius:7px}.hs-design .hs-style-notes{grid-column:1/-1;border-top:1px solid var(--hs-border-l1);padding:24px;background:var(--hs-bg-base)}.hs-design .hs-note-heading{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:18px}.hs-design .hs-note-heading h4{font-size:19px}.hs-design .hs-note-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.hs-design .hs-note-card{min-width:0;padding:17px 18px;background:var(--hs-bg-layer-1);border:1px solid var(--hs-border-l1);border-radius:9px}.hs-design .hs-note-card h5,.hs-design .hs-note-palette h5{font-size:13px;color:var(--dsw-alias-label-secondary);margin-bottom:9px;font-weight:600}.hs-design .hs-note-card p{font-size:14px;line-height:1.9;overflow-wrap:anywhere;white-space:pre-wrap}.hs-design .hs-note-useCases,.hs-design .hs-note-visualDNA,.hs-design .hs-note-implementation{grid-column:1/-1}.hs-design .hs-note-card code{font-family:ui-monospace,Consolas,monospace;background:var(--hs-bg-layer-2);padding:2px 4px;border-radius:3px}.hs-design .hs-note-palette{margin-top:20px}.hs-design .hs-palette-values{display:flex;flex-wrap:wrap;gap:10px 18px}.hs-design .hs-palette-values>span{display:flex;align-items:center;gap:7px;font-size:12px}.hs-design .hs-palette-values i{display:block;width:22px;height:22px;border-radius:50%;border:1px solid var(--hs-border-l2)}.hs-design .hs-note-foot{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin-top:18px}@container(max-width:600px){.hs-design .hs-style-notes{padding:18px}.hs-design .hs-note-grid{grid-template-columns:1fr}.hs-design .hs-note-card p{font-size:16px}.hs-design .hs-note-heading{flex-wrap:wrap}.hs-design .hs-note-card{padding:15px}}
.hs-design .hs-reader{margin-top:24px;border:1px solid var(--hs-border-l1);border-radius:14px;background:var(--hs-bg-base);overflow:clip}.hs-design .hs-reader-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 22px;border-bottom:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-1)}.hs-design .hs-reader-heading{padding:32px 36px 28px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-reader-eyebrow{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:12px}.hs-design .hs-reader-heading h2{font-size:32px;line-height:1.4;letter-spacing:-.5px;max-width:1000px;overflow-wrap:anywhere}.hs-design .hs-reader-meta{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-reader-layout{display:grid;grid-template-columns:220px minmax(0,1fr);align-items:start}.hs-design .hs-reader-layout.is-raw{grid-template-columns:minmax(0,1fr)}.hs-design .hs-reader-toc{position:sticky;top:18px;padding:24px 16px;border-right:1px solid var(--hs-border-l1);max-height:calc(100dvh - 140px);overflow:auto;min-width:0}.hs-design .hs-reader-toc h3{font-size:13px;margin:0 10px 14px;font-weight:650}.hs-design .hs-reader-toc input{font-size:14px;margin-bottom:12px}.hs-design .hs-reader-toc nav>button{display:block;width:100%;text-align:left;min-height:44px;padding:8px 9px 8px calc(10px + var(--hs-level)*10px);font-size:13px;line-height:1.55;overflow-wrap:anywhere;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary)}.hs-design .hs-reader-toc nav>button:hover,.hs-design .hs-reader-toc nav>button[aria-current=location]{background:var(--hs-bg-layer-2);color:var(--hs-accent-ink)}.hs-design .hs-reader-toc nav>button[aria-current=location]{font-weight:650}.hs-design .hs-doc-toc-toggle{display:none}.hs-design .hs-prose{min-width:0;width:100%;max-width:900px;margin:0 auto;padding:30px 36px 44px;font-size:16px;line-height:1.9;overflow-wrap:anywhere}.hs-design .hs-prose p{margin:14px 0}.hs-design .hs-prose h3{font-size:25px;line-height:1.5;margin:34px 0 16px;letter-spacing:-.3px}.hs-design .hs-prose h4{font-size:20px;line-height:1.6;margin:28px 0 12px}.hs-design .hs-prose h5,.hs-design .hs-prose h6{font-size:17px;line-height:1.6;margin:22px 0 10px}.hs-design .hs-prose>h3:first-child,.hs-design .hs-prose>h4:first-child{margin-top:0}.hs-design .hs-prose ul,.hs-design .hs-prose ol{padding-left:1.65em;margin:14px 0}.hs-design .hs-prose ul{list-style-type:disc}.hs-design .hs-prose ol{list-style-type:decimal}.hs-design .hs-prose li+li{margin-top:8px}.hs-design .hs-prose li>p{margin:6px 0}.hs-design .hs-prose li::marker{color:var(--dsw-alias-label-secondary)}.hs-design .hs-prose a{color:var(--hs-accent-ink);text-decoration:underline;text-underline-offset:3px}.hs-design .hs-prose code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.88em;background:var(--hs-bg-layer-2);padding:2px 5px;border-radius:4px}.hs-design .hs-doc-code{margin:20px 0;border:1px solid var(--hs-border-l1);border-radius:9px;overflow:hidden;background:var(--hs-bg-layer-1)}.hs-design .hs-doc-code-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px 6px 16px;border-bottom:1px solid var(--hs-border-l1);background:var(--hs-bg-layer-2)}.hs-design .hs-doc-code-label{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:lowercase;color:var(--dsw-alias-label-secondary)}.hs-design .hs-doc-code-copy{min-height:26px;padding:2px 10px;font-size:12px;line-height:1.5;border:1px solid var(--hs-border-l1);border-radius:5px;background:var(--hs-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer}.hs-design .hs-doc-code-copy:hover{color:var(--hs-accent-ink);border-color:var(--hs-accent-ink)}.hs-design .hs-doc-code-copy[data-copied=true]{color:var(--hs-accent-ink);border-color:var(--hs-accent-ink)}.hs-design .hs-doc-code pre:focus-visible{outline:2px solid var(--hs-accent-ink);outline-offset:-2px}.hs-design .hs-tok-keyword{color:var(--hs-accent-ink);font-weight:600}.hs-design .hs-tok-string{color:var(--dsw-alias-state-success-primary,#3f7d4f)}.hs-design .hs-tok-comment{color:var(--dsw-alias-label-secondary);font-style:italic}.hs-design .hs-tok-number{color:var(--dsw-alias-state-warning-primary,#a8742c)}.hs-design .hs-tok-constant{color:var(--dsw-alias-state-warning-primary,#a8742c)}.hs-design .hs-tok-function{color:var(--hs-accent-ink)}.hs-design .hs-tok-property{color:var(--dsw-alias-label-primary)}.hs-design .hs-tok-word{color:inherit}.hs-design .hs-tok-plain{color:inherit}.hs-design .hs-tok-tag{color:var(--hs-accent-ink)}.hs-design .hs-tok-atrule{color:var(--dsw-alias-state-error-primary,#a52d22)}.hs-design .hs-tok-selector{color:var(--dsw-alias-label-primary);font-weight:600}.hs-design .hs-tok-variable{color:var(--dsw-alias-state-warning-primary,#a8742c)}.hs-design .hs-tok-flag{color:var(--dsw-alias-label-secondary)}.hs-design .hs-tok-operator{color:var(--dsw-alias-label-secondary)}.hs-design .hs-tok-punct{color:var(--dsw-alias-label-secondary)}.hs-design .hs-tok-bullet{color:var(--dsw-alias-label-secondary)}.hs-design .hs-tok-quote{color:var(--dsw-alias-label-secondary);font-style:italic}.hs-design .hs-tok-link{color:var(--hs-accent-ink);text-decoration:underline;text-underline-offset:2px}.hs-design .hs-tok-bold{font-weight:700}.hs-design .hs-tok-italic{font-style:italic}.hs-design .hs-prose pre{margin:0;padding:16px;max-width:100%;max-height:620px;overflow:auto;white-space:pre;line-height:1.7;font-size:14px}.hs-design .hs-prose pre code{font-size:inherit;background:transparent;padding:0;white-space:pre}.hs-design .hs-doc-html,.hs-design .hs-reader-raw{background:var(--hs-bg-layer-1);border:1px solid var(--hs-border-l1);border-radius:8px}.hs-design .hs-prose .hs-reader-raw{max-height:none}.hs-design .hs-prose blockquote{margin:22px 0;padding:2px 0 2px 18px;border-left:3px solid var(--hs-border-l2);color:var(--dsw-alias-label-secondary)}.hs-design .hs-prose hr{margin:32px 0;border:0;border-top:1px solid var(--hs-border-l1)}.hs-design .hs-prose img{display:block;max-width:100%;max-height:600px;object-fit:contain;margin:20px auto;border:1px solid var(--hs-border-l1);border-radius:8px}.hs-design .hs-doc-table{overflow:auto;max-width:100%;margin:22px 0;border:1px solid var(--hs-border-l1);border-radius:8px}.hs-design .hs-doc-table table{border-collapse:collapse;width:100%;min-width:480px;font-size:14px;line-height:1.75}.hs-design .hs-doc-table th,.hs-design .hs-doc-table td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--hs-border-l1);vertical-align:top;min-width:110px}.hs-design .hs-doc-table th{font-size:13px;font-weight:650;background:var(--hs-bg-layer-2)}.hs-design .hs-doc-table tbody tr:last-child td{border-bottom:0}.hs-design .hs-doc-table tbody tr:nth-child(even){background:var(--hs-bg-layer-1)}.hs-design .hs-prose .hs-doc-task{list-style:none}.hs-design .hs-prose input[type=checkbox]{display:inline-block;width:16px;height:16px;min-height:0;padding:0;margin-right:9px;vertical-align:middle;accent-color:var(--hs-accent-ink)}.hs-design .hs-reader-loading,.hs-design .hs-reader-notice{padding:14px 36px;color:var(--dsw-alias-label-secondary);font-size:14px;background:var(--hs-bg-layer-1)}.hs-design .hs-reader-loading progress{display:block;width:100%;height:5px;margin-top:10px;accent-color:var(--hs-accent-ink)}.hs-design .hs-reader-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 28px;border-top:1px solid var(--hs-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-doc-more{padding-top:24px;margin-top:30px;border-top:1px solid var(--hs-border-l1)}.hs-design .hs-doc-more p{font-size:14px;color:var(--dsw-alias-label-secondary)}
@container(max-width:900px){.hs-design .hs-reader-layout{grid-template-columns:minmax(0,1fr)}.hs-design .hs-reader-toc{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--hs-border-l1);padding:14px 24px}.hs-design .hs-reader-toc h3{display:none}.hs-design .hs-doc-toc-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:44px;background:transparent;border:0;text-align:left;font-size:14px}.hs-design .hs-reader-toc nav{display:none;margin-top:12px;max-height:360px;overflow:auto}.hs-design .hs-reader-toc.is-open nav{display:block}.hs-design .hs-prose{padding:26px}.hs-design .hs-reader-heading{padding:28px 26px}.hs-design .hs-reader-heading h2{font-size:28px}.hs-design .hs-reader-toc input{font-size:16px}}
@container(max-width:450px){.hs-design .hs-reader-toolbar{padding:10px 14px;gap:6px}.hs-design .hs-reader-toolbar>.hs-actions{gap:4px}.hs-design .hs-reader-heading{padding:22px 20px}.hs-design .hs-reader-heading h2{font-size:25px}.hs-design .hs-reader-toc{padding:12px 18px}.hs-design .hs-prose{padding:22px 20px;font-size:16px}.hs-design .hs-prose h3{font-size:23px}.hs-design .hs-reader-loading,.hs-design .hs-reader-notice{padding:14px 20px}.hs-design .hs-reader-footer{padding:14px 20px}}
.hs-design .hs-output-format{margin-bottom:18px}.hs-design .hs-output-format label{max-width:360px}.hs-design .hs-output-format select{margin-top:6px}.hs-design .hs-output-format p{margin-top:7px}.hs-design .hs-workspace-picker{margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-workspace-row{display:flex;gap:12px;align-items:flex-end}.hs-design .hs-workspace-row>label{flex:0 1 320px;width:min(100%,320px);max-width:100%;min-width:0}.hs-design .hs-workspace-row select{margin-top:6px;font-size:14px;text-overflow:ellipsis}.hs-design .hs-workspace-row>.hs-text-button{flex:none}.hs-design .hs-workspace-picker .hs-path{margin:8px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-break:normal}.hs-design .hs-workspace-add{display:flex;gap:10px;align-items:flex-end;margin-top:14px}.hs-design .hs-workspace-add>label{flex:1;min-width:0}.hs-design .hs-workspace-add input{margin-top:6px}.hs-design .hs-revision-context{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0 18px}.hs-design .hs-source-editor{padding:24px;border:1px solid var(--hs-border-l2);border-radius:14px;background:var(--hs-bg-layer-1);margin-bottom:28px}.hs-design .hs-source-text{height:440px;min-height:240px;font:14px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;tab-size:2;white-space:pre}.hs-design .hs-source-editor>.hs-path{margin:12px 0}.hs-design .hs-source-editor>.hs-actions{margin-top:16px}.hs-design .hs-source-editor .hs-actions>.hs-small{flex-basis:100%}.hs-design .hs-source-confirm{margin-top:18px;padding:14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px}.hs-design .hs-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:12px 0}.hs-design .hs-status{color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere;margin:12px 0}
@container(max-width:550px){.hs-design .hs-workspace-row>label{flex:initial;width:100%}.hs-design .hs-workspace-row,.hs-design .hs-workspace-add{align-items:stretch;flex-direction:column}.hs-design .hs-workspace-row>.hs-text-button{align-self:flex-start}.hs-design .hs-source-editor{padding:18px}.hs-design .hs-source-text{font-size:16px}.hs-design .hs-compose-bottom>.hs-actions{justify-content:space-between;flex-wrap:wrap}}
.hs-design .hs-palette{position:relative;flex:none}.hs-design .hs-palette-trigger{white-space:nowrap;background:var(--hs-bg-layer-1);border-color:var(--hs-border-l2)}.hs-design .hs-color-dot{display:inline-block;flex:none;width:16px;height:16px;border-radius:50%;border:1px solid var(--hs-border-l2)}.hs-design .hs-palette-options{position:absolute;right:0;top:calc(100% + 8px);z-index:240;width:min(340px,calc(100cqw - 32px));padding:14px;border:1px solid var(--hs-border-l2);border-radius:12px;background:var(--hs-bg-layer-1);box-shadow:0 10px 36px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}.hs-design .hs-palette-presets{display:grid;grid-template-columns:1fr 1fr;gap:7px}.hs-design .hs-palette-option{display:flex;align-items:center;gap:8px;min-height:44px;padding:9px 10px;border:1px solid var(--hs-border-l1);border-radius:8px;background:var(--hs-bg-base);text-align:left;font-size:13px}.hs-design .hs-palette-option>svg{margin-left:auto;color:var(--hs-accent-ink)}.hs-design .hs-palette-option[aria-pressed=true]{border-color:var(--hs-accent-ink);background:var(--hs-accent-soft);font-weight:650}.hs-design .hs-palette-option:hover{background:var(--hs-bg-layer-2)}.hs-design .hs-palette-host{width:100%;margin-top:8px}.hs-design .hs-palette-custom{display:grid;grid-template-columns:1fr 44px;gap:6px 12px;align-items:center;padding-top:12px;margin-top:12px;border-top:1px solid var(--hs-border-l1)}.hs-design .hs-palette-custom-select{display:flex;align-items:center;gap:8px;padding:0;background:transparent;border:0;min-height:38px;text-align:left;font-size:12px}.hs-design .hs-palette-custom-select[aria-pressed=true]{color:var(--hs-accent-ink);font-weight:650}.hs-design .hs-palette-custom input[type=color]{width:44px;height:38px;min-height:38px;padding:3px;cursor:pointer}.hs-design .hs-palette-custom code{grid-column:1/-1;font-size:12px;color:var(--dsw-alias-label-secondary)}.hs-design .hs-palette-options>p{margin-top:12px;line-height:1.6}.hs-design .hs-host-color-probe{position:absolute;left:0;top:0;opacity:0;pointer-events:none;font-size:1px;width:1px;height:1px;overflow:hidden}
@container(max-width:1000px){.hs-design .hs-topbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center}.hs-design .hs-palette{margin-left:auto;order:2}.hs-design .hs-nav{order:3;flex-basis:100%;margin-top:0}.hs-design .hs-palette-trigger{padding:9px 11px;font-size:13px}}
.hs-design.is-viewer-open{overflow:hidden;scroll-behavior:auto}.hs-design .hs-work-preview{position:absolute;inset:0;z-index:3000;margin:0;border:0;border-radius:0;background:var(--hs-bg-layer-1);overflow:hidden;display:flex;flex-direction:column;min-height:0}.hs-design .hs-work-preview[hidden]{display:none}.hs-design .hs-work-preview-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 18px;border-bottom:1px solid var(--hs-border-l1)}.hs-design .hs-work-preview-heading h2{font-size:19px;margin-top:3px;overflow-wrap:anywhere}.hs-design .hs-preview-note,.hs-design .hs-preview-warnings{padding:10px 18px;font-size:13px;line-height:1.6}.hs-design .hs-preview-warnings{padding-left:34px}.hs-design .hs-preview-confirm{padding:14px 18px;border-bottom:1px solid var(--hs-border-l1);background:var(--hs-accent-soft)}.hs-design .hs-preview-confirm .hs-actions{margin-top:10px}.hs-design .hs-work-preview-frame{display:block;width:100%;height:76vh;min-height:420px;border:0;background:var(--hs-bg-base)}.hs-design button.hs-work-preview-cover{width:100%;padding:0;border:0;border-bottom:1px solid var(--hs-border-l1);border-radius:0;cursor:pointer}.hs-design .hs-work-preview-cover:hover{box-shadow:inset 0 0 0 2px var(--hs-accent-ink)}.hs-design .hs-work-preview-cover img{object-position:top}.hs-design .hs-work-copy .hs-work-note{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.55}.hs-design .hs-work-copy .hs-work-path{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-break:normal}
@media(pointer:fine) and (min-width:721px){.hs-design .hs-button,.hs-design .hs-text-button{min-height:34px;min-width:30px;padding:6px 11px;font-size:13px}.hs-design .hs-primary{min-height:36px;padding:7px 13px}.hs-design .hs-nav button{min-height:34px;padding:6px 11px;font-size:13px}.hs-design .hs-palette-trigger,.hs-design .hs-palette-option{min-height:34px;padding:6px 10px;font-size:13px}.hs-design .hs-palette-custom-select{min-height:32px}.hs-design .hs-actions{gap:7px}.hs-design .hs-text-button:has(>svg:only-child){min-height:30px;min-width:30px;padding:5px}.hs-design .hs-topbar{padding-bottom:17px}}
@media(pointer:coarse),(max-width:720px){.hs-design .hs-button,.hs-design .hs-text-button,.hs-design .hs-nav button,.hs-design .hs-palette-trigger,.hs-design .hs-palette-option,.hs-design .hs-palette-custom-select{min-height:44px;min-width:44px}.hs-design .hs-work-preview-frame{height:68vh;min-height:360px}}
@container(max-width:720px){.hs-design .hs-button,.hs-design .hs-text-button,.hs-design .hs-nav button,.hs-design .hs-palette-trigger,.hs-design .hs-palette-option,.hs-design .hs-palette-custom-select{min-height:44px;min-width:44px}.hs-design .hs-work-preview-heading{padding:12px}.hs-design .hs-work-preview-frame{height:68vh;min-height:360px}}
.hs-design button.hs-work-preview-cover{position:relative;height:230px}.hs-design .hs-work-miniature{position:absolute;inset:0;display:block;overflow:hidden;pointer-events:none}.hs-design .hs-work-miniature>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top}.hs-design .hs-work-miniature-frame{position:absolute;inset:0 auto auto 0;display:block;width:1280px;height:960px;border:0;max-width:none;transform-origin:top left;pointer-events:none;background:var(--hs-bg-base)}.hs-design .hs-work-preview .hs-work-preview-frame{height:0;min-height:0;flex:1 1 auto}.hs-design .hs-work-preview-heading,.hs-design .hs-preview-note,.hs-design .hs-preview-warnings,.hs-design .hs-preview-confirm{flex:none}
@media(prefers-reduced-motion:reduce){.hs-design{scroll-behavior:auto}.hs-design *{transition:none!important;animation:none!important}}
`;
    function Icon({ size = 20, kind }) {
      const paths = {
        web:'M3 5h18v14H3zM3 9h18M7 7h.01M10 7h.01', deck:'M4 4h16v12H4zM12 16v5M8 21h8M8 8h8M8 12h5',
        motion:'m9 7 8 5-8 5zM3 3h18v18H3z', infographic:'M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7',
        app:'M7 2h10v20H7zM11 18h2', critique:'m9 11 2 2 4-4M4 3h16v18H4z',
        xiaohongshu:'M5 3h14v18H5zM8 7h8M8 11h6M8 15h8', search:'m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        arrow:'M5 12h14m-5-5 5 5-5 5', close:'m6 6 12 12M6 18 18 6', add:'M12 5v14M5 12h14', book:'M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 1-3-2-6-2-9-1zM12 6v14',
        explore:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4 5-2 6-6 2 2-6z', check:'m5 12 4 4L19 6', library:'M4 3h5v18H4zM11 3h4v18h-4zM17 4l4-1v17l-4 1z'
      };
      return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[kind]||'M7 7h10v10H7zM12 2v5M12 17v5M2 12h5M17 12h5M4 4l3 3M17 17l3 3M4 20l3-3M17 7l3-3'}));
    }
    async function action(name,args={},signal) {
      const response=await fetch('/huashu-design/api/action',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:name,args}),signal});
      const result=await response.json();
      if(!response.ok||result.error){const error=new Error(result.error?.message||`HTTP ${response.status}`);error.code=result.error?.code;error.status=response.status;throw error;}
      return result;
    }
    // Pure orchestration: use the native Session admission path, including its submission identity.
    async function submitWorkspacePrompt(services,workspaceId,text) {
      if(!workspaceId||!text.trim())throw new Error('Workspace and message are required.');
      const sessionId=await services.uiWorkspace.connectWorkspace(workspaceId);
      try {
        await services.sessions.using(sessionId,{source:'controllerOperation'},async reference=>{
          const {session}=await reference.ready;
          const submission=session.beginSubmission({mode:'queue',text,attachments:[]});
          try {
            const result=await session.prompt([{type:'text',text}],'queue',undefined,submission.requestId);
            if(!result.ok)throw new Error(result.error?.message||result.error?.code||'Message was not accepted.');
          } catch(error){submission.abandon();throw error;}
        });
      } catch(error){const failure=new Error(error?.message||String(error));failure.sessionId=sessionId;throw failure;}
      return sessionId;
    }
    // End pure submission orchestration.
    function projectInWorkspace(directory,workspacePath) {
      if(!directory||!workspacePath)return false;
      const normalize=value=>{const clean=value.replace(/\\/g,'/').replace(/\/+$/,'')||'/';return /^(?:[a-z]:|\/\/)/i.test(clean)?clean.toLowerCase():clean;};
      const target=normalize(directory),base=normalize(workspacePath);
      return target===base||(base==='/'?target.startsWith('/'):target.startsWith(base+'/'));
    }
    // End pure path matching.
    function createViewStore(initial) {
      let snapshot=initial;
      const listeners=new Set();
      return {
        getSnapshot:()=>snapshot,
        subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
        set(key,value){const next=typeof value==='function'?value(snapshot[key]):value;if(Object.is(next,snapshot[key]))return;snapshot={...snapshot,[key]:next};for(const listener of listeners)listener();}
      };
    }
    // End pure view store.
    return {
      inject:['slots','uiWorkspace','workspaces','sessions','locale'],
      apply(ctx) {
        ctx.effect(()=>ctx.locale.register(NS,'zh',dicts.zh));
        ctx.effect(()=>ctx.locale.register(NS,'en',dicts.en));
        const t=ctx.locale.bind(NS);
        const viewStore=createViewStore({...readThemePreference(),workspaceId:'',workspaceForm:false,newWorkspacePath:'',workspaceBusy:false,sending:false,sentSession:'',editingWork:null,editor:null,sourceText:'',sourceBusy:false,sourceNotice:'',sourceFailure:false,brief:'',draft:'',task:'web',style:'',outputMode:'standard',handoffBusy:'',previewDirty:false,error:'',status:'',handbook:null});
        const sendGuard={current:false},handoffGuard={current:false},creationState={current:null},docHistory={current:[]},docAnchorRef={current:null};
        ctx.effect(()=>{const warn=e=>{const value=viewStore.getSnapshot();if((value.editor&&value.sourceText!==value.editor.content)||value.brief||value.draft||value.previewDirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);});
        const htmlPreviewCache=createWorkPreviewCache(item=>action('preview',{id:item.id}));
        function PrintpressPanel({locale,onEvent}) {
          const element=React.useRef(null),controller=React.useRef(null),eventRef=React.useRef(onEvent),localeRef=React.useRef(locale);
          eventRef.current=onEvent;localeRef.current=locale;
          React.useEffect(()=>{controller.current?.setLocale?.(locale);},[locale]);
          const [error,setError]=React.useState('');
          const [loading,setLoading]=React.useState(true);
          const [attempt,setAttempt]=React.useState(0);
          React.useEffect(()=>{
            const abort=new AbortController();let dispose;
            setError('');setLoading(true);
            mountPrintpress(element.current,{locale,signal:abort.signal,onEvent:message=>{
              if(abort.signal.aborted)return;
              if(message.event==='bridge:error')setError(message.payload?.message||'');
              eventRef.current?.(message);
            }}).then(cleanup=>{if(abort.signal.aborted)cleanup();else{dispose=cleanup;controller.current=cleanup;cleanup.setLocale?.(localeRef.current);setLoading(false);}}).catch(value=>{if(!abort.signal.aborted){setError(value.message);setLoading(false);}});
            return()=>{abort.abort();controller.current=null;dispose?.();};
          },[attempt]);
          return h('section',{className:'hs-printpress-panel'},h('style',null,printpressCSS),loading&&h('p',{className:'hs-message',role:'status'},t('ppLoading')),error&&h('div',{className:'hs-message',role:'alert'},error,' ',h('button',{type:'button',className:'hs-button',onClick:()=>setAttempt(value=>value+1)},t('ppRetry'))),h('div',{ref:element}));
        }
        function HtmlWorkMiniature({item,fallback}) {
          const host=React.useRef(null),[srcDoc,setSrcDoc]=React.useState(null),[width,setWidth]=React.useState(320),[loaded,setLoaded]=React.useState(false);
          const cacheKey=previewCacheKey(item);
          React.useLayoutEffect(()=>{const update=()=>setWidth(host.current?.clientWidth||320);update();const observer=new ResizeObserver(update);if(host.current)observer.observe(host.current);return()=>observer.disconnect();},[]);
          React.useEffect(()=>{
            let alive=true;setSrcDoc(null);setLoaded(false);
            const load=()=>htmlPreviewCache.get(item).then(value=>{if(alive)setSrcDoc(miniatureDocument(value));}).catch(()=>{});
            if(!globalThis.IntersectionObserver){load();return()=>{alive=false;};}
            const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load();}},{rootMargin:'160px'});
            if(host.current)observer.observe(host.current);
            return()=>{alive=false;observer.disconnect();};
          },[cacheKey]);
          return h('span',{ref:host,className:'hs-work-miniature','aria-hidden':true},!loaded&&fallback,srcDoc&&h('iframe',{className:'hs-work-miniature-frame',title:item.title,srcDoc,sandbox:'',tabIndex:-1,referrerPolicy:'no-referrer',onLoad:()=>setLoaded(true),style:{transform:'scale('+width/1280+')'}}));
        }
        function WorkPreviewFrame({session,onSaved,onState,saveRequest}) {
          const frame=React.useRef(null),callbacks=React.useRef({onSaved,onState}),controller=React.useRef(null),lastSave=React.useRef(saveRequest);
          callbacks.current={onSaved,onState};
          React.useLayoutEffect(()=>{
            const bridge=createPreviewBridge({session,frame:()=>frame.current,action,onSaved:value=>callbacks.current.onSaved(value),onState:value=>callbacks.current.onState(value)});
            controller.current=bridge;
            const receive=event=>{void bridge.handleMessage(event);};
            window.addEventListener('message',receive);
            return()=>{window.removeEventListener('message',receive);controller.current=null;bridge.dispose();};
          },[session.nonce]);
          React.useEffect(()=>{if(lastSave.current===saveRequest)return;lastSave.current=saveRequest;controller.current?.requestSave();},[saveRequest]);
          return h('iframe',{ref:frame,className:'hs-work-preview-frame',title:session.title,srcDoc:session.srcDoc,sandbox:PREVIEW_SANDBOX,referrerPolicy:'no-referrer'});
        }
        function Panel() {
          const locale=React.useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot());
          const english=locale.active.startsWith('en');
          const title=item=>english?(item.titleEn||item.title):item.title;
          const description=item=>english?(item.descriptionEn||item.description):item.description;
          const shortTitle=item=>title(item).replace(/（.*?）/g,'').split(' / ')[0];
          const workspaceState=React.useSyncExternalStore(fn=>ctx.workspaces.list.subscribe(fn),()=>ctx.workspaces.list.getSnapshot());
          const view=React.useSyncExternalStore(viewStore.subscribe,viewStore.getSnapshot);
          const bind=key=>value=>viewStore.set(key,value);
          const {workspaceId,workspaceForm,newWorkspacePath,workspaceBusy,sending,sentSession,editingWork,editor,sourceText,sourceBusy,sourceNotice,sourceFailure,brief,draft,task,style,outputMode,handoffBusy,themeId,customColor,error,status}=view;
          const setWorkspaceId=bind('workspaceId'),setWorkspaceForm=bind('workspaceForm'),setNewWorkspacePath=bind('newWorkspacePath'),setWorkspaceBusy=bind('workspaceBusy');
          const setSending=bind('sending'),setSentSession=bind('sentSession'),setEditingWork=bind('editingWork');
          const setEditor=bind('editor'),setSourceText=bind('sourceText'),setSourceBusy=bind('sourceBusy'),setSourceNotice=bind('sourceNotice'),setSourceFailure=bind('sourceFailure');
          const setBrief=bind('brief'),setDraft=bind('draft'),setTask=bind('task'),setStyle=bind('style'),setOutputMode=bind('outputMode'),setHandoffBusy=bind('handoffBusy'),setThemeId=bind('themeId'),setCustomColor=bind('customColor'),setError=bind('error'),setStatus=bind('status');
          const [sourceDiscard,setSourceDiscard]=React.useState(false);
          const sourceRequestRef=React.useRef(null),mounted=React.useRef(true);
          const [htmlPreview,setHtmlPreviewState]=React.useState(null),[previewVisible,setPreviewVisible]=React.useState(false),[previewPending,setPreviewPending]=React.useState(null),[thumbnailFailures,setThumbnailFailures]=React.useState({}),[previewSaveRequest,setPreviewSaveRequest]=React.useState(0);
          const htmlPreviewRef=React.useRef(null),htmlRequestRef=React.useRef(null),workPreviewRef=React.useRef(null),previewReturnRef=React.useRef(null),previewVisibleRef=React.useRef(false);
          function setHtmlPreview(value){const next=typeof value==='function'?value(htmlPreviewRef.current):value;htmlPreviewRef.current=next;setHtmlPreviewState(next);}
          const selectedWorkspace=workspaceState.items.find(x=>x.workspaceId===workspaceId);
          const [tab,setTab]=React.useState('studio');
          const [printpressVisited,setPrintpressVisited]=React.useState(false);
          const [direction,setDirection]=React.useState('gallery');
          const [paletteOpen,setPaletteOpen]=React.useState(false),[hostAccent,setHostAccent]=React.useState('#2563eb');
          const paletteRef=React.useRef(null),paletteTriggerRef=React.useRef(null),hostColorProbe=React.useRef(null);
          const paletteVars=React.useMemo(()=>themeVariables({themeId,customColor},hostAccent),[themeId,customColor,hostAccent]);
          React.useEffect(()=>{
            const update=()=>{if(hostColorProbe.current)setHostAccent(normalizeColor(getComputedStyle(hostColorProbe.current).color));};
            update();
            const observer=new MutationObserver(update);
            observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme','data-color-scheme']});
            if(document.body)observer.observe(document.body,{attributes:true,attributeFilter:['class','style','data-theme']});
            const media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',update);
            return()=>{observer.disconnect();media.removeEventListener('change',update);};
          },[]);
          React.useEffect(()=>{if(!paletteOpen)return;const close=event=>{if(!paletteRef.current?.contains(event.target))setPaletteOpen(false);};document.addEventListener('pointerdown',close,true);return()=>document.removeEventListener('pointerdown',close,true);},[paletteOpen]);
          function choosePalette(id,color=customColor){setThemeId(id);setCustomColor(color);saveThemePreference({themeId:id,customColor:color});}
          const [catalog,setCatalog]=React.useState(null);
          const [works,setWorks]=React.useState({items:[],total:0});
          const [busy,setBusy]=React.useState(false);
          const [search,setSearch]=React.useState('');
          const [group,setGroup]=React.useState('all');
          const [page,setPage]=React.useState(0);
          const [preview,setPreview]=React.useState('');
          const [notesById,setNotesById]=React.useState({});
          const [noteLoading,setNoteLoading]=React.useState('');
          const [noteError,setNoteError]=React.useState(null);
          const [notesExpanded,setNotesExpanded]=React.useState(true);
          const notesRequestRef=React.useRef(null);
          const [addForm,setAddForm]=React.useState(false);
          const [workTitle,setWorkTitle]=React.useState('');
          const [workPath,setWorkPath]=React.useState('');
          const [workSourcePath,setWorkSourcePath]=React.useState('');
          const [note,setNote]=React.useState('');
          const [registerModule,setRegisterModule]=React.useState('web');
          const [registerStyle,setRegisterStyle]=React.useState('');
          const [deleting,setDeleting]=React.useState('');
          const [workType,setWorkType]=React.useState('all');
          const [publishedWork,setPublishedWork]=React.useState(null);
          const doc=view.handbook,setDoc=bind('handbook');
          const [docLoading,setDocLoading]=React.useState(false);
          const [docProgress,setDocProgress]=React.useState(null);
          const [docError,setDocError]=React.useState('');
          const [docRaw,setDocRaw]=React.useState(false);
          const [tocOpen,setTocOpen]=React.useState(false);
          const [chapterSearch,setChapterSearch]=React.useState('');
          const [activeChapter,setActiveChapter]=React.useState('');
          const [docNotice,setDocNotice]=React.useState('');
          const docRequestRef=React.useRef(null),docArticleRef=React.useRef(null);
          const handbook=React.useMemo(()=>doc?parseHandbook(doc.content):null,[doc?.content]);
          const rootRef=React.useRef(null), formRef=React.useRef(null), docRef=React.useRef(null), editorRef=React.useRef(null), registerRef=React.useRef(null), previewRef=React.useRef(null), briefRef=React.useRef(null);
          const requestRef=React.useRef(null);
          React.useEffect(()=>{if(!previewVisible)return;const close=event=>{if(event.key==='Escape'){event.preventDefault();closeHtmlPreview();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&htmlPreviewRef.current?.session?.sourcePath){event.preventDefault();if(htmlPreviewRef.current?.state.editorReady)setPreviewSaveRequest(number=>number+1);}};window.addEventListener('keydown',close,true);requestAnimationFrame(()=>workPreviewRef.current?.querySelector('[data-viewer-close]')?.focus({preventScroll:true}));return()=>window.removeEventListener('keydown',close,true);},[previewVisible]);
          React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestRef.current?.abort();sourceRequestRef.current?.abort();htmlRequestRef.current?.abort();notesRequestRef.current?.abort();docRequestRef.current?.abort();};},[]);
          const sourceDirty=!!editor&&sourceText!==editor.content;
          function goTo(ref,focus=false){requestAnimationFrame(()=>{const root=rootRef.current,element=ref.current;if(!root||!element)return;const distance=element.getBoundingClientRect().top-root.getBoundingClientRect().top;root.scrollTo({top:Math.max(0,root.scrollTop+distance-18),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});if(focus)briefRef.current?.focus({preventScroll:true});});}
          async function refresh(signal){try{const[c,w]=await Promise.all([action('catalog',{},signal),action('list',{limit:100},signal)]);if(signal?.aborted)return;setCatalog(c);setWorks(w);setError('');}catch(e){if(e.name!=='AbortError')setError(e.message);}}
          React.useEffect(()=>{const abort=new AbortController();refresh(abort.signal);return()=>abort.abort();},[]);
          async function downloadHtmlWork(item){
            const current=htmlPreviewRef.current;if(current?.item.id===item.id&&(current.state.dirty||current.state.editorSaving||current.state.busy)){setError(t('saveBeforeDownload'));return;}
            try{const preview=await htmlPreviewCache.get(item),url=URL.createObjectURL(new Blob([preview.html],{type:'text/html;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=(item.title||'work').replace(/[\\/:*?"<>|]/g,'-').replace(/\.html?$/i,'')+'.html';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(error){setError(error.message);}
          }
          async function openHtmlPreview(item,reload=false,confirmed=false){
            const current=htmlPreviewRef.current;
            if(current?.state.busy||current?.state.editorSaving){setError(t('previewBusy'));return;}
            if(!previewVisibleRef.current){const root=rootRef.current;previewReturnRef.current={top:root?.scrollTop||0,left:root?.scrollLeft||0,focus:document.activeElement};root?.scrollTo({top:0,left:0,behavior:'instant'});}
            previewVisibleRef.current=true;setPreviewVisible(true);
            if(!reload&&current?.item.id===item.id&&current.session)return;
            if(current?.state.dirty&&!confirmed){setPreviewPending({item,reload});return;}
            setPreviewPending(null);htmlRequestRef.current?.abort();const abort=new AbortController();htmlRequestRef.current=abort;
            setHtmlPreview({item,session:null,loading:true,error:'',state:{dirty:false,busy:false,ready:false,storageError:''}});viewStore.set('previewDirty',false);
            try{
              const result=await htmlPreviewCache.get(item,{reload});if(abort.signal.aborted||!mounted.current)return;
              if(result.workId!==item.id)throw new Error('The preview belongs to another work.');
              const session=createPreviewSession(result),dirty=Object.keys(session.drafts.snapshot()).length>0;
              setHtmlPreview({item,session,loading:false,error:'',state:{dirty,busy:false,ready:false,storageError:session.drafts.initialError}});viewStore.set('previewDirty',dirty);
            }catch(value){if(value.name!=='AbortError'&&mounted.current)setHtmlPreview(previous=>previous?{...previous,loading:false,error:value.message}:previous);}
          }
          function previewStateChanged(nonce,patch){
            if(htmlPreviewRef.current?.session?.nonce!==nonce)return;
            if(patch.closeRequested){closeHtmlPreview();return;}
            setHtmlPreview(previous=>({...previous,state:{...previous.state,...patch}}));
            if(Object.hasOwn(patch,'dirty'))viewStore.set('previewDirty',patch.dirty);
          }
          function previewSourceSaved(){if(htmlPreviewRef.current)htmlPreviewCache.invalidate(htmlPreviewRef.current.item);setStatus(t('previewSaved'));refresh();}
          function closeHtmlPreview(){previewVisibleRef.current=false;setPreviewVisible(false);setPreviewPending(null);const previous=previewReturnRef.current;requestAnimationFrame(()=>{rootRef.current?.scrollTo({top:previous?.top||0,left:previous?.left||0,behavior:'instant'});if(previous?.focus?.isConnected)previous.focus.focus({preventScroll:true});});}
          async function editGraphic(item){
            if(handoffGuard.current||sendGuard.current)return;
            handoffGuard.current=true;setHandoffBusy(item.id);setError('');setStatus('');
            try{const data=await printpressAction('handoff',{workId:item.id});requestPrintpressEdit(data);if(mounted.current)switchTab('printpress');}
            catch(value){setError(value.message);}
            finally{handoffGuard.current=false;setHandoffBusy('');}
          }
          function onWorkbenchEvent(message){
            if(message.event==='workbench:return')switchTab('works');
            if(message.event==='workbench:published'){
              const item=message.payload?.item;
              if(item)setWorks(current=>({...current,items:current.items.map(value=>value.id===item.id?item:value)}));
              // Offer a one-click jump into the native editor after a layered
              // publish, without forcing the user away from the current view.
              if(item?.id&&(item.layeredEditable||item.imageEditable))setPublishedWork(item);
              setStatus(t('published'));refresh();
            }
          }
          async function makeInstructions(args={},signal){
            if(editingWork&&!args.workId&&!args.workflow)return action('edit',{id:editingWork.id,brief,style},signal);
            const targetTask=args.workflow==='review-polish'?'critique':args.task||task;
            return action('draft',{task,style:style||undefined,brief,...(editingWork?{workId:editingWork.id}:{}),...args,outputMode:outputModeFor(targetTask,args.outputMode||outputMode)},signal);
          }
          async function prepare(args={}){
            if(sendGuard.current)return;
            requestRef.current?.abort();const abort=new AbortController();requestRef.current=abort;setBusy(true);setError('');setStatus('');
            try{const result=await makeInstructions(args,abort.signal);if(abort.signal.aborted)return;setDraft(result.draft);setTask(result.task);setStyle(result.style||'');setOutputMode(result.outputMode||outputModeFor(result.task,args.outputMode||outputMode));setTab('studio');goTo(formRef);}
            catch(e){if(e.name!=='AbortError')setError(e.message);}finally{if(!abort.signal.aborted)setBusy(false);if(requestRef.current===abort)requestRef.current=null;}
          }
          async function addWorkspace(){if(workspaceBusy||!newWorkspacePath.trim())return;setWorkspaceBusy(true);setError('');try{const item=await ctx.workspaces.create({path:newWorkspacePath.trim()});setWorkspaceId(item.workspaceId);setWorkspaceForm(false);setNewWorkspacePath('');}catch(e){setError(e.message);}finally{setWorkspaceBusy(false);}}
          async function sendRequest(){
            if(sendGuard.current||!selectedWorkspace||(!brief.trim()&&!draft.trim()))return;
            if(sourceDirty){setError(t('finishSource'));return;}
            if(editingWork&&!projectInWorkspace(editingWork.projectDir,selectedWorkspace.path)){setError(t('wrongWorkspace'));return;}
            sendGuard.current=true;setSending(true);setError('');setStatus('');setSentSession('');requestRef.current?.abort();
            try{
              const text=draft.trim()?draft:(await makeInstructions()).draft;
              const sessionId=await submitWorkspacePrompt(ctx,selectedWorkspace.workspaceId,text);
              setSentSession(sessionId);setStatus(t('sent'));setBrief('');setDraft('');setEditingWork(null);creationState.current=null;
              if(mounted.current)ctx.uiWorkspace.openSession(sessionId);
            }catch(e){setError(e.message);if(e.sessionId)setSentSession(e.sessionId);}
            finally{sendGuard.current=false;setSending(false);if(mounted.current)setBusy(false);}
          }
          async function beginRevision(item){
            if(sendGuard.current||workspaceBusy)return;
            if(!item.editable){setError(t('sourceExport'));return;}
            if(!editingWork)creationState.current={brief,draft,task,style,outputMode,workspaceId};
            invalidateDraft();setEditingWork(item);setTask(item.module||'web');setStyle(item.style||'');setBrief('');setTab('studio');setError('');setStatus('');setWorkspaceBusy(true);
            try{const existing=workspaceState.items.filter(x=>projectInWorkspace(item.projectDir,x.path)).sort((a,b)=>b.path.length-a.path.length)[0];const workspace=existing||await ctx.workspaces.create({path:item.projectDir});setWorkspaceId(workspace.workspaceId);goTo(formRef,true);}catch(e){setError(e.message);}finally{setWorkspaceBusy(false);}
          }
          function exitRevision(){if(sendGuard.current)return;invalidateDraft();const prior=creationState.current;setEditingWork(null);creationState.current=null;setBrief(prior?.brief||'');setDraft(prior?.draft||'');setTask(prior?.task||'web');setStyle(prior?.style||'');setOutputMode(prior?.outputMode||'standard');setWorkspaceId(prior?.workspaceId||workspaceId);}
          async function loadSource(item,discard=false){
            if(sourceBusy||sendGuard.current)return;
            if(sourceDirty&&!discard){setSourceDiscard({kind:'open',item});goTo(editorRef);return;}
            sourceRequestRef.current?.abort();const abort=new AbortController();sourceRequestRef.current=abort;setSourceBusy(true);setSourceNotice('');setSourceFailure(false);setSourceDiscard(false);
            try{const result=await action('source',{id:item.id},abort.signal);if(abort.signal.aborted)return;setEditor({...result,title:item.title});setSourceText(result.content);goTo(editorRef);}catch(e){if(e.name!=='AbortError'){setSourceNotice(e.message);setSourceFailure(true);setError(e.message);}}finally{if(!abort.signal.aborted)setSourceBusy(false);}
          }
          async function saveSource(){
            if(!editor||sourceBusy||!sourceDirty)return;setSourceBusy(true);setSourceNotice('');setSourceFailure(false);
            try{const result=await action('source',{id:editor.id,content:sourceText,revision:editor.revision});setEditor({...editor,...result,content:sourceText});setSourceNotice(t('sourceSaved')+result.backupPath);await refresh();}catch(e){setSourceNotice(e.message+(e.status===409?' '+t('conflictHelp'):''));setSourceFailure(true);}finally{setSourceBusy(false);}
          }
          function closeSource(){if(sourceBusy)return;if(sourceDirty){setSourceDiscard({kind:'close'});return;}setEditor(null);setSourceNotice('');setSourceDiscard(false);}
          function confirmSourceDiscard(){const pending=sourceDiscard;setSourceDiscard(false);if(pending?.kind==='open')loadSource(pending.item,true);else{setEditor(null);setSourceNotice('');}}

          async function readDoc(path,options={}){
            docRequestRef.current?.abort();const abort=new AbortController();docRequestRef.current=abort;
            const previous=options.append&&doc?.path===path?doc:null;
            if(!options.append){
              if(doc&&options.history!==false)docHistory.current=[...docHistory.current,{document:doc,scrollTop:rootRef.current?.scrollTop||0}].slice(-12);
              setDoc({path,content:'',total:0,nextOffset:0,pending:true});setDocRaw(false);setChapterSearch('');setActiveChapter('');setTocOpen(false);
              docAnchorRef.current=options.fragment?{path,fragment:options.fragment}:null;
            }
            setDocLoading(true);setDocError('');setDocNotice('');setDocProgress(null);
            if(!options.append)goTo(docRef);
            try{const result=await loadHandbook((args,signal)=>action('read',args,signal),path,{previous,signal:abort.signal,onProgress:setDocProgress});if(!abort.signal.aborted)setDoc(result);}
            catch(e){if(e.name!=='AbortError')setDocError(e.message);}
            finally{if(!abort.signal.aborted)setDocLoading(false);}
          }
          function closeDoc(){docRequestRef.current?.abort();setDoc(null);setDocLoading(false);setDocError('');setDocNotice('');docHistory.current=[];docAnchorRef.current=null;}
          function backDoc(){docRequestRef.current?.abort();const old=docHistory.current.pop();if(!old){closeDoc();return;}setDoc(old.document);setDocLoading(false);setDocError('');setDocNotice('');setDocRaw(false);setChapterSearch('');docAnchorRef.current=null;requestAnimationFrame(()=>rootRef.current?.scrollTo({top:old.scrollTop}));}
          function scrollChapter(fragment){
            const normalized=parseHandbook('# '+fragment).toc[0]?.id;
            const entry=handbook?.toc.find(x=>x.id===fragment)||handbook?.toc.find(x=>x.id===normalized);
            const element=entry&&Array.from(docArticleRef.current?.querySelectorAll('[data-handbook-id]')||[]).find(node=>node.dataset.handbookId===entry.id);
            const root=rootRef.current;
            if(!element||!root){setDocNotice(t('docAnchorMissing'));return false;}
            root.scrollTo({top:root.scrollTop+element.getBoundingClientRect().top-root.getBoundingClientRect().top-22,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});element.focus({preventScroll:true});setActiveChapter(entry.id);setTocOpen(false);setDocNotice('');return true;
          }
          async function copyDoc(){try{await navigator.clipboard.writeText(doc.content);setDocNotice(t('docCopied'));}catch{setDocNotice(t('docCopyFailed'));}}
          // Per-block copy: the whole-document copy is useless when a reader only needs one
          // snippet. Blocks are identified by index in the token stream so re-renders keep
          // the confirmation attached to the block the user actually clicked.
          const [copiedBlock,setCopiedBlock]=React.useState('');
          async function copyBlock(id,text){
            try{await navigator.clipboard.writeText(text);setCopiedBlock(id);setTimeout(()=>setCopiedBlock(current=>current===id?'':current),1600);}
            catch{setDocNotice(t('docCopyFailed'));}
          }
          React.useEffect(()=>{if(doc?.pending)readDoc(doc.path,{append:true,history:false});},[]);
          React.useEffect(()=>{const target=docAnchorRef.current;if(!target||!catalog||!docArticleRef.current||docLoading||docRaw||target.path!==doc?.path)return;if(scrollChapter(target.fragment)||doc.nextOffset===null)docAnchorRef.current=null;},[doc?.content,docLoading,docRaw,!!catalog]);
          React.useEffect(()=>{
            if(!handbook||docRaw||!docArticleRef.current||!rootRef.current||typeof IntersectionObserver==='undefined')return;
            const visibleHeadings=new Set();let disposed=false;
            const observer=new IntersectionObserver(entries=>{if(disposed)return;for(const entry of entries){if(entry.isIntersecting)visibleHeadings.add(entry.target);else visibleHeadings.delete(entry.target);}const visible=Array.from(visibleHeadings).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);if(visible.length)setActiveChapter(visible[0].dataset.handbookId);},{root:rootRef.current,rootMargin:'-12px 0px -65% 0px',threshold:0});
            for(const heading of docArticleRef.current.querySelectorAll('[data-handbook-id]'))observer.observe(heading);
            return()=>{disposed=true;observer.disconnect();};
          },[doc?.content,docRaw,!!catalog]);
          async function saveWork(e){e.preventDefault();setBusy(true);setError('');try{await action('add',{title:workTitle,path:workPath,sourcePath:workSourcePath.trim()||undefined,module:registerModule,style:registerStyle||undefined,note});setAddForm(false);setWorkTitle('');setWorkPath('');setWorkSourcePath('');setNote('');setStatus(t('saved'));await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
          async function deleteWork(id){
            setBusy(true);setError('');setStatus('');
            try{
              const result=await action('delete',{id,confirm:true});
              setDeleting('');
              const kept=(result?.skipped||[]).filter(entry=>entry.reason!=='Already missing.');
              setStatus(kept.length?`${t('deleted')} ${t('deleteSkipped')}${kept.map(entry=>entry.path).join('、')}`:t('deleted'));
              if(htmlPreviewRef.current?.item.id===id)closeHtmlPreview();
              await refresh();
            }catch(e){setError(e.message);}
            finally{setBusy(false);}
          }
          function invalidateDraft(clear=true){if(requestRef.current){requestRef.current.abort();requestRef.current=null;setBusy(false);}if(clear)setDraft('');}
          function openRegistration(){setRegisterModule(task);setRegisterStyle(style);setWorkTitle('');setWorkPath('');setWorkSourcePath('');setNote('');setAddForm(true);}
          function linkWorkSource(item){setTab('works');setRegisterModule(item.module||'web');setRegisterStyle(item.style||'');setWorkTitle(item.title);setWorkPath(item.path);setWorkSourcePath(item.sourcePath||'');setNote(item.note||'');setAddForm(true);goTo(registerRef);}
          function switchTab(next){invalidateDraft(false);if(next==='printpress')setPrintpressVisited(true);setTab(next);setSearch('');setGroup('all');setPage(0);setPreview('');setWorkType('all');closeDoc();setError('');setStatus('');setPublishedWork(null);rootRef.current?.scrollTo({top:0});}
          function chooseTask(id,focus=true){if(sendGuard.current||editingWork)return;invalidateDraft();if(chosenStyle&&chosenStyle.module!==id&&chosenStyle.module!=='cross')setStyle('');setTask(id);setTab('studio');if(focus)goTo(formRef,true);}
          function chooseStyle(item){if(sendGuard.current)return;invalidateDraft();setStyle(item.id);if(!editingWork&&!['motion','critique'].includes(task)&&tasks.some(x=>x.id===item.module))setTask(item.module);setDraft('');setTab('studio');setPreview('');goTo(formRef,true);}
          function browseTask(){switchTab('styles');const category=({deck:'ppt',infographic:'info',xiaohongshu:'xhs'})[task]||task;setGroup(['web','ppt','info','app','xhs'].includes(category)?category:'all');}
          async function loadStyleNotes(item){notesRequestRef.current?.abort();setNoteError(null);if(notesById[item.id]){setNoteLoading('');return;}const abort=new AbortController();notesRequestRef.current=abort;setNoteLoading(item.id);try{const result=await action('read',{style:item.id},abort.signal);if(!abort.signal.aborted)setNotesById(old=>({...old,[item.id]:result}));}catch(e){if(e.name!=='AbortError')setNoteError({id:item.id,message:e.message});}finally{if(!abort.signal.aborted)setNoteLoading('');}}
          function openPreview(item){setPreview(item.id);setNotesExpanded(true);loadStyleNotes(item);goTo(previewRef);}
          function openStyleDetails(item){if(tab!=='styles'){setTab('styles');setGroup('all');setSearch('');setPage(0);}openPreview(item);}
          const button=(label,onClick,props={})=>h('button',{type:'button',className:'hs-button',onClick,...props},label);
          const textButton=(label,onClick,props={})=>button(label,onClick,{className:'hs-text-button',...props});
          const link=(label,href,props={})=>h('a',{className:'hs-button',href,target:'_blank',rel:'noopener noreferrer',...props},label);
          const tasks=catalog?.tasks||[],styles=catalog?.styles||[],flows=catalog?.workflows||[];
          const currentTask=tasks.find(x=>x.id===task),chosenStyle=styles.find(x=>x.id===style),previewStyle=styles.find(x=>x.id===preview);
          const categoryFor=id=>({deck:'ppt',infographic:'info',xiaohongshu:'xhs'})[id]||id;
          const visualReferences={
            motion:['ppt-02-black-big-number-stage','ppt-04-full-bleed-gradient-manifesto','ppt-08-y2k-inflated-wrapped'],
            critique:['web-01-editorial-brutalism','info-09-newsroom-chart','east-08-sugiura-info-mandala']
          };
          const stylesForTask=id=>visualReferences[id]?visualReferences[id].map(key=>styles.find(x=>x.id===key)).filter(Boolean):styles.filter(x=>x.category===categoryFor(id));
          const related=stylesForTask(task);
          const preferredCovers={
            web:['web-03-memphis-maximalism','web-10-bauhaus-geometric','web-20-kenya-hara-white-gallery'],
            deck:['ppt-01-neo-swiss-billboard','ppt-03-mono-brand-type-hero','ppt-16-institutional-swiss'],
            infographic:['info-01-personal-annual-report','info-04-magazine-pop-data','info-08-cartographic-lead'],
            app:['app-01-hardware-panel','app-03-playful-3d','app-06-topo-outdoor'],
            xiaohongshu:['xhs-01-specimen-journal','xhs-03-index-ink','xhs-04-panorama-strip']
          };
          const preferred=(preferredCovers[task]||[]).map(id=>related.find(x=>x.id===id)).filter(Boolean);
          const heroArt=[...preferred,...related.filter(x=>!preferred.some(p=>p.id===x.id))].slice(0,3);
          const referenceStyles=related.slice(0,4);
          const q=search.toLowerCase().trim();
          const filteredStyles=styles.filter(x=>(group==='all'||x.category===group)&&(!q||[x.title,x.titleEn,x.description].join(' ').toLowerCase().includes(q)));
          // Type facets are derived from the registered works themselves, so the
          // filter only ever lists media that actually exist in the library.
          const workTypeCounts=works.items.reduce((counts,item)=>{const key=item.module||'';counts[key]=(counts[key]||0)+1;return counts;},{});
          const workTypes=Object.keys(workTypeCounts).sort((a,b)=>{const ai=tasks.findIndex(x=>x.id===a),bi=tasks.findIndex(x=>x.id===b);return (ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b);});
          const activeWorkType=workType==='all'||workTypeCounts[workType]?workType:'all';
          const filteredWorks=works.items.filter(x=>(activeWorkType==='all'||(x.module||'')===activeWorkType)&&(!q||[x.title,x.style,x.note,x.path].join(' ').toLowerCase().includes(q)));
          const sectionTitle=(heading,hint,actionNode)=>h('div',{className:'hs-section-title'},h('div',null,h('h2',null,heading),hint&&h('p',null,hint)),actionNode);
          const searchBox=()=>h('div',{className:'hs-search'},h(Icon,{size:17,kind:'search'}),h('input',{type:'search',value:search,onChange:e=>{setSearch(e.target.value);setPage(0);},placeholder:t('search'),'aria-label':t('search')}));
          function formatSelect(register=false){return h('label',{className:'hs-format-select'},h('span',{className:'hs-muted hs-small'},t('taskLabel')),h('select',{value:register?registerModule:task,disabled:sending||(!register&&!!editingWork),onChange:e=>register?setRegisterModule(e.target.value):chooseTask(e.target.value,false)},...tasks.map(x=>h('option',{key:x.id,value:x.id},title(x)))));}
          function workspacePicker(){return h('div',{className:'hs-workspace-picker'},h('div',{className:'hs-workspace-row'},h('label',null,h('span',{className:'hs-muted hs-small'},t('workspace')),h('select',{value:selectedWorkspace?.workspaceId||'',title:selectedWorkspace?.path||'',disabled:sending||workspaceBusy||workspaceState.phase!=='ready',onChange:e=>{setWorkspaceId(e.target.value);setError('');setSentSession('');}},h('option',{value:''},t(workspaceState.phase!=='ready'?'workspaceLoading':'chooseWorkspace')),...workspaceState.items.map(x=>h('option',{value:x.workspaceId,key:x.workspaceId,title:x.path},x.title)))),textButton(t('addWorkspace'),()=>setWorkspaceForm(!workspaceForm),{disabled:sending||workspaceBusy,'aria-expanded':workspaceForm})),selectedWorkspace&&h('p',{className:'hs-path',title:selectedWorkspace.path},selectedWorkspace.path),workspaceState.error&&h('p',{className:'hs-error',role:'alert'},workspaceState.error.message),workspaceState.phase==='ready'&&!workspaceState.items.length&&h('p',{className:'hs-muted'},t('noWorkspaces')),workspaceForm&&h('div',{className:'hs-workspace-add'},h('label',null,t('workspacePath'),h('input',{value:newWorkspacePath,disabled:workspaceBusy||sending,onChange:e=>setNewWorkspacePath(e.target.value),placeholder:'D:\\Projects\\Design'})),button(t('useWorkspace'),addWorkspace,{disabled:workspaceBusy||sending||!newWorkspacePath.trim()})));}
          function outputFormat(){return !editingWork&&h('div',{className:'hs-output-format'},h('label',null,h('span',{className:'hs-muted hs-small'},t('outputLabel')),h('select',{value:outputMode,disabled:sending||busy||workspaceBusy,onChange:e=>{invalidateDraft();setOutputMode(e.target.value);}},h('option',{value:'standard'},t('outputStandard')),h('option',{value:'layered'},t('outputLayered')))),outputMode==='layered'&&h('p',{className:'hs-muted hs-small'},t('outputLayeredHint')));}
          function composer(){return h('section',{className:'hs-composer',ref:formRef,'aria-label':t('briefLabel')},
            h('div',{className:'hs-composer-head'},h('h2',null,editingWork?t('editHeading')+' · '+editingWork.title:t('briefLabel'))),
            editingWork&&h('div',{className:'hs-revision-context'},h('p',{className:'hs-path'},t('projectFolder')+': '+editingWork.projectDir),textButton(t('exitEdit'),exitRevision,{disabled:sending})),
            workspacePicker(),outputFormat(),
            h('label',{className:'hs-brief'},h('textarea',{ref:briefRef,value:brief,disabled:sending||workspaceBusy,onChange:e=>{invalidateDraft();setBrief(e.target.value);},placeholder:t(editingWork?'editBrief':'briefHint'),'aria-label':t('briefLabel')})),
            h('div',{className:'hs-compose-bottom'},chosenStyle?h('div',{className:'hs-reference'},h('img',{src:chosenStyle.specimenUrl,alt:''}),h('div',{className:'hs-reference-text'},h('span',{className:'hs-reference-name'},shortTitle(chosenStyle)),textButton(t('clearStyle'),()=>{if(sending)return;invalidateDraft();setStyle('');},{disabled:sending}))):button(t('changeStyle'),browseTask,{className:'hs-reference-none',disabled:sending}),
              h('div',{className:'hs-actions'},textButton(busy?t('preparing'):t('previewPrompt'),()=>prepare(),{disabled:busy||sending||workspaceBusy}),button(sending?t('sending'):t(editingWork?'sendEdit':'send'),sendRequest,{className:'hs-button hs-primary',disabled:busy||sending||workspaceBusy||!selectedWorkspace||(!brief.trim()&&!draft.trim())}))),
            h('p',{className:'hs-direction-note'},t(editingWork?'editHint':'directionHint')),
            sentSession&&textButton(t('viewSession'),()=>ctx.uiWorkspace.openSession(sentSession)),
            draft&&h('div',{className:'hs-draft'},h('label',null,t('draftLabel'),h('textarea',{value:draft,disabled:sending,onChange:e=>setDraft(e.target.value)})),h('div',{className:'hs-draft-foot'},h('p',null,t('draftOptional')),button(t(editingWork?'sendEdit':'send'),sendRequest,{className:'hs-button hs-primary',disabled:busy||sending||workspaceBusy||!selectedWorkspace||!draft.trim()}))));}
          function sourceEditor(){return editor&&h('section',{className:'hs-source-editor',ref:editorRef},sectionTitle(t('sourceEditor')+' · '+editor.title,t('sourceBackup'),textButton(t('close'),closeSource,{disabled:sourceBusy})),h('p',{className:'hs-path'},editor.path),h('label',null,h('span',{className:'hs-muted hs-small'},sourceDirty?t('sourceChanged'):t('sourceEditor')),h('textarea',{className:'hs-source-text',value:sourceText,onChange:e=>{setSourceText(e.target.value);setSourceDiscard(false);},disabled:sourceBusy,spellCheck:false,wrap:'off','aria-label':t('sourceEditor')})),h('div',{className:'hs-actions'},button(sourceBusy?t('preparing'):t('sourceSave'),saveSource,{className:'hs-button hs-primary',disabled:sourceBusy||!sourceDirty}),textButton(t('sourceReload'),()=>loadSource({id:editor.id,title:editor.title}),{disabled:sourceBusy}),h('span',{className:'hs-muted hs-small'},t('editorLimit'))),sourceNotice&&h('div',{className:sourceFailure?'hs-error':'hs-status',role:sourceFailure?'alert':'status'},sourceNotice),sourceDiscard&&h('div',{className:'hs-source-confirm',role:'alert'},h('p',null,t('sourceChanged')),h('div',{className:'hs-actions'},button(t(sourceDiscard.kind==='open'?'discardReload':'discardSource'),confirmSourceDiscard,{className:'hs-button hs-danger'}),textButton(t('cancel'),()=>setSourceDiscard(false)))));}

          function styleCard(item){return h('article',{key:item.id,className:'hs-style-card'+(style===item.id?' is-chosen':''),'data-category':item.category},
            h('button',{type:'button',className:'hs-style-art',onClick:()=>{if(tab!=='styles'){setTab('styles');setGroup('all');setSearch('');setPage(0);}openPreview(item);},'aria-label':t('preview')+': '+shortTitle(item)},h('img',{src:item.specimenUrl,alt:shortTitle(item),loading:'lazy'})),
            h('div',{className:'hs-style-meta'},h('h3',null,shortTitle(item)),styleTags(item),h('div',{className:'hs-style-actions'},textButton(t('details'),()=>openStyleDetails(item)),textButton(h(Icon,{kind:'add',size:18}),()=>chooseStyle(item),{disabled:sending,'aria-label':t('useStyle')+': '+shortTitle(item),title:t('useStyle')}))));}
          function styleTags(item){return h('div',{className:'hs-style-tags'},h('span',null,t(item.category)),item.tone&&h('span',null,t(({'大胆':'toneBold','中性':'toneNeutral','安静':'toneQuiet'})[item.tone]||item.tone)),item.fidelity!=null&&h('span',{title:t('upstreamEstimate')},'HTML '+item.fidelity+'%'));}
          function noteText(text){return text.split(/(`[^`]+`)/g).map((part,index)=>part.startsWith('`')&&part.endsWith('`')?h('code',{key:index},part.slice(1,-1)):part);}
          function styleNotes(item){
            const notes=notesById[item.id]?.notes;
            const fields=[[t('suitable'),'useCases'],[t('visualDNA'),'visualDNA'],[t('fontPair'),'typography'],[t('inspirationSource'),'reference'],[t('buildNotes'),'implementation']];
            const cards=notes?fields.filter(([,key])=>notes[key]).map(([label,key])=>h('article',{className:'hs-note-card hs-note-'+key,key},h('h5',null,label),h('p',null,...noteText(notes[key])))):[];
            const palette=notes?.palette?.length>0?h('div',{className:'hs-note-palette'},h('h5',null,t('samplePalette')),h('div',{className:'hs-palette-values'},...notes.palette.map(color=>h('span',{key:color},h('i',{style:{backgroundColor:color},'aria-hidden':true}),h('code',null,color))))):null;
            return h('section',{className:'hs-style-notes',id:'hs-notes-'+item.id,'aria-busy':noteLoading===item.id},
              h('div',{className:'hs-note-heading'},h('h4',null,t('details')),h('span',{className:'hs-muted hs-small'},t('sampleLabel'))),
              noteLoading===item.id&&h('p',{role:'status'},t('notesLoading')),
              noteError?.id===item.id&&h('div',{className:'hs-error',role:'alert'},noteError.message,' ',textButton(t('retry'),()=>loadStyleNotes(item))),
              notes&&h(React.Fragment,null,h('div',{className:'hs-note-grid'},...cards),palette,h('p',{className:'hs-note-foot'},t('paletteHint')))
            );
          }
          function previewPanel(){return previewStyle&&h('section',{className:'hs-preview',ref:previewRef},h('div',{className:'hs-preview-art'},h('img',{src:previewStyle.specimenUrl,alt:shortTitle(previewStyle)})),h('div',{className:'hs-preview-copy'},h('div',{className:'hs-preview-top'},styleTags(previewStyle),textButton(h(Icon,{kind:'close',size:18}),()=>setPreview(''),{'aria-label':t('close')})),h('h3',null,shortTitle(previewStyle)),h('p',null,description(previewStyle)),h('div',{className:'hs-actions'},button(t('useStyle'),()=>chooseStyle(previewStyle),{className:'hs-button hs-primary',disabled:sending}),link(t('openImage'),previewStyle.specimenUrl),textButton(t(notesExpanded?'hideNotes':'showNotes'),()=>setNotesExpanded(!notesExpanded),{'aria-expanded':notesExpanded,'aria-controls':'hs-notes-'+previewStyle.id}),textButton(t('readFullGuide'),()=>readDoc(previewStyle.resource)))),notesExpanded&&styleNotes(previewStyle));}
          function htmlWorkPreviewPanel(){
            const value=htmlPreview;if(!value)return null;
            return h('section',{className:'hs-work-preview',ref:workPreviewRef,hidden:!previewVisible,role:'dialog','aria-modal':true,'aria-labelledby':'hs-work-viewer-title'},
              h('header',{className:'hs-work-preview-heading'},h('div',null,h('h2',{id:'hs-work-viewer-title'},value.item.title),value.session?.sourcePath&&h('span',{className:'hs-muted hs-small'},t('inlineEditHint'))),h('div',{className:'hs-actions'},value.session?.sourcePath&&value.state.dirty&&button(t(value.state.editorSaving?'inlineSaving':'inlineSave'),()=>setPreviewSaveRequest(number=>number+1),{className:'hs-button hs-primary',disabled:!value.state.editorReady||value.state.editorSaving||value.state.busy}),value.state.editorSaved&&!value.state.dirty&&h('span',{className:'hs-small',role:'status'},t('inlineSaved')),button(t('previewRetry'),()=>openHtmlPreview(value.item,true),{disabled:value.loading||value.state.busy||value.state.editorSaving}),button(t('previewClose'),closeHtmlPreview,{'data-viewer-close':true}))),
              previewPending&&h('div',{className:'hs-preview-confirm',role:'alert'},h('p',null,t('previewDiscardHelp')),h('div',{className:'hs-actions'},button(t('previewDiscard'),()=>openHtmlPreview(previewPending.item,previewPending.reload,true),{className:'hs-button hs-danger',disabled:value.state.busy}),button(t('cancel'),()=>setPreviewPending(null)))),
              (value.loading||value.session&&!value.state.ready)&&h('p',{className:'hs-preview-note',role:'status'},t('previewLoading')),
              value.error&&h('p',{className:'hs-error hs-preview-note',role:'alert'},value.error),
              value.state.editorError&&h('p',{className:'hs-error hs-preview-note',role:'alert'},value.state.editorError),
              value.state.busy&&h('p',{className:'hs-preview-note',role:'status'},t('previewBusy')),
              value.state.storageError&&h('p',{className:'hs-error hs-preview-note',role:'alert'},t('previewDraftFailure'),value.state.storageError),
              value.session&&h(React.Fragment,null,h('p',{className:'hs-preview-note hs-muted hs-small'},value.session.sourcePath?t('previewDraftHelp'):t('previewReadOnly')),
                value.session.warnings?.length>0&&h('ul',{className:'hs-preview-warnings'},...value.session.warnings.map((warning,index)=>h('li',{key:index},typeof warning==='string'?warning:warning?.message||String(warning)))),
                h(WorkPreviewFrame,{session:value.session,saveRequest:previewSaveRequest,onSaved:previewSourceSaved,onState:patch=>previewStateChanged(value.session.nonce,patch)})));
          }
          function workCard(item){
            const graphic=editorMode(item),html=htmlPreviewable(item),thumbnail=html?htmlThumbnailUrl(item):null;
            const unsaved=html&&htmlPreview?.item.id===item.id&&(htmlPreview.state.dirty||htmlPreview.state.editorSaving||htmlPreview.state.busy);
            const cover=html&&!thumbnailFailures[thumbnail]?h('img',{src:thumbnail,alt:item.title,loading:'lazy',onError:()=>setThumbnailFailures(previous=>({...previous,[thumbnail]:true}))}):item.mime?.startsWith('image/')&&!item.mime.includes('svg')?h('img',{src:workPreviewUrl(item),alt:item.title,loading:'lazy'}):h(Icon,{kind:html?'web':item.module,size:40});
            return h('article',{key:item.id,className:'hs-work'},
              html?h('button',{type:'button',className:'hs-work-cover hs-work-preview-cover',onClick:()=>openHtmlPreview(item),'aria-label':t('fullscreenWork')+' · '+item.title},h(HtmlWorkMiniature,{item,fallback:cover})):h('div',{className:'hs-work-cover'},cover),
              h('div',{className:'hs-work-copy'},h('span',{className:'hs-muted hs-small'},title(tasks.find(x=>x.id===item.module)||{title:item.module})),h('h3',null,item.title),item.note&&h('p',{className:'hs-work-note',title:item.note},item.note),h('div',{className:'hs-path hs-work-path',title:item.path},item.path),
                h('div',{className:'hs-actions'},
                  graphic&&button(t(handoffBusy===item.id?'openingEditor':graphic==='layers'?'editLayers':'editImage'),()=>editGraphic(item),{className:'hs-button hs-primary',disabled:!!handoffBusy||busy||sending||workspaceBusy}),
                  item.editable?button(t('editWork'),()=>beginRevision(item),{className:graphic||html?'hs-text-button':'hs-button hs-primary',disabled:busy||sending||workspaceBusy}):textButton(t('linkSource'),()=>linkWorkSource(item)),
                  button(t('reuse'),()=>{if(editingWork)exitRevision();setBrief('');prepare({workId:item.id,task:item.module||'web',style:item.style||undefined,brief:''});},{disabled:busy||sending}),
                  html?textButton(t('download'),()=>downloadHtmlWork(item),{disabled:!!unsaved,title:unsaved?t('saveBeforeDownload'):undefined}):link(t('download'),item.url),item.projectPath&&link(t('projectDownload'),'/huashu-design/printpress/project/'+encodeURIComponent(item.id))),
                graphic==='image'&&h('p',{className:'hs-muted hs-small'},t('imageOnlyHint')),
                !item.editable&&!graphic&&h('p',{className:'hs-muted hs-small'},t('sourceExport')),
                h('div',{className:'hs-actions'},deleting===item.id?h(React.Fragment,null,button(t('confirmDelete'),()=>deleteWork(item.id),{className:'hs-button hs-danger',disabled:busy}),textButton(t('cancel'),()=>setDeleting('')),h('span',{className:'hs-muted hs-small'},t('deleteHelp'))):textButton(t('delete'),()=>setDeleting(item.id),{className:'hs-text-button hs-small hs-muted'}))));
          }
          function recentWorks(){return works.total>0&&h('section',{className:'hs-section'},sectionTitle(t('recent'),null,textButton(t('allWorks'),()=>switchTab('works'))),h('div',{className:'hs-grid'},...works.items.slice(0,3).map(workCard)));}
          function emptyLibrary(){return h('section',{className:'hs-empty'},h('div',{className:'hs-empty-art','aria-hidden':true},...heroArt.slice(0,2).map(x=>h('img',{key:x.id,src:x.specimenUrl,alt:''}))),h('div',null,h('h3',null,t('emptyWorks')),h('p',null,t('emptyHint')),h('div',{className:'hs-actions'},button(t('start'),()=>{switchTab('studio');goTo(formRef,true);},{className:'hs-button hs-primary'}),textButton(t('add'),openRegistration))));}
          function galleryStudio(){return h(React.Fragment,null,
            h('section',{className:'hs-hero'},h('div',{className:'hs-hero-copy'},h('h2',null,t('headline')),h('p',null,t('intro')),h('div',{className:'hs-actions'},button(t('start'),()=>goTo(formRef,true),{className:'hs-button hs-primary'}),textButton(t('explore'),()=>switchTab('styles')))),h('div',null,h('div',{className:'hs-hero-art',key:task,'data-media':task},...heroArt.map(x=>h('button',{key:x.id,type:'button','aria-label':t('preview')+': '+shortTitle(x),onClick:()=>{switchTab('styles');openPreview(x);}},h('img',{src:x.specimenUrl,alt:shortTitle(x)})))),h('p',{className:'hs-art-caption','aria-live':'polite'},currentTask?title(currentTask)+' · ':'',t(task==='motion'?'motionCaption':task==='critique'?'critiqueCaption':'artCaption')))),
            h('section',{className:'hs-section'},sectionTitle(t('formats'),t('formatHint')),h('div',{className:'hs-format-grid'},...tasks.map(x=>h('button',{type:'button',key:x.id,className:'hs-format-tile','aria-pressed':task===x.id,disabled:sending||!!editingWork,onClick:()=>chooseTask(x.id,false)},h(Icon,{kind:x.id,size:23}),h('strong',null,title(x)))))),
            h('div',{className:'hs-section'},composer()),
            h('section',{className:'hs-section'},sectionTitle(currentTask?title(currentTask)+' · '+t('inspiration'):t('inspiration'),t('inspirationHint'),textButton(t('viewAll'),browseTask)),h('div',{className:'hs-grid',key:task},...referenceStyles.slice(0,3).map(styleCard))),recentWorks());}
          function indexStudio(){const cover=related[0];return h('div',{className:'hs-index-layout'},h('aside',{className:'hs-index-rail','aria-label':t('formats')},h('h2',null,t('formats')),...tasks.map(x=>h('button',{type:'button',key:x.id,'aria-pressed':task===x.id,disabled:sending||!!editingWork,onClick:()=>chooseTask(x.id,false)},title(x),h('small',null,stylesForTask(x.id).length)))),h('div',null,h('header',{className:'hs-index-heading'},cover&&h('img',{src:cover.specimenUrl,alt:shortTitle(cover)}),h('div',null,h('h2',null,currentTask?title(currentTask):t('studio')),h('p',null,currentTask?description(currentTask):t('mediaHint')))),h('div',{className:'hs-index-meta'},h('span',null,related.length+' '+t('countStyles')),currentTask&&textButton(t('formatGuide'),()=>readDoc(currentTask.resource))),h('div',{className:'hs-index-samples'},...referenceStyles.map(styleCard)),composer(),h('div',{style:{marginTop:26}},recentWorks())));}
          function stylesPage(){return h(React.Fragment,null,h('div',{className:'hs-page-title'},h('div',null,h('h2',null,t('styles')),h('p',null,t('styleHint'))),h('span',{className:'hs-muted hs-small'},styles.length+' '+t('countStyles'))),previewPanel(),h('div',{className:'hs-filterbar'},searchBox(),...['all','web','ppt','info','app','east','xhs'].map(cat=>button(h(React.Fragment,null,t(cat),h('span',null,cat==='all'?styles.length:styles.filter(x=>x.category===cat).length)),()=>{setGroup(cat);setPage(0);setPreview('');},{key:cat,className:'hs-filter','aria-pressed':group===cat}))),h('div',{className:'hs-grid'},...filteredStyles.slice(page*12,page*12+12).map(styleCard)),!filteredStyles.length&&h('p',{className:'hs-muted'},t('noMatches')),h('div',{className:'hs-pagebar'},button(t('previous'),()=>setPage(page-1),{disabled:page===0}),h('span',null,`${Math.min(page*12+1,filteredStyles.length)}–${Math.min((page+1)*12,filteredStyles.length)} / ${filteredStyles.length}`),button(t('next'),()=>setPage(page+1),{disabled:(page+1)*12>=filteredStyles.length})));}
          function worksPage(){return h(React.Fragment,null,h('div',{className:'hs-page-title'},h('div',null,h('h2',null,t('works')),h('p',null,works.total+' '+t('countWorks'))),h('div',{className:'hs-actions'},textButton(h(Icon,{kind:'library',size:18}),()=>refresh(),{'aria-label':t('refresh')}),button(h(React.Fragment,null,h(Icon,{kind:'add',size:18}),t('add')),()=>addForm?setAddForm(false):openRegistration(),{className:'hs-button hs-primary'}))),
            addForm&&h('form',{className:'hs-composer hs-add-form',onSubmit:saveWork,ref:registerRef},h('label',null,t('titleLabel'),h('input',{value:workTitle,onChange:e=>setWorkTitle(e.target.value),required:true,maxLength:240})),h('label',null,t('pathLabel'),h('input',{value:workPath,onChange:e=>setWorkPath(e.target.value),required:true,placeholder:'D:\\projects\\my-design\\index.html'})),h('label',null,t('sourceLabel'),h('input',{value:workSourcePath,onChange:e=>setWorkSourcePath(e.target.value),placeholder:'D:\\Projects\\Design\\index.html'})),h('p',{className:'hs-muted hs-small'},t('sourceHint')),h('div',{className:'hs-form-row'},formatSelect(true),h('label',null,t('styleLabel'),h('select',{value:registerStyle,onChange:e=>setRegisterStyle(e.target.value)},h('option',{value:''},t('freeStyle')),...styles.map(x=>h('option',{key:x.id,value:x.id},shortTitle(x)))))),h('label',null,t('noteLabel'),h('input',{value:note,onChange:e=>setNote(e.target.value),maxLength:4000})),h('div',{className:'hs-actions'},h('button',{type:'submit',className:'hs-button hs-primary',disabled:busy},t('save')),textButton(t('cancel'),()=>setAddForm(false)))),
            !works.total?emptyLibrary():h(React.Fragment,null,
              h('div',{className:'hs-filterbar'},searchBox(),...[['all',t('allTypes'),works.items.length],...workTypes.map(id=>[id,title(tasks.find(x=>x.id===id)||{title:id}),workTypeCounts[id]])].map(([id,label,count])=>button(h(React.Fragment,null,label,h('span',null,count)),()=>setWorkType(id),{key:id,className:'hs-filter','aria-pressed':activeWorkType===id}))),
              h('div',{className:'hs-grid'},...filteredWorks.map(workCard)),
              !filteredWorks.length&&h('p',{className:'hs-muted'},t('noMatches')),
              works.nextOffset!=null&&button(t('next'),async()=>{try{const r=await action('list',{offset:works.nextOffset,limit:100});setWorks({...r,items:[...works.items,...r.items]});}catch(e){setError(e.message);}})) );}
          function workflowsPage(){return h(React.Fragment,null,h('div',{className:'hs-page-title'},h('div',null,h('h2',null,t('workflowIntro')),h('p',null,t('workflowHint')))),editingWork&&h('p',{className:'hs-message'},t('revisionWorkflowHint')),h('div',{className:'hs-flow-list'},...flows.map((x,i)=>h('article',{key:x.id,className:'hs-flow'},h(Icon,{size:32,kind:['explore','book','library','critique'][i]}),h('div',null,h('h3',null,title(x)),h('p',null,description(x)),button(t('useWorkflow'),()=>prepare({workflow:x.id}),{disabled:busy||sending||(!!editingWork&&x.id!=='review-polish')}))))));}
          // Highlighting returns plain text segments only; they become spans with a
          // token class. Concatenated text always equals the fence source, so copying
          // a block never yields a reflowed or escaped variant of the original.
          function highlightSegments(text,lang){
            return highlight(text,lang).map((segment,index)=>segment.kind==='plain'
              ?segment.text
              :h('span',{key:index,className:'hs-tok-'+segment.kind},segment.text));
          }
          function documentLink(token,key,image=false){
            const target=resolveHandbookTarget(token.href||'',doc.path);
            const label=image?(token.text||t('docImage')):renderDocInline(token.tokens||[{type:'text',text:token.text||token.href||''}]);
            if(image&&target.kind==='image')return h('img',{key,src:target.url,alt:token.text||'',loading:'lazy'});
            if(target.kind==='external')return h('a',{key,href:target.href,target:target.href.startsWith('mailto:')?undefined:'_blank',rel:'noopener noreferrer'},label);
            if(target.kind==='image')return h('a',{key,href:target.url,target:'_blank',rel:'noopener noreferrer'},label);
            if(target.kind==='document'||target.kind==='anchor')return h('a',{key,href:target.kind==='anchor'?'#'+encodeURIComponent(target.fragment||''):'#',onClick:e=>{e.preventDefault();if(target.kind==='anchor')scrollChapter(target.fragment||'');else readDoc(target.path,{fragment:target.fragment});}},label);
            return h('span',{key,className:'hs-doc-unlinked',title:target.path||token.href},label);
          }
          function renderDocInline(tokens){return (tokens||[]).map((token,index)=>{            const nested=()=>renderDocInline(token.tokens||[]);
            switch(token.type){
              case 'strong':return h('strong',{key:index},...nested());
              case 'em':return h('em',{key:index},...nested());
              case 'del':return h('del',{key:index},...nested());
              case 'codespan':return h('code',{key:index},token.text);
              case 'br':return h('br',{key:index});
              case 'link':return documentLink(token,index);
              case 'image':return documentLink(token,index,true);
              case 'html':return null;
              default:return token.tokens?h(React.Fragment,{key:index},...nested()):handbookText(token.text||'');
            }
          });}
          function renderDocBlocks(tokens,skipTitle){return (tokens||[]).map((token,index)=>{
            const props={key:index};
            switch(token.type){
              case 'space':case 'def':return null;
              case 'heading':return token.id===skipTitle?null:h('h'+Math.min(6,token.depth+1),{...props,id:'hs-doc-heading-'+token.id,'data-handbook-id':token.id,tabIndex:-1},...renderDocInline(token.tokens));
              case 'paragraph':return h('p',props,...renderDocInline(token.tokens));
              case 'text':return token.tokens?h(React.Fragment,props,...renderDocInline(token.tokens)):handbookText(token.text||'');
              case 'blockquote':return h('blockquote',props,...renderDocBlocks(token.tokens,skipTitle));
              case 'code':{
                // Fence blocks carry the code the reader needs to copy verbatim, so the
                // header shows the language and a copy action. `tabIndex` on the pre element
                // lets keyboard users scroll the region without a pointer.
                const lang=(token.lang||'').split(/\s/)[0];
                const id='code-'+index;
                const text=token.text||'';
                return h('div',{...props,className:'hs-doc-code'},
                  h('div',{className:'hs-doc-code-head'},
                    h('span',{className:'hs-doc-code-label'},lang||t('docCode')),
                    h('button',{type:'button',className:'hs-doc-code-copy','data-copied':copiedBlock===id?'true':undefined,'aria-label':t('docCodeCopy'),onClick:()=>copyBlock(id,text)},copiedBlock===id?t('docCodeCopied'):t('docCodeCopy'))),
                  h('pre',{tabIndex:0,role:'region','aria-label':lang?lang+' '+t('docCode'):t('docCode')},
                    h('code',null,...highlightSegments(text,lang))));
              }
              case 'html':return h('pre',{...props,className:'hs-doc-html'},h('code',null,token.text));
              case 'hr':return h('hr',props);
              case 'list':return h(token.ordered?'ol':'ul',{...props,start:token.ordered?token.start:undefined},...token.items.map((item,i)=>h('li',{key:i,className:item.task?'hs-doc-task':undefined},item.task&&h('input',{type:'checkbox',disabled:true,checked:!!item.checked,'aria-label':t('docTask')}),...renderDocBlocks(item.tokens,skipTitle))));
              case 'table':{
                const row=(cells,rowKey,head=false)=>h('tr',{key:rowKey},...cells.map((cell,i)=>h(head?'th':'td',{key:i,style:token.align?.[i]?{textAlign:token.align[i]}:undefined},...renderDocInline(cell.tokens))));
                return h('div',{...props,className:'hs-doc-table',tabIndex:0,role:'region','aria-label':t('docTable')},h('table',null,h('thead',null,row(token.header,'head',true)),h('tbody',null,...token.rows.map((cells,i)=>row(cells,i)))));
              }
              default:return token.tokens?h('div',props,...renderDocBlocks(token.tokens,skipTitle)):token.text?h('p',props,handbookText(token.text)):null;
            }
          });}
          function handbookReader(){
            if(!doc||!handbook)return null;
            const topTitle=handbook.tokens.find(token=>token.type==='heading'&&token.depth===1);
            const chapters=handbook.toc.filter(entry=>!chapterSearch||entry.text.toLowerCase().includes(chapterSearch.toLowerCase()));
            const minutes=Math.max(1,Math.ceil(handbook.wordCount/500));
            const progress=docProgress?.total?Math.min(100,Math.round(docProgress.loaded/docProgress.total*100)):0;
            const toc=h('aside',{className:'hs-reader-toc'+(tocOpen?' is-open':'')},h('h3',null,t('docContents')),button(t('docContents')+' · '+handbook.toc.length,()=>setTocOpen(!tocOpen),{className:'hs-doc-toc-toggle','aria-expanded':tocOpen,'aria-controls':'hs-doc-toc'}),h('nav',{id:'hs-doc-toc','aria-label':t('docContents')},h('input',{type:'search',value:chapterSearch,onChange:e=>setChapterSearch(e.target.value),placeholder:t('docFindChapter'),'aria-label':t('docFindChapter')}),...chapters.map(entry=>h('button',{type:'button',key:entry.id,onClick:()=>scrollChapter(entry.id),'aria-current':activeChapter===entry.id?'location':undefined,style:{'--hs-level':Math.min(3,entry.depth-1)}},entry.text)),!chapters.length&&h('p',{className:'hs-muted'},t('noMatches'))));
            return h('section',{className:'hs-reader',ref:docRef},h('div',{ref:docArticleRef},
              h('div',{className:'hs-reader-toolbar'},textButton(h(React.Fragment,null,'← ',t('back')),backDoc),h('div',{className:'hs-actions'},textButton(t(docRaw?'docFormatted':'docRaw'),()=>setDocRaw(!docRaw),{'aria-pressed':docRaw}),textButton(t('docCopy'),copyDoc,{disabled:docLoading||!doc.content}),textButton(t('docClose'),closeDoc))),
              h('header',{className:'hs-reader-heading'},h('div',{className:'hs-reader-eyebrow'},t('resource')),h('h2',{id:topTitle?'hs-doc-heading-'+topTitle.id:undefined,'data-handbook-id':topTitle?.id,tabIndex:-1},handbook.title),h('div',{className:'hs-reader-meta'},h('span',null,t('docReadTime')+' '+minutes+' '+t('docMinutes')),h('span',null,handbook.toc.length+' '+t('docChapters')),doc.nextOffset!==null&&!docLoading&&h('span',null,t('docPartial'))),h('p',{className:'hs-path'},doc.path)),
              docLoading&&h('div',{className:'hs-reader-loading',role:'status'},t('docLoading')+' '+progress+'%',h('progress',{value:progress,max:100,'aria-label':t('docLoading')})),
              docError&&h('div',{className:'hs-error',role:'alert'},docError,' ',textButton(t('retry'),()=>readDoc(doc.path,{history:false}))),
              docNotice&&h('p',{className:'hs-reader-notice',role:'status'},docNotice),
              h('div',{className:'hs-reader-layout'+(docRaw?' is-raw':'')},!docRaw&&toc,h('article',{className:'hs-prose'},docRaw?h('pre',{className:'hs-reader-raw'},doc.content):renderDocBlocks(handbook.tokens,topTitle?.id),doc.nextOffset!==null&&!docLoading&&h('div',{className:'hs-doc-more'},h('p',null,t('docPartialHint')),button(t('more'),()=>readDoc(doc.path,{append:true}),{className:'hs-button hs-primary'})))),
              h('footer',{className:'hs-reader-footer'},h('span',null,docLoading?t('docLoading'):doc.nextOffset===null?t('docEnd'):t('docPartial')),textButton(t('docTop'),()=>goTo(docRef)))));
          }
          function guidePage(){return h(React.Fragment,null,h('div',{className:'hs-page-title'},h('div',null,h('h2',null,t('guideIntro')),h('p',null,t('guideHint'))),button(t('readSkill'),()=>readDoc('SKILL.md'))),h('div',{className:'hs-method'},...[1,2,3,4].map((n)=>h('div',{key:n},h(Icon,{kind:['check','explore','critique','library'][n-1],size:23}),t('method'+n)))),h('div',{className:'hs-guide-list'},...tasks.map(x=>h('article',{className:'hs-guide-row',key:x.id},h('div',null,h('h3',null,title(x)),h('p',null,description(x))),button(h(React.Fragment,null,h(Icon,{kind:'book',size:17}),t('formatGuide')),()=>readDoc(x.resource))))));}
          function palettePicker(){
            const preset=THEME_PRESETS.find(item=>item.id===themeId),name=t(preset?.labelKey||(themeId==='host'?'themeHost':'themeCustom'));
            return h('div',{className:'hs-palette',ref:paletteRef,onKeyDown:event=>{if(event.key==='Escape'){event.stopPropagation();setPaletteOpen(false);paletteTriggerRef.current?.focus();}}},
              h('span',{ref:hostColorProbe,className:'hs-host-color-probe',style:{color:'var(--dsw-alias-brand-primary)'},'aria-hidden':true},'•'),
              button(h(React.Fragment,null,h('i',{className:'hs-color-dot',style:{background:paletteVars['--hs-accent']},'aria-hidden':true}),t('palette'),' · ',name),()=>setPaletteOpen(value=>!value),{ref:paletteTriggerRef,className:'hs-button hs-palette-trigger','aria-expanded':paletteOpen,'aria-controls':'hs-palette-options'}),
              paletteOpen&&h('div',{id:'hs-palette-options',className:'hs-palette-options',role:'group','aria-label':t('paletteOptions')},
                h('div',{className:'hs-palette-presets'},...THEME_PRESETS.map(item=>button(h(React.Fragment,null,h('i',{className:'hs-color-dot',style:{background:item.color},'aria-hidden':true}),t(item.labelKey),themeId===item.id&&h(Icon,{kind:'check',size:16})),()=>choosePalette(item.id),{key:item.id,className:'hs-palette-option','aria-pressed':themeId===item.id}))),
                button(h(React.Fragment,null,h('i',{className:'hs-color-dot',style:{background:hostAccent},'aria-hidden':true}),t('themeHost'),themeId==='host'&&h(Icon,{kind:'check',size:16})),()=>choosePalette('host'),{className:'hs-palette-option hs-palette-host','aria-pressed':themeId==='host'}),
                h('div',{className:'hs-palette-custom'},button(h(React.Fragment,null,t('themeCustom'),themeId==='custom'&&h(Icon,{kind:'check',size:16})),()=>choosePalette('custom'),{className:'hs-palette-custom-select','aria-pressed':themeId==='custom'}),h('input',{type:'color',value:customColor,onChange:event=>choosePalette('custom',event.target.value),'aria-label':t('themeCustom')}),h('code',null,customColor.toUpperCase())),
                h('p',{className:'hs-muted hs-small'},t('workbenchPaletteHint'))));
          }
          function navKeyDown(e,index){if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const ids=['studio','styles','works','printpress','workflows','guide'];const next=e.key==='Home'?0:e.key==='End'?ids.length-1:(index+(e.key==='ArrowRight'?1:-1)+ids.length)%ids.length;switchTab(ids[next]);requestAnimationFrame(()=>rootRef.current?.querySelector(`#hs-tab-${ids[next]}`)?.focus());}
          return h('div',{className:'hs-design'+(previewVisible?' is-viewer-open':''),ref:rootRef,style:paletteVars,'data-palette':themeId,'data-direction':direction,'data-ui-version':'0.6.2'},h('style',null,CSS),h('div',{className:'hs-wrap'+(tab==='printpress'?' is-printpress':''),inert:previewVisible?'':undefined,'aria-hidden':previewVisible||undefined},
            h('header',{className:'hs-topbar'},h('div',{className:'hs-brand'},h(Icon,{size:30}),h('div',null,h('h1',null,t('title')))),h('nav',{className:'hs-nav',role:'tablist','aria-label':t('title')},...['studio','styles','works','printpress','workflows','guide'].map((id,i)=>h('button',{type:'button',key:id,role:'tab',id:'hs-tab-'+id,tabIndex:tab===id?0:-1,'aria-selected':tab===id,'aria-controls':'hs-body',onClick:()=>switchTab(id),onKeyDown:e=>navKeyDown(e,i)},t(id)))),palettePicker()),
            !doc&&tab!=='printpress'&&h('section',{className:'hs-direction','aria-label':t('directionLabel')},h('div',null,h('div',{className:'hs-direction-label'},t('directionLabel')),h('div',{className:'hs-direction-switch'},...['gallery','index'].map(id=>h('button',{type:'button',key:id,'aria-pressed':direction===id,title:t(id+'Desc'),onClick:()=>{setDirection(id);setTab('studio');setPreview('');}},t(id)))))),
            error&&h('div',{className:'hs-message',role:'alert'},error,' ',textButton(t('retry'),()=>refresh())),status&&h('div',{className:'hs-message',role:'status'},status),
            publishedWork&&h('div',{className:'hs-message hs-published',role:'status'},h('span',null,t('layeredPublished')),' ',button(t('editNow'),()=>{const item=publishedWork;setPublishedWork(null);editGraphic(item);},{className:'hs-button hs-primary'})),
            !catalog?h('div',{className:'hs-message',role:'status'},t('loading')):h('div',{id:'hs-body',role:'tabpanel','aria-labelledby':'hs-tab-'+tab},doc?handbookReader():h(React.Fragment,null,tab!=='printpress'&&sourceEditor(),tab==='studio'&&(direction==='gallery'?galleryStudio():indexStudio()),tab==='styles'&&stylesPage(),tab==='works'&&worksPage(),tab==='workflows'&&workflowsPage(),tab==='guide'&&guidePage()),printpressVisited&&h('div',{hidden:!!doc||tab!=='printpress'},h(PrintpressPanel,{locale:locale.active,onEvent:onWorkbenchEvent})))
          ),htmlWorkPreviewPanel());
        }
        ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:NS,order:7,label:()=>t('title')},Icon));
        ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:NS},Panel));
      }
    };
  }
});

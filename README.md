# 试卷题目识别（题库）

拍照/上传试卷 → **整页全量识别** → 结构化 JSON → 校对 → 管理、重做、导出。

需求与技术细节见 `docs/需求文档.md`、`docs/技术文档.md`。

## 架构（一句话版）

- **识别**：WorkBuddy 对话内识别（agent 按 `prompts/recognition-spec.md` 规范输出 JSON，零 API key）
- **输出范围**：只做题目识别 + 题型分类。题干/选项/图形/题型/来源坐标/置信度；**不含**答案、解析、对错、学生作答、批改、知识点标签
- **存储**：`data/questions/` 每题一个 JSON（schema v2）+ SQLite（`data/cuotiji.db`）
- **校对**：`engine/render.py` 生成**单文件自包含** HTML（KaTeX 与图片全部内联），四层页面：
  **卷卡片页（日期筛选）→ 卷详情页（该卷题目列表）→ 题目详情页（左右对照）**，
  外加一个平级的**已生成试卷列表页**（`papers.html`：所有排好的卷面 + PDF 入口）
- **成卷**：`engine/paper.py` 把题库按题型**重排成 A4 试卷**（可直接打印/导出 PDF），
  也能**按原卷版面逐卷还原**成一版干净的、重新打印给学生做的卷面
- **上线**：`app/` 是**多人在线题库网页应用**（WorkBuddy 云服务：账号 / 试卷记录 / 原图存储），
  多用户各自独立题库、可上传自己的试卷照片。识别仍走对话，见下面「网页应用」章节
- **升级路径**：批量/手机直传 → WorkBuddy 云服务免密钥 LLM；保底 → DeepSeek key / 本地 Pix2Text

## 快速开始

### 1. 只想点点界面（本地，零配置）

```bash
python tools/serve_with_csp.py --port 64911 --root app
# 打开 http://127.0.0.1:64911/index.html
```

本机访问会自动进**演示模式**：内置 5 份卷 / 135 题，不需要云服务、不需要登录、不调用任何模型
（`app/js/local-demo.js`，线上按 hostname 判定永不激活）。`?demo=0` 可关掉演示走真实登录链路，
`?limit=2` 可模拟生产那套「每账号 2 次识别」。

### 2. 想传自己的试卷（要一套云服务）

识别与存储都走 WorkBuddy 云服务（账号 / 数据库 / 文件存储 / 免密钥大模型），要自己开通：

1. 为这个项目开通云服务，拿到返回的 `publicConfig`；
2. 用它整体替换 `app/js/config.js` 里的三个值：`endpoint` / `oauthRelayBaseUrl` / `publishableKey`；
3. 在云数据库建表并开 RLS（`papers` / `paper_files` / `questions` / `custom_papers` /
   `question_backups` / `recognition_usage`，策略见「网页应用」章节）；
4. 重新打开页面 → 微信扫码登录 → 上传。

> ⚠️ 仓库里的 `app/js/config.js` 是**作者自己那个应用**的接入信息。服务端按 Origin 精确校验，
> 换成别人的域名直接登录/识别失败 —— 必须换成你自己的，别指望蹭。

**免密钥大模型扣的是应用创建者（=你）的积分**，不是登录用户的。实测约 0.11~0.21 分/页；
要给外人用，记得在 `recognition_usage` 那套配额函数里设个上限（默认 2 次）。

### 3. 仓库里没有什么

`data/`（真实试卷照片、SQLite、裁剪图、渲染产物）和 `.workbuddy/`（本地工作区、记忆、临时截图）
都不在仓库里 —— 见 `.gitignore`，它们由每个部署者自己跑出来，体量在几百 MB 量级。

## 目录结构

```
app/             **网页应用**（多人在线题库，发布到 WorkBuddy 云服务，见下面「网页应用」章节）
  index.html     登录卡 + 我的试卷列表（可载入内置示例卷）
  upload.html    选多张照片建卷并上传（选择顺序 = 页序）
  paper.html     卷详情：原图 + 逐题列表
  question.html  单题左右对照
  print.html     A4 卷面还原 + 浏览器打印（?id= 照片卷 / ?custom= 组卷）
  compose.html   组卷台：选题 + 排版同一页（左题库、右卷面编辑画布）
  customs.html   我的组卷列表
  css/app.css    应用样式（含打印样式 .sheet / @page）
  css/katex.css  KaTeX（20 个 woff2 已内联，tools/build_webapp_assets.py 生成，别手改）
  js/config.js   云服务 publicConfig（endpoint / oauthRelayBaseUrl / publishableKey）
  js/cloud.js    唯一的 SDK 初始化点 + 数据层
  js/render.js   engine/render.py 的前端版（符号内联 SVG、运算符 KaTeX、[?] 高亮、按 bbox 抠图）
  js/sheet.js    卷面渲染引擎（题号方案 / 按题型分板块 / 原卷版面还原 / A4 真分页 / 插图排布；print 与 compose 共用）
  js/qtype.js    题型分桶规则（全站唯一口径：首页统计 / 组卷台筛选 / 卷面板块 共用；先认板块名再看 qtype）
  js/sheet-edit.js 卷面就地排版控制器（拖拽 / 就地改标题列数 / 编号面板；两个页面共用）
  js/local-demo.js 本机专用演示数据层（线上按 hostname 判定永不激活）
  js/ui.js       顶栏 / 登录守卫 / 原图签名缓存 / 灯箱
  js/recognize.js       上传即识别：canvas 画参考刻度图 → 调免密钥大模型 → 归一化落库
  js/recognize-prompt.js 提示词产物（tools/build_prompt.py 编译 prompts/auto-recognize-prompt.md，别手改）
  js/vendor/     workbuddy-cloud-sdk.js（IIFE，本地落地不走 CDN）+ katex.min.js + auto-render.min.js
  assets/benchmark/  内置示例原图（ASCII 名 demo-XX-Y.jpg，storage_path 用 local: 前缀直出）
  assets/demo-library.json  示例题库（5 份卷 / 135 题），供首页「载入示例卷」按钮
data/
  questions/          每题一个 JSON（schema v2）
  questions_v1_backup/ v1 旧结构备份（迁移前原件，只读留档）
  crops/       裁剪图：<题目id>.jpg 为题区，<题目id>-figN.jpg 为题内插图子图
  thumbs/      原图缩略图（tools/make_thumbs.py 生成，卷卡片页用，宽度 520）
  render/      **网页根目录**（UI 要点的东西全在这，跨目录相对链接在预览面板下会 404）：
               index.html 卷卡片页 / papers.html 已生成试卷 / doc-*.html 卷详情 / q-*.html 单题 /
               paper-<slug>.html + paper-all.html 可打印卷面 / 同名 .pdf / thumb-*.png 卷面首页缩略图
  paper/       版面体检产物（不进 UI）：preview*/pageN.png 每页 PNG、manifest.json
               （页数/PDF/缩略图清单，由 tools/export_paper_pdf.py 写、render.py 读）
  benchmark/   基准测试集（10 张真实试卷照片）+ _sizes.json（像素尺寸，bench_sizes.py 生成）
  cloud_push/  云端导入产物：一份卷一条 .sql（由 tools/cloud_sync.py 生成）+ demo-library.json
  samples/     演示样例
engine/
  render.py    JSON -> 校对 HTML（纯标准库；KaTeX 与图片全部内联，零外部请求；
               页面：卷卡片页（按日期筛选）/ 卷详情页（该卷题目列表）/ 题目详情页 /
               已生成试卷列表（扫 paper-*.html + 读 data/paper/manifest.json，无需手工维护清单）；
               占位符号 □ ○ △ ☆ / ■ ● ▲ ★ 用内联 SVG 等宽绘制，尺寸按原卷墨迹比例定）
  paper.py     JSON -> A4 试卷（组卷：按题型重排、自动汇总分值、剔除带 [?] 的题；
               或 --by-doc 按原卷版面逐卷还原。页面 <head> 里嵌 x-paper 元信息供试卷列表读取）
  vendor/katex/  KaTeX 0.16.11 本地副本（CSS/JS/20 个 woff2），由 tools/install_katex.py 落盘
  db.py        SQLite 初始化/导入/列表（纯标准库）
  crop_check.py  裁剪边界自检（Pillow+numpy：逐题查四条边有无切字/标题残留/序号残留，
                 并按 figure.bbox 检查题内插图子图）
prompts/
  recognition-spec.md   识别规范正本（唯一真源，修订只改这里）
  auto-recognize-prompt.md  识别规范的「机器可执行版」：给自动识别链路当提示词用
                       （云服务免密钥大模型）。规范改了要同步改这里，反之亦然
tools/
  ingest_*.py / refit_crops_*.py   各份试卷的入库与重裁脚本（含坐标推导过程，可作模板）
  page_layout_probe.py 版面探针：按颜色分离「印刷体 / 红笔 / 铅笔」后找**印刷题目的行核**与行内列段
                       （笔迹多的卷子必须先用它——灰度二值化会把题目行与笔迹连成一条带）
  migrate_v1_to_v2.py  schema 迁移（先备份 data/questions_v1_backup/ 再转换，可回滚）
  install_katex.py     下载 KaTeX 静态资源到 engine/vendor/katex/（换机器/升级版本时用）
  serve_with_csp.py    带预览面板 CSP 头的本地服务器（验证资源类改动，file:// 测不出来）
  make_thumbs.py       原图 -> data/thumbs/ 缩略图（卷卡片页用；缺了 render 会回退原图但页面很大）
  ui_e2e_check.py      UI 端到端自检（iframe 驱动点击：筛选切显隐 + 卡片→卷→题目→试卷列表→
                       打印页跳转 + 链接可达性，跑在带 CSP 的本地服务器上，出截图 + 违规计数）
  ui_e2e_test.html     ↑ 自检用的驱动页（copy 到静态根下由 chrome 执行，跑完自动删除）
  export_paper_pdf.py  试卷导出 PDF + 版面体检（页数、每页留白、每页首行）+ 试卷列表清单
  fix_*.py             一次性修正脚本（如 fix_20261001_rev2.py：按印刷题号合并被拆开的小题）
  build_webapp_assets.py  网页应用的 KaTeX 资源生成（字体内联进 app/css/katex.css）
  bench_sizes.py       原图像素尺寸 -> data/benchmark/_sizes.json（网页端抠图要用）
  cloud_sync.py        本地题库 -> 云端导入 SQL + 应用内示例题库（见「网页应用」章节）
  probe_wechat_login.mjs  线上应用诊断（零依赖 · node22 内置 WebSocket 直连 Chrome CDP）：
                       手机 UA + 设备尺寸打开线上页、调 signInWithOAuth 拿真实跳转 URL、
                       截图、汇总网络失败与 console 错误。查「登录/手机端」类问题先用它
  recog_pilot.mjs      自动识别试点：在**线上应用自己的页面**里（真实 Origin）把一页原图 +
                       prompts/auto-recognize-prompt.md 送进免密钥大模型，收流式 JSON 存盘。
                       为什么不用 curl：免密钥通道按精确 Origin 校验，且规范禁止手写 /.cloud/llm 请求。
                       用法见下「自动识别试点」；需先在 bash 里常驻一个 headless Chrome
  recog_compare.py     试点对账：模型输出 vs data/questions/ 人工标注，逐字段比
                       （题干/选项/题型/印刷题号/板块 + bbox IoU），并打印差异明细
  build_prompt.py     提示词正本 -> app/js/recognize-prompt.js（前端读不到 .md；改了正本必须重跑，
                       --check 只校验是否同步）
  make_ruler_image.py 给试卷图加「参考网格 + 边缘刻度」（Python 版，离线看刻度图效果用）
  reco_e2e_check.mjs  端到端验证 app/js/recognize.js 的真实链路：把前端那两个 js 注入**线上页面**，
                       在页面里造 File 走完整 recognizePage（canvas → 模型 → 归一化）-> *.rows.json
  reco_rows_compare.py 对账**应用真实落库的坐标**：覆盖率 / 精度 / IoU 三个数一起看
                       （框是刻意放大的，只看 IoU 会误判成"全错"）
  app_pages_check.mjs 应用页面自检：JS 异常 / 静态资源 404 / CSP 违规 / 识别所需全局对象是否就位
  compose_lay_check.mjs 组卷台自检（28 项）：选题与排版同一页 —— 加题落到卷面、卷面 × 移出、
                       拖动换板块、卷名即卷头、一次保存把题目/顺序/排版/编号全写进去、刷新还原、
                       整页高度 ≈ 内容底（不会往下滚出一大片空白）、题库按页渲染（首屏 80 条 /
                       滚到底续渲 / 点「加入」只改那一行）、壳放宽 1500px 卷面 1:1
  print_no_check.mjs  卷面编号规约自检（21 项）：大题序号随位置重排、每板块小题从 1 起、
                       计算题不印号、编号面板（数字形式 × 包裹样式 × 单板块开关）
  demo_check.mjs      演示模式端到端（10 项）：进排版 → 拖题跨板块 → 保存 → 刷新仍在 → 组卷台保存
  limit_check.mjs     识别次数与登录方式（28 项）：本地默认不限 / ?limit=2 跨页面记住 /
                       第 3 次拒绝 / 删卷不返还 / 用完按钮按住 / 生产只渲染微信登录（用
                       --host-resolver-rules 把 prod.test 指到本机，离线验生产判定）
  reco_audit_check.mjs 识别后自检判据对账（24 项）+ 真实题库误报率（纯 node，不需要浏览器）
  fig_edit_check.mjs  题内插图自检（29 项）：切图入口（没图也有）/ 新建模式在整页原图上拖框 /
                       占位行插在光标处 / 显示大小与位置（真量像素） / 落库往返 / 卷面默认宽与
                       "手工定过位置就不让题型默认落位抢" / 多张原图选图与 seg.img
  fig_view_check.py   题内插图「显示大小 / 位置」的**三端口径对账**（21 项）：app/js/render.js、
                       engine/render.py 内联段、engine/paper.py 的 fig_view 必须同一套类名与
                       --fdw（纯 stdlib，不需要浏览器；两边不同步时第一个报警）
  figsnap_proto.py    **插图框吸附**（= app/js/refine.js 的 snapFigures 的 Python 孪生），
                      参数 FIG_DEFAULTS 两边必须一字不差；判据/兜底规则见文件头
  figsnap_eval.py     插图吸附对账：9 张人工逐像素核过的插图框上比「外扩 25%」与「吸附」的 IoU
                      与覆盖率，逐张标出"比现状差"的（理论上应为 0）。--json 存结果喂给 JS 侧
  figsnap_js_check.mjs 把 refine.js 注入浏览器跑同一批插图，逐张比 JS 与 Python 的框（>6px 报不一致）
                       并算 IoU —— 两边参数/判据不同步时第一个报警
  dump_ruler_canvas.mjs 导出 canvas 版刻度图（改了 buildRulerCanvas 一定要亲眼看过）
  layout_blocks_probe.py / coord_refine_proto.py  两条**已排除**路线的诊断脚本，留着是证据：
                       前者证明本地行/列投影在手写笔迹密集的卷上会连成整块，
                       后者证明"从模型框中心向外吸附"必然吸到相邻行
```

## 常用命令

> 下面几段里的 `PY=` / `IMGENV=` 是**作者本机的解释器路径**，换到自己机器上直接改成
> `python`（引擎脚本只依赖标准库；图片相关的 `make_thumbs.py` / `crop_check.py` 需要 Pillow + numpy）。

```bash
# 引擎脚本（纯标准库）
PY=C:\Users\1\.workbuddy\binaries\python\versions\3.13.12\python.exe
%PY% tools/install_katex.py               # 只在新机器/升级 KaTeX 时跑（已内置本地副本）
%PY% engine/db.py import data/questions    # 入库（自动建表）
%PY% engine/db.py import data/questions --prune   # 入库 + 删掉 JSON 已不在的孤儿记录（修过数据后要跑）
%IMGENV% tools/make_thumbs.py              # 原图缩略图（卷卡片页用；新卷入库后跑一次）
%PY% engine/render.py data/questions       # 渲染校对页 + 已生成试卷列表（index/doc-*/q-*/papers）
%PY% engine/render.py data/questions --no-katex   # 不内联 KaTeX（页面小，公式显 LaTeX 原文）
%PY% engine/db.py list                     # 查看已入库题目

# 成卷（题库 -> A4 试卷；两种模式都写进 data/render/）
%PY% engine/paper.py                        # 全库合并重排 -> data/render/paper-all.html
%PY% engine/paper.py --by-doc               # 按原卷版面逐卷还原 -> data/render/paper-<slug>.html
%PY% engine/paper.py --by-doc --scores      # 同上，但标估计分值（stderr 会警告是估的）
IMGENV=C:\Users\1\.workbuddy\binaries\python\envs\default\Scripts\python.exe
%IMGENV% tools/export_paper_pdf.py --docs   # 批量 PDF + 缩略图 + 页数清单（试卷列表页要用）
# 顺序：paper.py -> export_paper_pdf.py -> render.py（渲染放最后，papers.html 才拿得到页数）

# 图片处理（隔离环境，已装 Pillow / numpy）
IMG=C:\Users\1\.workbuddy\binaries\python\envs\default\Scripts\python.exe
%IMG% tools/ingest_20260930.py             # 首次入库脚本（可作后续模板）
%IMG% engine/crop_check.py                 # 裁剪自检：切字/标题残留/序号残留
%IMG% engine/crop_check.py --all           # 打印全部明细

# 网页应用 / 自动识别（改了提示词正本必须重跑编译，否则线上跑的还是旧提示词）
%PY% tools/build_prompt.py                 # prompts/auto-recognize-prompt.md -> app/js/recognize-prompt.js
%PY% tools/build_prompt.py --check         # 只校验产物是否与正本同步
%PY% tools/serve_with_csp.py --port 64911 --root app    # 后台常驻（带预览面板同款 CSP）
NODE=C:\Users\1\.workbuddy\binaries\node\versions\22.22.2-5\node.exe
%NODE% tools/app_pages_check.mjs --port 64911           # 页面自检：JS 异常 / 404 / CSP / 全局对象
%NODE% tools/compose_lay_check.mjs                      # 组卷台自检（选题 + 排版同一页）
%NODE% tools/print_no_check.mjs                         # 卷面编号规约自检
%NODE% tools/demo_check.mjs                             # 演示模式端到端（自己起一次性 Chrome）
%NODE% tools/reco_audit_check.mjs                       # 识别后自检判据对账（纯 node，不用浏览器）
%NODE% tools/reco_e2e_check.mjs --image "data/benchmark/xxx.jpg" --tag e2e1   # 端到端跑真实识别
%PY% tools/reco_rows_compare.py --rows .workbuddy/tmp/recog_pilot/e2e1.rows.json --paper "xxx.jpg"
# 以上两个要先在 bash 里常驻一个带 --remote-debugging-port 的 headless Chrome（见「自动识别」章节）
```

## 校对页为什么是「单文件自包含」（两个已踩过的坑）

校对页在受限环境里打开（WorkBuddy 预览面板带 CSP、任意 HTTP 静态根、甚至把 .html 单独发给别人），
所以一律不引用外部资源，**不要改回外链或相对路径**：

1. **CDN 会被 CSP 拦掉**：预览面板发的是 `default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:`，
   `cdn.jsdelivr.net` 的 KaTeX 直接 `blocked`（公式全不渲染）。→ 改为把 KaTeX 的
   CSS（20 个 woff2 转 data: URI）+ JS 从 `engine/vendor/katex/` 读入后内联。
2. **相对路径会 404**：页面被挂在 `/static-html/` 下，`../crops/x.jpg` 越界成
   `/static-html/crops/x.jpg` → `404 (Not Found)`（左栏原图、题内插图全裂）。
   → 改为把裁剪图与插图全部内联成 `data:` URI，页面不再有任何图片路径。
   另外页脚 JS 加了图片 error 兜底：真加载失败时会打印「［图片加载失败］+ 文件名」，
   不会再只留一个裂图让人猜。

代价：每个含公式的页面 ≈650KB（KaTeX 包 646KB 内联），56 题的 render 目录约 34MB；
纯文字题不带 KaTeX 包只有 ~160KB。嫌大就用 `--no-katex`（公式按 LaTeX 原文显示）。
判断逻辑：题里只要有 `{"t":"latex"}` 片段才内联 KaTeX。

## 校对页的 UI

`engine/render.py` 一次渲染出下面这些页面，全部单文件自包含、可单独转发。
页头统一一条导航：**卷列表（识别结果）｜ 已生成试卷**。

| 文件 | 内容 |
|---|---|
| `index.html` | **卷卡片页**：顶部日期筛选器（chip，纯前端切显隐）+ 每份卷一张卡片（原图缩略图 / 解析题目数 / 解析日期 / 题型分布） |
| `doc-<日期>-<hash>.html` | **卷详情页**：原图（点一下放大）+ 该卷解析出的题目列表（每条带裁剪缩略图、题号、题型、板块、题干预览、疑点）+「打印本卷」按钮 |
| `q-<id>.html` | **题目详情页**：左右对照（原图裁剪 ｜ 结构化还原） |
| `papers.html` | **已生成试卷列表**：所有排好的卷面（按原卷版面 / 按题型重排），带首页缩略图、页数、PDF 体积、生成时间，以及「打开卷面 / PDF / 本卷解析」三个入口 |

`papers.html` 的数据是**推导出来的，不手工维护**：扫 `data/render/paper-*.html`，
读每页 `<head>` 里的 `<meta name="x-paper">`（`paper.paper_meta` 嵌入：kind/slug/标题/题数/日期），
页数 / PDF / 体积 / 缩略图从 `data/paper/manifest.json` 读（`tools/export_paper_pdf.py` 写——
页数只有打印成 PDF 才知道）。清单缺失只是那几项显示占位，**不影响打开卷面**。
所以顺序是 `paper.py` → `export_paper_pdf.py` → `render.py`，最后跑渲染页数才是新的。

- **分卷依据是 `source.file`**（原图文件名）——同一份卷的所有题只有这个字段相同。
  卷内按 `no`（卷内阅读顺序，每卷从 1 开始）排。
- **日期取自文件名前缀** `YYYY-MM-DD`（`2026-10-01-乘法综合练习.jpg` → `2026-10-01`），
  解析不出来时用题库里最新的 `created_at`，都取不到显示「未知」。
- **卡片倒序**：日期新的在前；同一天按 `created_at`、再按文件名倒序。
- **页面文件名是 ASCII + 稳定哈希**（`doc-20261001-e433.html`）：卷名是中文，
  直接当文件名在 URL / 预览面板下容易出编码问题；哈希只用文件名算，每次渲染结果一致。
- **缩略图先离线生成**：`tools/make_thumbs.py` → `data/thumbs/*.jpg`（宽度 520，每张 ~30KB），
  `render.py` 只内联缩略图（原图 100KB–900KB，直接内联会把首页撑到几 MB）；
  缩略图不存在时回退原图，页面大一些但不裂图。**新卷入库后记得跑一次**。
- 图标文件缺失时页面显示「原图缺失」占位，不会留一个裂图。

验证 UI 改动（筛选 / 跳转这类交互静态截图看不出来）：
```bash
%PY% tools/serve_with_csp.py --port 64907          # 另开终端常驻
%IMGENV% tools/ui_e2e_check.py                     # 截图 + console 违规计数（0 才算过）
```
自检会在 iframe 里真点一遍：筛选 chip 切显隐、恢复「全部」、点卡片进卷详情、点题目进详情、
进试卷列表并核对卡片上的 PDF / 缩略图 / 本卷解析链接**逐个 fetch 可达**、最后从列表点进可打印卷面，
把每一步的结论写在截图顶部黑条上（出错会显式写「错误！」）。

## 成卷（engine/paper.py）

校对页是「一题一页、左右对照」给**人核对**用的；成卷是「按题型重排、A4 分页」给**学生做**用的。
两者共用同一套资源处理（KaTeX 内联、图片 data: URI、符号 SVG），**不要各写一套**。

- **按版面需求分组**，不照搬原卷板块：口算分列、竖式计算 3 列固定书写高度、
  递等式 3 列、写出综合算式 2 列、比较大小 3 列、填空/选择整行、应用题整行留大答题区。
  同一类的题可能来自不同来源卷，组卷时合并重排、全卷重新编号。
- **默认去重**（合卷 `collect(dedup=True)` / 按卷还原 `collect_doc(dedup=True)`，命令行 `--keep-dup` 可关）：
  同一个大题（合卷）或同一个板块（按卷还原）内，按**内容指纹**（`q_fingerprint()` = 题干 + 选项
  去掉所有空白）只印一份，被剔除的打 `[去重]` 日志。
  起因：同一份卷拍成多张有重叠的照片时，重叠区的题会入库两次（「第一二单元素养卷」与
  「乘法综合练习」两张照片在接缝处都把「4. 写出综合算式」拍进去了），卷面里就会印两遍、白占 4 分。
  **只在同板块内去重**——跨板块的相同题更可能是归类问题，该留给人看，不悄悄合并。
  题库始终全量（识别层不去重，见 `prompts/recognition-spec.md`）；**卷详情页**列的是题库，所以那里
  仍是全量 38 题，卷面才去重成 36 题。
- **「写出综合算式」按原件版式还原**（`style="eq"` + `cols=2`）：每格是「(n) + 两条已知算式」
  加**下方一条实线答题横线**，两格并排 = 原件那个 2 行 2 列。**注意口径**：题库里它是**两题**
  （(1) 含两条算式、(2) 含两条算式），不是四题——印刷题号只出现两次，题内两行用换行表示。
  合并成一题会把版式丢掉、拆成四题会把一个小题拆开，两头都踩过，详见
  `prompts/recognition-spec.md` 的切题规则。
- **小题号与列数**：计算类大题（一/二/三/五）`numbered=False` 不标 `(1)(2)` —— 算式本身就是标识；
  列数**不超过 4 列**（小学生要在格子里写答案，6 列太挤）。
- **运算符号统一走 KaTeX**（`render.mathify`，校对页与卷面都生效）：识别结果里算式有两种存法 ——
  纯算式存成 `latex` 片段（`67-5\times5=`），夹在句子里的（`计算 268×3 时`、`40×□-20=100`）
  只能存 `text`。宋体的 `× ÷` 只有汉字高的 ~0.51、KaTeX 的 ~0.71，排在一页上一眼就看出来。
  所以渲染时把 `text` 里的 `× ÷ + - = < >` 逐个包成 `\({}\times{}\)`（两侧空组让它当二元算子，
  左右才会留出与 `268\times4` 一样的间距）。**只包运算符**：数字、方框 `□○△☆`（另有内联 SVG）、
  留空括号（`blanks_of()` 要数字空给分）都不进 KaTeX。
- **题内插图带一句文字说明**（`figure.caption`，可选字段）：印在图下小字里，校对页与卷面都有。
  热敏打印/复印会把图糊掉，有这句话学生照文字也能读懂题意。只描述画面，不写解法与答案。
- **题图位置随题型变**（`item_html` 里的三条分支，别再写死成一种）：
  应用题 → 题干**下方右侧**（右对齐，左半边留给学生写算式；居中会把书写区顶到中间）；
  带图选择题 → 贴**选项右侧**、选项排两列（`SECTIONS.fig_opts_cols`）；填空题 → 独占一行居中。
- **分值自动汇总**，给分有**三种口径**（`item_score`），总分自动算进副标题，改题后不会对不上：
  口算/竖式/选择这类**每题固定分** → `per`；**填空题按每空固定分** → `per_blank`（卷面上填空是
  「一题几个空、一个空多少分」，按题给分是错的——用户口径「一个空多少分，不是一题几分」，
  空数由 `blanks_of()` 从题干里数：`（　　）` 与 `____` 算空，`□`/`○` 不算）；应用题逐题给分 → `scores=[...]`。
- **带 `[?]` 的题自动剔除**（识别没看清，正式卷面不能有问号占位），并在 stderr 打印警告。
- **版面松紧的旋钮**集中在 `engine/paper.py` 顶部：`PAPER`（字号/行距/题距/大题边距/书写区参考线）
  与 `SECTIONS`（每题分值、列数、书写区高度 `box_h`、网格行距 `row_gap`、是否 `new_page` 另起一页）。
  **两条链路的松紧是分开的，别混用**：
  * 按卷还原（`--by-doc`）用 `PAPER` 基准档：行距 1.7、题距 5mm、大题边距 `6mm 0 2mm` ——
    这一链要贴原卷版面，不跟着合卷一起收（收紧后各卷末页空白反而更多）。
  * 按题型重排的合卷（`paper-all`）在基准档上叠一层 `TIGHT`：行距 1.6、题距 3.5mm、
    大题边距 `4mm 0 1.5mm`、网格行距 6mm；`SECTIONS.box_h` 也专为合卷定
    （竖式 28 / 递等式 22 / 综合算式 11 / 应用题 30mm，竖式行距另收成 3mm）。
  * **按卷还原的「紧凑档」是逐卷点名的**（`COMPACT_DOCS = {<slug>, …}` + `COMPACT` 叠层）：
    有的卷刚好溢出一页、末页只放一道题（素养卷合并三张照片后第 4 页留白 218mm），
    把行距/题距/大题边距各收一点点就压回 3 页。**不默认给所有卷开** —— 整体收紧会让
    别的卷末页空白反而更多（b354 第 4 页留白 176mm → 263mm）。
  ⚠️ **「四面 A4」是绑题库的，不是固定值**。给 70 题调的松紧度，在题库涨到 94 题 / 满分 130 时会
  排成 5 页（只差最后一道应用题溢出，第 5 页几乎全空）——`TIGHT` 就是为压回四面加的。
  题库再变（加卷 / 改 `pick`）**必须重新量页数**，别拿老结论当数：

### 三个已踩过的坑

1. **真实分页只有打印才知道**。`@page { size: A4 }` 下的换页由浏览器排版决定，屏幕上 `.sheet`
   只是近似预览。所以「是不是正好四面」「哪页留白过多」必须打印成 PDF 来量
   （`tools/export_paper_pdf.py` 会顺手报出每页底部留白与首行）。
   量留白要**按渲染像素找最后一个非白行**：只看 `get_text("blocks")` 会把「空白书写区 + 一条虚线」
   的页误报成留白过多；只看 `get_drawings()` 又会带上 body 白底整页矩形。
2. **题内插图别留在文字流里**。图如果是 inline，图高会把所在行的行距整个撑开 ——
   q-20261001-005 出现过「（　　）。」被顶到下一行、中间裂开一大片。
   同理**分值标注不要 `float:right`**：浮在右上会在第一行占位、把题干提前折行
   （q-20260930-056 被挤出一个「物？」孤字），改为跟在题干末尾（图已不在流里，安全）。
3. 新增任何输出链路时，记得带上**符号 CSS（`render.SYMBOL_CSS`）**：漏了的话 `<svg>` 没有尺寸约束，
   会按默认 300×150px 撑开，含 `□ △ ☆` 的题每题占一整页。
4. **末项外边距**：`.block > :last-child { margin-bottom: 0 }` —— 每个大题最后少留一格题距，
   7 个大题能省出 35mm，正好是把最后一行挤到下一页的那点量。

### 版面余量（调参前先看这个）

`四面 A4` 的容量是 4×(297−14−10)mm = 4×273mm = **1092mm**。合卷现在 92 题 / 满分 126，
用 `TIGHT` 档实测 **4 页**、每页底部留白 12 / 31 / 49 / 36mm。要量自然总高（不受分页影响）：

```
chrome --headless=new --hide-scrollbars --window-size=794,6000 \
  --screenshot=full.png "file:///<paper.html 绝对路径>"
# 794px = 210mm（3.781px/mm），找最后一个非白行即可
```

需要腾空间时按「先隐性、后显性」的顺序动：行距/题距/大题边距 → 插图上限 → 书写区高度。

## 按原卷版面逐卷打印（engine/paper.py --by-doc）

上面那套是「把全库题目**合并重排**成一张练习卷」；这一套是「**照某一份卷的原版面**重新排一版
干净的卷面」——老师要重新打印给学生做（原卷已经写满了/丢了）。入口在卷详情页的
**「打印本卷（按原卷版面 · 重新打印给学生做）」**按钮。

```bash
%PY% engine/paper.py --by-doc                 # 每卷一个 paper-<slug>.html -> data/render/
%IMGENV% tools/export_paper_pdf.py --docs     # 批量 PDF + 首页缩略图 + 页数清单
%PY% engine/render.py data/questions          # 刷新 UI（含 papers.html 试卷列表）
```

三条还原原则（都在 `engine/paper.py` 的「按卷还原」段）：

1. **板块顺序 = 原卷阅读顺序**，板块标题用原卷的（「2. 用竖式计算」），不重排、不合并。
2. **列数由原卷坐标实测**（`infer_cols`）：把所有题的 `bbox` 左边界排序后按 40px 聚类，
   聚成几簇原卷就是几列 —— 同一种题型在不同卷上列数不同（口算这份 3 列、那份 4 列，
   竖式有 3 列也有一排 4 个的），硬编码一定会错。
   比「先按 y 分行再数」稳：手写卷的裁剪框会把学生的竖式/答题笔迹包进去，y 方向被撑开、
   相邻两排会合并，x 方向不受影响。
3. **小题号用原卷印刷题号** `source.printed_no`（`（1）`/`1.`）；原卷没印号的（口算、竖式、
   递等式…）就不编号 —— 和原件一致，也不再重复「小题号进不进题干」那套纠结。
4. **同一板块内按内容指纹去重**（`collect_doc(dedup=True)`）：一份卷拍成多张有重叠的照片时，
   接缝处的题会被拍两遍（素养卷的「4. 写出综合算式」），卷面只印一份。被剔的题打 `[去重]` 日志；
   `--keep-dup` 可关。题库仍旧全量，卷详情页也照旧列全（去重只影响卷面）。
5. **末页几乎全空时用「紧凑档」**：在 `paper.py` 顶部 `COMPACT_DOCS` 里点名该卷的 slug，
   它就走 `COMPACT` 叠层。加完必须重跑 `export_paper_pdf.py --docs` 量页数，确认真的少一页。

另外两点：

- **分值默认不标**：schema v2 不收分值，原卷多少分我们并不知道，编一个不如不编。
  要标就加 `--scores`，走 `SCORE_PRESET` 的**估计**口径（填空按每空 1 分），stderr 会明确警告是估的。
- **打印层的标点规范化**（`fix_punct`，开关是 `PAPER` 上面的 `PUNCT_FIX`）：识别是照原卷抄的
  （原卷就半角全角混着），印给学生前统一 —— 只在「中文旁边」动手（`79×6,第一个` → `79×6，第一个`），
  算式里的 `.` `,` 一律不碰；留空括号统一成 `（　　）`。**只作用于打印层，不动 JSON**，
  校对页仍显示识别原文。
- 产物：`data/render/paper-<slug>.html` + 同名 `.pdf` + `thumb-<slug>.png`（每份 1–2 页 A4）。
  **必须落在 `data/render/`**（与卷详情页同目录）：详情页那个按钮、试卷列表里的 PDF 与缩略图
  都是同级相对链接，跨目录的 `../` 在预览面板下会 404。每页 PNG 与清单在 `data/paper/`（不进 UI）。


## 裁剪定位（重要经验）

凭肉眼估百分比会整体偏移（首次实测偏移一整行），必须走数据驱动流程，核心是
**「先划窗口再拟合」**：逐列做行投影得到真实行带（扫描件有倾斜，同一行不同列纵向可差
40+px，全页统一行带必然切字）→ 用窗口排除板块标题、行首印刷题号、相邻列 → 在窗口内
自动拟合内容包围盒。**笔迹密的手写卷**（红笔批改 + 铅笔作答）要先用「印刷黑」掩膜做颜色分离
（`lum<118 且彩度<42`）再定位，并且**只按印刷内容定界**、再拿这个范围裁彩色原图——手写卷上笔迹
常远超题区，按「包住笔迹」拟合会把整块作答区连同邻题作答一起框进来（第 7 份卷实测某题从 90px
撑到 390px）。判据是**笔迹不被切掉**，不是所有笔迹都在框内。裁剪后**必须跑 `engine/crop_check.py` 自检**
（这一道工序曾经缺失，导致 q-20260930-050 的印刷序号残留流到了用户面前）。
另外：**卷面题号一律不进题干**，但续行顶格时**必须留在裁剪图里**（按「题号末+1」裁会切掉续行首字）。
详见 `prompts/recognition-spec.md`。

## 自动识别（上传即识别 · 云服务免密钥大模型）

**问题**：网页端上传完照片不立即识别 —— 识别原本是**在对话里由 agent 看图**做的（额度花在对话 token 上）。
云服务自带**免密钥**大模型通道（不用申请任何 key），这一步已经搬进应用：**上传完成即自动识别、自动入库**。

### 效果（`deepseek-v4.1-flash`，多页多次实测）

| 维度 | 结果 |
|---|---|
| 题干 / 选项转写 | ✅ **字符级一致**（相似度 0.955~1.000） |
| 切题数量、印刷题号、题型、板块 | ✅ **全对**（24/24、另一次 4/4） |
| 速度 / 成本 | **5~10 秒 / 页**、**0.11~0.21 credits / 页**（全库 11 页 ≈ 2 分） |
| 题内插图坐标 | ⚠️ 打印清晰的卷上准（偏差 ±18px），手写密集 / 广告图那种能偏 150px+；已加**图形块吸附**，9 张真值平均 IoU 0.564 → **0.817**（见「插图框另走一套」） |
| **题区坐标** | ⚠️ **不精确、且每次不同**（见下） |

### 坐标：为什么最后是「宽松框 + 标注」，而不是「精修」

模型对**绝对位置**的感知很弱。给它看了带刻度的图之后，输出的坐标仍然是"按版式铺开"的
（同一列 y 整齐取 60 的倍数、三列 x 固定在 175/520/890），而不是照着刻度读。三种修法都实测排除了：

| 修法 | 为什么不成立 |
|---|---|
| 本地行/列投影（**全页统一行带**） | 直接连成一整块（实测 706px 高）。2026-10-05 复查找出真因：**卷面印的田字格竖线是印刷黑**，色差阈值从 42 收到 8 仍剩 457~706px；再叠加拍照时的手指 / 桌面 / 阴影。⚠️ 这条只否掉了「全页统一行带 + 不剔除干扰」的**朴素做法**（而项目规范本来就禁止全页统一行带）；**逐列行投影 + 干扰剔除**还没在浏览器里试过 |
| 从模型框中心向外"吸附"到真实内容 | 模型框中心本身就偏到相邻行了（行高 40、行距 62，偏 46px 就跨行），必然吸错行（`tools/coord_refine_proto.py`） |
| 外扩到"必不漏" | 密集页要 ±250px 才够，那时框已宽到页面的 47% |

但按页面类型分开看，结论是**可用但不精确**（下面是落库框与人工标注的对账，新外扩参数）：

| 页面类型 | 覆盖率 | 说明 |
|---|---|---|
| 密集计算页（一页 24 个口算/竖式 —— 最坏情况） | 平均 **0.747**，16/24 完全覆盖 | 好在题目文字本身很短（「4×40=」），看列表文字就够 |
| 应用题 / 选择页（一页 4~8 题 —— 缩略图真正有用的场景） | 两次实测 **1.000** / **0.604** | 差的那次不是框小了，是模型把 y 整体放低了 100px（见下） |

**⚠️ 同一张图、同一段提示词，两次调用给的坐标不一样。** 实测同一页 4 道题，x 只差 ±5px，
y 却差 10~100px（题越高差越多）。所以题区坐标**本身带随机性**，这不是外扩参数能修掉的 ——
**调外扩参数的收益已经到顶，别再去试**。密度高的页面上半部分还可能整体漂 200~260px（密集页那 6 道）。

所以采取：**按框高 35% 外扩（下限 40、上限 110）+ 界面明确标注「自动定位」**，宁可多带上下文也不切内容。
缩略图偏了靠「点进去看整页原图」兜住（单题页可以点开整页原图，卷详情页也能点开原图放大）。
**要精确坐标仍走电脑端已有的 Python 管线**（本仓 `data/questions/*.json` 里的坐标就是那条管线产出的，
与云端互不影响）。

> ⚠️ 上面这段说的是**兜底**策略。线上跑的是 `app/js/refine.js`（v5.3「结构判据 + 单调对齐」）：
> 只要吸附成功就用吸附框，失败才退回这里的外扩。实测 5 卷 10 次识别，覆盖率 8/10 优于外扩。
> 算法细节 / 参数 / 为什么三种朴素修法都不成立，全在 `app/js/refine.js` 的文件头注释里。

### 插图框另走一套「图形块吸附」（2026-10-11 加）

插图（`stem` 里 `t:"figure"` 的片段）错法**不是**"顺序对应"而是"边界"，所以**不能复用**题区那套：

- 题区那套的 `hmin/hmax`(16~95) 是**文字行**的高度上限，插图块高 150~300，第一关就被整个滤掉；
- 实测的错法有三种：**框偏**（paper6 的 q35 整段落在广告下方 150px 的空白里）、
  **框太小**（q29/q37 只罩住图形块的一部分）、**框伸进旁边内容**（q30 混进题面印刷字、q32 混进学生「406」）。
  等量外扩只会把三种错误一起放大。

做法（`app/js/refine.js :: Refine.snapFigures`，与题区那套并列，判据完全不同）：
ROI 内**行/列投影分段**（允许块内部 ≤gap 的白）→ 选**与模型框区间重叠最大**的那段
（⚠️ 不能只看"模型框中心落在哪一段"：q35 的中心整个落在空白里）→ 行列交替收敛 →
每条边**限制外移幅度**（不加就顺着相邻文字行连成一片）→ 外缘补一点余量。

**逐张独立兜底**：任何一步失败 / 面积超模型框 2.4 倍 / 比模型框还小一半 → 这一张不进结果，
调用方（`recognize.js :: toRow`）退回老的「外扩 25%（30~80px）」，所以**不可能比改动前差**。

| 样本（9 张人工逐像素核过的插图框） | 现状（外扩 25%） | 吸附后 |
|---|---|---|
| 平均 IoU | 0.564 | **0.817** |
| 最差一例 | 0.198（q35，广告切掉上半） | 0.601 |
| 低于 0.5 的 | 5 张 | **0 张** |
| 比现状差的 | — | **0 张**（q30 / q37 走兜底，保持原样） |

典型：q35 0.198→0.792 · q32 0.587→0.852 · q39甲 0.400→0.742 · 泳道图 0.487→0.947 · 电梯标牌 0.499→0.976。

对账与调参（Python 孪生与 JS 必须同步，`FIG_DEFAULTS` 一字不差）：

```bash
P=C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe
$P tools/figsnap_eval.py --json .workbuddy/tmp/figsnap_eval.json   # Python 侧：逐样本 IoU
node tools/figsnap_js_check.mjs --cdp-port 9346                    # JS 侧：跑同一批并逐张比 Python
node tools/reco_wiring_check.mjs --raw <raw.json> --image <原图>     # 接线：f._sb → toRow 的 stem.bbox
```

样本 = `data/benchmark/2026-10-11-试卷1011-p{1..4}.jpg`（paper6「1011」的 4 张原图）的 7 张插图
+ `2026-09-30-选择与应用题.jpg` 的 2 张（后两张的模型框直接取自 `recog_pilot` 的识别原始输出）。
「模型原始框」怎么来的：插图的落库框 = 模型框 + 等量外扩（外扩量只由框尺寸决定），**可以反推**。

### 识别后自检 + 「重新识别」的保护（2026-10-11 加）

坐标能靠算法修，**文字不能** —— 模型对同一张照片两次识别，错的题并不重合（实测：paper6 第 1 页
线上错 7 道口算，离线同图复现 20 题全对，再跑一次又错在别处）。所以这里不掉换模型，
只做两件**降低损失**的事：

**① 识别后自检**（`app/js/recognize.js :: auditOne / auditPaper`）：把机器能判出来的硬伤挑出来，
页面只让人复核这几处 —— 卷详情页顶部汇总条 + 可疑题左侧红条 + 「只看可疑 N 题」筛选按钮，
单题页在 `marks` 区列出理由。

| 判据 | 说明 |
|---|---|
| `[?]` | 模型自己标了"看不清" |
| 算式形式可疑 | 运算符连用（`12-+`）、尾随运算符（`4×8-`）、以乘除开头、括号不配对 |
| 题号不连续 | `qno` 不是严格 +1（跳号 = 漏题或串题，paper6 重扫就是这么错的） |
| 题干重复 | 两题题干一字不差（模型复制粘贴） |
| 空题干 · 选择题选项 < 2 · 置信度 < 0.7 | |

```bash
node tools/reco_audit_check.mjs    # 24 项判据样板（该抓的/不该动的）+ 真实题库误报率
```

⚠️ 设计原则是**只减不增**：判据宁可漏报不可误报（误报多了人会习惯性忽略红色，真错反而被淹掉）。
**「漏字、认错数字、认错人名」这类形式完全合法的错，机器判不出来**，别指望它兜底。
实测误报率 3%（4/135，逐条核过全是真问题）。

**② 「重新识别」先备份、再重扫**（表 `question_backups`，云端，每卷留 5 份）：
重扫是"重掷骰子"，会把现在对的题也换掉、还会改变片段切分，所以点确定后先把整卷存一份，
页面顶部出现「识别备份」条 +「恢复到这次备份」按钮。

- 强二次确认（danger 按钮 + 逐条列出后果），文案明说"不是修正，对的题也可能被换错"；
- 恢复是**按 `seq` 原地 UPDATE**，不删重建 —— `questions.id` 是 `GENERATED ALWAYS`
  （不接受显式插 id），重建就换 id，自建卷的 `question_ids` 引用与 `question.html?id=…` 的链接
  会全断；只有题数变了才会走到补 / 删那两条；
- 备份失败**不阻断**重扫，但会明确提示"这次没法一键回滚"，让用户自己决定还做不做。

> 结论：**已有卷不要用「重新识别」更新坐标**（它只适合"重做文字"）。坐标更新走离线重算 +
> 按 `seq` 写回，不花额度也不动文字。

### 链路怎么搭的

```
上传照片 → 建卷 → 逐张上传
  → canvas 给每页画「参考网格 + 边缘刻度」(app/js/recognize.js :: buildRulerCanvas)
  → 在**应用自己的页面**上调 cloud.llm（免密钥通道按精确 Origin 校验，别处调不通）
  → 模型输出 JSON → 归一化（板块去句号 / 选项去 "A." 前缀 / 坐标外扩）→ 写 questions 表
```

**提示词只有一份正本**：`prompts/auto-recognize-prompt.md`，由 `tools/build_prompt.py`
编译成 `app/js/recognize-prompt.js` 供前端引用（网页读不到项目里的 .md，也不该有第二份）。
**改了 .md 必须重跑编译**，否则线上跑的还是旧提示词 —— 编译产物带头注释里记着源文件 sha1。

刻度图的用意：刻度是**语义** —— 不管平台把图缩放成多少，"数字"不会因 resize 而变。
数字标的就是**原图坐标**（网格也按原图坐标的 100 倍数画），所以模型照读出来的坐标**不需要任何换算**。
实测它把误差从 230~390px 压到 30~60px。`tools/make_ruler_image.py` 是等价的 Python 版，可离线看效果。

### 验证 / 对账

```bash
# 1) 常驻 Chrome（从 Node 里 spawn 起不来，得单独起）
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --remote-debugging-port=9346 --user-data-dir="$PWD/.workbuddy/tmp/cdp/prof" --disable-gpu about:blank &
# 2) 页面级自检：JS 异常 / 静态资源 404 / CSP 违规 / 识别所需的全局对象在不在
python tools/serve_with_csp.py --port 64911 --root app &   # 后台常驻
node tools/app_pages_check.mjs --port 64911
# 3) 端到端跑一遍**真实链路**（把前端那两个 js 注入线上页面，canvas→模型→归一化 一步不落）
node tools/reco_e2e_check.mjs --image "data/benchmark/2026-10-01-第2单元练习卷-p1.jpg" --tag e2e1
# 4) 与人工标注对账（看覆盖率/精度/IoU —— 框是刻意放大的，只看 IoU 会误判）
python tools/reco_rows_compare.py --rows .workbuddy/tmp/recog_pilot/e2e1.rows.json \
       --paper "2026-10-01-第2单元练习卷-p1.jpg"
# 5) 改了 buildRulerCanvas 一定要把刻度图导出来亲眼看过
node tools/dump_ruler_canvas.mjs --image "data/benchmark/2026-10-01-第2单元练习卷-p1.jpg"
```

只验**模型能力**（不出网写库）时仍用 `tools/recog_pilot.mjs` + `tools/recog_compare.py`：

```bash
node tools/recog_pilot.mjs --image "data/benchmark/2026-09-30-选择与应用题.jpg" \
     --model deepseek-v4.1-flash --tag pilot1 --cdp-port 9346     # --send 可指定实发图（如带刻度的）
python tools/recog_compare.py --paper "2026-09-30-选择与应用题.jpg" \
       --pred .workbuddy/tmp/recog_pilot/pilot1.parsed.json
```

产物都在 `.workbuddy/tmp/recog_pilot/`。

**验证的覆盖边界**（别把上面对账当成「落库也验过了」）：

| 环节 | 谁验的 |
|---|---|
| canvas 刻度图 → 模型输出 → 归一化/外扩 | ✅ 上面 3)4) 步，在**线上页面**里跑（Origin 真实） |
| 页面加载 / 静态资源 / CSP | ✅ `tools/app_pages_check.mjs`（4/4 通过） |
| **建卷 → 上传云存储 → addQuestions → 状态流转** | ⚠️ **没被端到端执行过** —— `reco_e2e_check.mjs` 只调 `recognizePage`，**不写库** |
| 表结构 / 字段 / RLS 权限 | ✅ 已用云端 `describe_table` + `list_rls` 逐字段核对（见下） |

写库那段没做成自动验证，是因为 RLS 要求 `owner_id = auth.uid()` ——
**必须有你本人账号的登录态**才能写，脚本代不了。上线后**第一次真实上传就是它的首次实测**。

数据库侧已于 2026-10-05 核对：

- `papers`：`status` 是无约束 text（默认 `pending`）→ 写 `processing`/`done`/`failed` 都合法；
  `status_note`/`page_count`/`question_count` 都在。
- `questions`：`seq/qno/printed_no/section/qtype/stem/options/source/confidence` 全在，
  其中 `stem/options/source/confidence` 是 jsonb（写数组/对象）。
- `paper_files`：`page_no/filename/storage_path/width/height/size_bytes` 全在。
- 三张表都是 `ALL` 策略 + `owner_id = auth.uid()`（读/写/改/删都允许，且只能动自己的数据）
  → 「重新识别」里 `deleteQuestions` 按 `paper_id` 删是安全的。
  ⚠️ 2026-10-06 ~ 2026-10-26 之间策略里还带过 `AND app_can_use()`（开通制），**已整体移除**，
  见「登录与权限」小节。

## 网页应用（`app/` · 多人在线题库）

本地这套引擎是「校对 + 成卷」的生产线；`app/` 是把它搬到线上给人用的那层：
**多用户各自独立题库，可以上传自己的试卷照片**。

- 线上地址：<https://shijuan-question-bank.app.workbuddy.host/>
- 应用身份：`applicationId = wbapp_xotiBVMY1FXqdzhi2ZChQ7`，域名前缀 `shijuan-question-bank`。
  ⚠️ **改代码后重新发布必须用同一个 applicationId** —— 换域会让云登录的 Origin 精确校验失败。
- 登录是**应用自己的账号体系**（手机验证码 + 微信扫码）。WorkBuddy 的登录态只作用于客户端，
  和发布出去的那个网页没关系，用户不能拿自己的 WorkBuddy 账号登录它。
- ⚠️ **微信登录只能在电脑上用（扫码）**。这条链路走的是微信「网站应用」的 `snsapi_login`，
  必然渲染一张二维码 —— 手机上（含微信内置浏览器）没第二个屏幕可扫，**不是 bug**（实测手机 UA
  与微信内置 UA 结果一致，应用页自身零报错）。**手机端请用手机号验证码登录**，登录卡里已写明。
  想要手机上真正的一键微信登录，只能把应用改做成**微信小程序**（`wx.login` + `signInWithWechat`）
  —— 2026-10-05 做过一份又按要求删掉了；真要重做，`MEMORY.md` 里留着全部结论，不必重新调研。
- 计费：官方定价里**没有"云服务"这一项**（只有权益「可托管应用数」）；云数据库 / 存储 / 认证
  **不计入积分** → 那部分不额外付费。但**上传即识别会调用免密钥大模型**，按 token 计入积分
  （实测 `deepseek-v4.1-flash` 约 **0.11~0.21 分/页**），不需要申请任何 API key。
- ⚠️ **免密钥大模型扣的是「应用创建者」（应用所有者）的积分，不是登录用户的**。
  终端用户（手机号 / 微信登录进来的那些人）用的是**应用自己的账号体系**，和 WorkBuddy 计费无关，
  他们可能根本没有 WorkBuddy 账号。依据：cloud-service 的 LLM 文档把额度错误码
  `quota_` 定义为 "Creator quota exhausted or rate-limited"（额度挂在 Creator 身上），
  且额度/计费没有 SDK 接口、只能去 WorkBuddy 控制台看创建者自己的用量。
  **所以「谁能用」＝「谁在花你的积分」**。2026-10-26 起生产做了两道收紧：
  **只允许微信扫码登录**（手机号/短信关掉）+ **每个账号 2 次免费识别**（删卷也不返还）。
  按 2 次估算，单个新用户最多花你 2~4 分（一页 0.11~0.21 分，一次识别通常 1~3 张照片）。

| 文件 | 作用 |
|---|---|
| `app/index.html` | 登录卡 + 「我的试卷」卡片列表（按状态筛、可载入内置示例卷） |
| `app/upload.html` | 选多张照片 → 建卷 → 上传 → **自动识别**（选择顺序 = 页序） |
| `app/paper.html` | 卷详情：原图（点开大图）+ 识别后自检汇总条 + 逐题列表 + **重新识别**（自动备份 → 清旧结果 → 重跑）+ 备份恢复条 |
| `app/question.html` | 单题左右对照（左：按坐标从原图抠出的那一块，可点开整页原图；右：结构化还原）+ **编辑题目**（手动修正识别错误，见下） |
| `app/print.html` | A4 卷面还原 + 浏览器打印 / 存 PDF（`?id=` 照片卷按原卷版面；`?custom=` 组卷卷面，另带一个「排版」编辑入口，校对时顺手改） |
| `app/compose.html` | **组卷台：选题 + 排版同一页** —— 左栏题库挑题、右栏就是卷面（编辑画布常开），保存一次写好题目/顺序/排版/编号 |
| `app/customs.html` | **我的组卷**：组卷独立列表（编辑试卷 / 删除），与照片卷分开 |
| `app/js/config.js` | 云服务 publicConfig（endpoint / oauthRelayBaseUrl / publishableKey） |
| `app/js/cloud.js` | 唯一的 SDK 初始化点 + 数据层（试卷/原图/题目/签名地址；本机 hostname 下会早退，见「演示模式」） |
| `app/js/sheet.js` | **卷面渲染引擎**（`print.html` / `compose.html` 共用）：题号方案、按题型分板块、照片卷原卷版面还原、选项分栏、书写区留白 |
| `app/js/qtype.js` | **题型分桶规则**（全站唯一口径）：板块名关键词（`SEC_RULES`）优先、模型 `qtype` 兜底；首页卡片分布条也用它，保证与卷面板块同口径 |
| `app/js/sheet-edit.js` | **卷面就地排版控制器**（两个页面共用）：拖拽、就地改标题/列数、编号面板、`snapshot()` 出排版数据 |
| `app/js/local-demo.js` | **本机专用**演示数据层（内存版 `CloudAPI`），线上按 hostname 判定永不激活 |
| `app/js/render.js` | **`engine/render.py` 的前端版**：符号内联 SVG、运算符 KaTeX、换行、`[?]` |
| `app/js/ui.js` | 顶栏、登录守卫、原图签名缓存、灯箱 |
| `app/js/recognize.js` | 上传即识别：canvas 画参考刻度图 → 调免密钥大模型 → 归一化落库 |
| `app/js/recognize-prompt.js` | 提示词产物（`tools/build_prompt.py` 编译，**别手改**） |

**两条硬约束（决定了这个应用的形状，改之前先读）：**

1. **云存储只有只读列举接口**，没有模型可调的下载/上传端点 —— 智能体既拿不到用户上传的照片，
   也不能往云存储写裁剪图。所以：
   - **裁剪图一律不落盘**：网页按 `source.bbox` 用纯 CSS 从原图实时抠（`Render.cropBox`：
     容器 `aspect-ratio` + 图片 `width:(W/bbox宽)%` + `transform:translate(-x1/W%, -y1/H%)`，分辨率无关）。
     **因此 `paper_files` 必须存原图的像素宽高**，否则抠图退化。
   - 识别**已经搬进应用**（见「自动识别」章节）：上传完成即自动跑，识别的输入就是用户当场选的
     那些 `File`（浏览器本地读原始像素，不经过云存储）。重新识别需要重选照片，原因同上。
2. KaTeX 的 20 个 woff2 内联进 `app/css/katex.css`（`tools/build_webapp_assets.py` 生成），
   云 SDK 用 IIFE 版**落地到 `app/js/vendor/`**——都不走 CDN：预览面板的 CSP 会拦外链。

**云数据库**（5 张业务表 + 1 张计数表，都带 RLS）：
`papers`（一份卷）/ `paper_files`（一份卷的每张原图 + 像素尺寸）/ `questions`（识别出的题目）/
`question_backups`（重新识别前的自动备份）/ `custom_papers`（**组卷**：`question_ids` 有序题目引用 +
`layout` 手动排版，见下节）/ `recognition_usage`（**识别次数**，只读策略，见「登录与权限」）。
建表和 GRANT 是**两道独立的门**，漏了 GRANT 会得到形似策略失效的 `42501`。

### 组卷台：选题与排版同一页（2026-10-06 加，同日合并）

自动识别是「照片 → 题库」，组卷是反方向：**从已识别的题目里挑题，组成一份新卷**。

`app/compose.html` 一页干完两件事 —— **左栏题库、右栏就是卷面**：

- 左栏：题库列表（按来源卷 / 题型筛选 + 关键词搜题干），「**加入**」按钮点一下题就落到右下角卷面上，
  再点一下移出（按钮变成「已加入」）；
- 右栏：**卷面本身就是编辑画布**（编辑件常开，不需要先点「排版」进模式）；
  挑中的题按题型自动分板块落下，之后就在卷面上拖（详见下一节）；
- 保存：**一次写全**（卷名 + `question_ids` + `layout`），第一次保存后 `history.replaceState` 把
  URL 换成 `compose.html?id=N`，**留在本页继续编辑**（不再跳走）。
  保存入口 = 排版工具条的「**保存试卷**」（`lay-save`）。2026-10-07 把页头的「打印 / PDF」
  「保存试卷」两个按钮撤了 —— 工具条里已有同名功能，一页两套保存按钮容易点混
  （原「打印 / PDF」= 保存后开 `print.html?custom=N`，现在出卷走列表卡片打印 icon / 打印预览）。
- 组卷列表在 `app/customs.html`，**不混进「我的试卷」**（那个页面只放上传的照片卷）。
  卡片底部只有两个按钮：**编辑试卷**（`btn sm`，主色）/ **删除**（`btn danger sm end`，靠右站）。
  2026-10-07 去掉「打开卷面」—— 要看卷面走卡片右上角打印 icon 或组卷台的「打印预览」，
  列表上留这一条反而是杂音；
  两个按钮都降成 `sm`（34px 高，原 44px），删除靠右隔开一段防误点。
  同日又加了**右上角打印 icon**（`.cprint`，打印机 SVG 幽灵小方钮）：点它进
  `print.html?custom=N` 看卷面成品 / 打印 —— 纯链接跳转，不经过任何确认；
  hover 才上色（`--accent` + `--accent-soft`）。自检 compose_lay_check ⑬。

`question_ids` 存的是**有序的题目 id 引用**（不复制题目），所以原卷重识别后自建卷会跟着更新。
有手动排版时，`question_ids` 按**卷面顺序**（`layout.sections` 摊平）写，这样万一清掉 layout 回到
智能排版，题目先后也还是用户看到的那个顺序。

自建卷**不过滤** `[?]` 与「草稿」板块 —— 题是用户亲手挑的，尊重其选择。
照片卷那条路（`?id=`）完全不变，仍按原卷版面逐板块还原。

### 卷面就地排版：卷面本身就是编辑画布（2026-10-06 加）

**同一套编辑器两个入口**：组卷台（常开）与 `print.html?custom=<id>` 右上角的「**排版**」按钮
（校对卷面时顺手微调）。两者共用 `app/js/sheet-edit.js`，行为完全一致。
进入编辑态后：

- **拖动题目卡片**换位置 —— 同一板块内调先后，拖到别的板块就换过去；拖动时源卡片变半透明，
  目标位置出现插入竖线，落点是按矩形几何算的（卷面是多列 grid，不能只数 DOM 顺序）；
- **拖拽板块标题**换板块顺序（≡ 把手），也可以 ↑↓ 按钮、× 删除（删板块时里面的题并入相邻板块，
  **题不会凭空消失**）；板块名点开即改 —— 输入框里只填**名字**（「选择题」），
  **序号是按板块位置现算的只读标签**（默认「一、二、…」，样式可在「编号」里换成 `1.`／`（一）`…），
  交换板块后自己就变了，不用手写也不会写错
  （此刻卷面上显示的那一行**就是输入框本身**，所以改名只更数据、**不重画卷面** —— 重画会丢焦点）；
- 板块右侧 **1/2/3/4** 切列数（默认：计算题 3 列，其余 1 列），旁边的 **#** 切
  「这一块要不要小题号」（亮着 = 印，默认计算题不印）；
- 工具条上的「**编号**」：大题 / 小题的序号**要不要显示、长什么样** ——
  数字形式（中文数字 `一`／阿拉伯数字 `1`／大写字母 `A`／小写字母 `a`）× 包裹样式
  （无／`、`／`.`／`．`／`（）`／`()`／`【】`／`[]`），右边有实时预览串，改完立刻印在卷面上；
- 每题悬停浮出 `↑↓←→` 就地按钮（按边界自动禁用），组卷台里还多一个 `×`（**把这题移出这份卷子**）；
  **手机上没有 hover，按钮常显**，弥补触摸设备对 HTML5 拖拽支持差的问题；
- 工具条是 sticky（顶栏 54px 之下）：**编号 / 恢复智能排版 / 保存**（组卷台叫「保存试卷」，
  与右上角那颗是同一个动作），改过没存会亮「未保存」，关页面时浏览器会拦一下；
- 打印 / 存 PDF 会**先自动退出编辑态**（排版数据仍在，卷面不变），加上所有编辑件都带
  `.no-print`，两层保证打印出来只有干净卷面。

**等比缩放显示**：组卷台右栏的卷面是真实 A4 宽（210mm≈794px），窄屏放不下时按宽度等比
`transform: scale()` 缩小显示（`fitSheet()`），容器高度跟着重算（`ResizeObserver` 盯图片后加载）。
**只缩显示**，数据与打印一概不受影响；拖拽落点也照常准 —— `getBoundingClientRect` 与 `clientX/Y`
都是缩放后的视觉坐标，两边口径一致。

**壳放宽一档（2026-10-07 用户要求「编辑试卷的界面宽一些」）**：组卷台的 `.wrap` 加 `wide`
类（`max-width: 1500px`，其余页面仍是 1120）。1280 屏上 360 + 16 + 794 正好铺满，
卷面不再被 `fitSheet()` 缩到 ~91%；更宽的屏也不散。

**题库按页渲染（题太多怎么办）**：左栏池子**一次只画 80 条**（`POOL_PAGE`，`#plist` 容器），
列表尾部挂一条「已显示 80 / N 题 · 点这里或继续下滑加载更多」（`.pool-more`）——
滚到底（差 200px）自动续、点那条也续；池子没滚动条时 `autoFill()` 主动补到能滚。
**点「加入 / 已加入」只重建那一行**（`refreshItemRow`），不整张列表重画 —— 实测 1080 题时
全量重画要 147ms + 3.6 万 DOM 节点，改后每次点「加入」≈ 3~13ms。搜索框加了 150ms 防抖。
⚠️ 自检脚本找特定题目要**先过搜索框**（题可能在未渲染的页里）；
筛后条数断言写 `Math.min(全量, 80)`。回归项：`compose_lay_check.mjs` 的 ⑩ 六条。

⚠️ **左栏题库池子必须 `contain: paint`**（2026-10-07 用户报「编辑试卷下面的留白太多」）：
`.bank` 是 `position: sticky`，而池子（`overflow: auto`，135 题 ≈ 11585px）的内容会被 Chrome
**算进祖先的滚动区** —— 实测 `.bank scrollHeight = 11192`、`body.scrollHeight = 11414`，
可卷面只占到 3407，于是整页能往下滚 8000px 的**纯空白**（滚到最后只看得到「第 3/3 页」下面一片白）。
给 `.pool, .picked` 加 `contain: paint` 后 `body` 高度回到 3467（= 自身高度），最大滚动从 ~10594 降到 2647。
**别改成 `.bank { overflow: hidden }`**（也能修，但会把卡片里 `UI.select` 的弹出层一起裁掉）。
回归项：`compose_lay_check.mjs` 的 ⑨ 两条。

`layout = {sections:[{title, type, cols, smallNo, ids:[题目id]}], numbering:{big, small}}`
—— 板块顺序 = 卷面顺序，板块内 ids 顺序 = 题目先后。
`title` 只存**纯名**（「选择题」），`type` 是题型键（决定列数与要不要印小题号），
`smallNo` 只在手动点过板块行上的 `#` 时才写（没写 = 跟题型默认走）。
渲染时（`buildFromManual`）会过滤掉已不在题库里的 id，并把**不在任何板块里的题**（刚在左栏加的）
按题型塞回同名板块、没有同名板块就新开一个 —— 所以「挑题」与「排版」两条路不会互相打架：
加题不用重排，被移出的题也不会在板块里留空 id。
**编辑态保留空板块**（先建好、还没往里拖题的那种），打印态才过滤掉 —— 两边索引口径必须一致，
否则「卷面上第几道题」和 `layout.ids` 就对不上了，拖动会挪错题。

**卷面编号规约**（2026-10-06 定，只作用于自建卷；照片卷仍还原原卷）：

| 规则 | 怎么做 |
|---|---|
| 大题序号 | **不落数据**，渲染时按板块位置现算（`Sheet.noText(si, no.big)`）—— 交换板块后序号自动跟着换 |
| 板块标题 | 数据里只存纯名，读取时 `stripSecNo()` 剥掉旧数据里手写的「一、」（兼容老 layout） |
| 小题号 | `_no` 在**每个板块内从 1 起**（不跨板块连续编，避免「一、」下面从 7. 开始） |
| 计算题 | `isCalcSec()` 判为计算题时默认**整块不印小题号**（计算题直接写答案），可在板块行用 `#` 覆盖 |
| 列数 | 计算题 / 比大小 3 列，其余 1 列（`colsForSection`，题数不足就按题数收窄） |
| 题距 | 行间距 6mm、列间距 4mm（`.grid-sec { gap }`；2026-10-06 从 3mm 加大，题与题分得开） |
| 插图 | 宽度默认 68mm（带图选择题右栏 62mm），**排版态可拖图边的手柄改**，存 `layout.figs`（见下） |
| 图下说明 | 识别时给插图补的那行小字（`figure.caption`），**排版态可逐张移掉**，存 `layout.caps`（见下） |

**序号的「显示 / 样式」可配置**（2026-10-06 加，工具条上的「编号」）：

- 大题、小题各一套：**显示开关** + **数字形式**（中文数字／阿拉伯数字／大写字母／小写字母）
  + **包裹样式**（无／`、`／`.`／`．`／`（）`／`()`／`【】`／`[]`），右侧有实时预览串（`一、 二、 三、 …`）；
- 大题标题拼接时只有「裸序号」或「半角点」才补空格（`1. 选择题`），顿号／括号／全角点是中文习惯贴着写
  （`一、选择题`、`（一）选择题`）；
- **小题号还能按板块单独开关**：板块行上的 `#`，亮着 = 这块印号；默认值跟题型走，
  一旦手动点过就以手动值为准（`smallNoFor()`，存 `section.smallNo`）；
- 序号方案存进 `layout.numbering`，**和排版一起保存**；「恢复智能排版」只清板块、**保留**编号方案
  （编号跟题目无关，没必要陪着一起清）；
- 参数全部容错（`normSpec`）：旧数据没这字段就用默认（`一、` / `1.`），值被改坏也回落到合法值
  —— 注意「没给 pre/suf」和「显式给了空包裹」必须分开判，否则空对象会把默认顿号清成空。

**题目变了不再作废排版**（2026-10-06 改）：选题与排版在同一页，加题/移题都当场落在卷面上，
`buildFromManual` 会把新题并进同名板块、把已移出的 id 滤掉，所以原来的「`question_ids` 一变就清
`layout`」那条规矩已经删掉了 —— 那会让用户刚拖好的排版凭空消失。唯一作废排版的动作是手动点
「恢复智能排版」。

### 题型分桶、题内插图（位置 + 大小）、A4 真分页（2026-10-06 加）

用户反馈的三件事：**有些题分类错**、**插图位置不合理**、**排版界面看不出打印会怎么分页**。
三处的做法都在 `app/js/sheet.js`（+ 分桶规则抽到 `app/js/qtype.js`）。

#### 分桶：三级优先，规则只有一份

`app/js/qtype.js` 是**全站唯一口径**，首页统计、组卷台筛选、卷面板块、打印全用它：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 0 | **题库级手动打标** `source.qtype_manual` | 2026-10-07 加，见下节；比一切都大 —— 用户打标就是为了纠正板块名/模型的误判 |
| 1 | `layout.types`（这份卷子里的排版覆盖） | 按题目 id 覆盖，跟排版一起落库，换机器打开也一致 |
| 2 | **卷面印刷的板块名** | 关键词表 `SEC_RULES`，见下 |
| 3 | 模型识别的 `qtype` | 只有 6 个值，认不出来才用它 |

#### 题库级手动打题型（2026-10-07 加）

**两层改动要分清**：卷面上那个题型小标（排版态，`sheet-edit.js`）改的是**这一份卷子的排版覆盖**
（`layout.types`）；这里说的是**题库本身** —— 改完全站生效（首页统计 / 组卷台筛选 / 照片卷
`print.html?id=` 的分桶 / 之后再组卷的默认归类）。

- **入口**：① 组卷台左栏题库列表，每条题目左上角的题型小标（`.tchip`，本来就是 chip 样子，
  2026-10-07 起可点）；② 题目详情页 `question.html` 的题型小标。点开 `UI.typePicker`
  （`ui.js`，fixed 浮层挂在 body 上）选 9 类之一；打过标的显示「·手」后缀，
  浮层里多一条「恢复自动识别」（删键）。
- **存储**：`questions.source.qtype_manual = <桶键>`（source 是 jsonb，**不用改表结构**；
  离线 Python 只读 `source.bbox/file/page`，多出的键无害）。写回走 `CloudAPI.updateQuestion(id, patch)`
  （cloud.js 新增，顶层浅合并；RLS owner_all 自带 UPDATE）。
  演示模式（local-demo.js）题库只读，覆盖层存 `localStorage["sj-demo-qtags-v1"] = {题目id: 桶键|""}`，
  读取时 `applyTags()` 叠回去，刷新不丢。
- **优先级**：`bucketOf()` 里手动打标**排第一**（在板块名之前）—— 自检 `sheet_fix_check` ①-4b/①-4c。
- ⚠️ **CSS 坑**：浮层用 `.qmenu` 的皮，但定位必须 `.qmenu.typepick { position:fixed }`
  **双类**压住 —— `.qmenu` 本体在本文件更晚声明，单类 `.typepick` 写 fixed 会被它覆盖回
  absolute（实测弹到筛选行底下）。窗口不滚时两者碰巧同位、截图看不出来，一滚就穿帮。

桶共 9 个（比 schema 的 6 个多了 `calc` / `judge` / `compare`）：
`choice / fill / compare / calc / judge / solve / geometry / proof / other`；
每个桶的**默认板块名**（`TYPE_SECTION`）依次是
选择题 / 填空题 / **比大小** / 计算题 / 判断题 / **应用题** / 几何题 / 证明题 / 其他
（2026-10-06 应用户要求：`solve` 的默认名从「解决问题」改成「**应用题**」，
`fill` 里把「**比大小**」拆出来单独成桶 ——「在○里填入＞＜=」是一类独立大题，
题干里的 ○ 是**运算符**（`102×3 ○ 500`），跟填空题的空位不是一回事。
注意只改**我们自己生成的**板块名；照片卷里原卷印的「五、解决问题」按原样保留）。
`compare` 默认 3 列（算式短，一行排得下）。
旧的 `calculate` 归一成 `calc`（`TYPE_ALIAS`），老 layout 读进来照样认。

`SEC_RULES` 是数组，**顺序即优先级**（判断 → 解决/应用 → 选择 → **比大小 / 在○里填** → 填 →
竖式·递等式·口算·列式·计算·估算 → 几何 → 证明）。为什么必须让板块名压过模型题型：模型只有「解答」一档，
「2. 用竖式计算」「三、递等式计算」全被它打成 `solve`，整段题跑进应用题里 —— 用户看到的
「分类错误」就是这个。组卷台的题型下拉、首页卡片的分布条、卷面的板块分组，三处由此**必然是同一份答案**
（曾经首页直读 `q.qtype`，就会出现首页写「解答 12」、卷面却排进「计算题」）。

⚠️ `compare` 那条规则**必须排在 `填` 之前**：否则「三、在○里填入“>”“<”或“=”」会先被 `填` 抢走，
又变回填空题。

**手动改一道题的题型**：排版模式下每题右上角有个题型小标（`选择`／`计算`／… ），
点开是 9 个桶的菜单；选完这道题就挪进对应的板块（没有该板块就按 `typeIndex` 插到正确位置，
不是一股脑塞到最后），并存进 `layout.types = {题目id: 桶}`。
这是**这道卷子的本地覆盖**，不属于通用口径，所以留在 `sheet.js` 那一层（`bucketOf()` 先查覆盖再问 `QType`）。

##### 题目内容手动修正（question.html「编辑题目」，2026-10-07）

识别难免错字 / 漏条件 / 漏选项，题目详情页给一个就地编辑表单（「编辑题目」按钮，
与左栏原图裁剪**左右对照着改**）：

- **模板按题型**（2026-10-07 二次简化，用户原话「算式/比大小给一个公式编辑器就够；
  只有选择题才有选项；图片能编辑替换」—— 批16 的「块编辑器」把内部概念暴露成 UI，过度设计，已撤）：
  - **算式 / 比大小（calc / compare）= 一个多行公式编辑器**：一行一式，`×÷·±≤≥≠ ○ □ [?]` 直接打，
    底部 KaTeX 实时预览（250ms 防抖）。没有块工具条、没有插入按钮。
  - **其余题型 = 一个多行文本框**：`____` 是空格（填空题头部实时「共 N 空」计数）；
    复杂公式用 `$…$` 包起来写 LaTeX；`［图：说明］` 是插图占位行（位置标记）。
  - **只有选择题有选项区**：默认 4 行空 + 「加一个选项」；其它题型识别真误加了选项才把行显出来
    让删（标注「识别误加的，把行删掉再保存」），**不给加钮**。
  - **图列表**（**没有图也出现**，在文本框下方）：缩略图（`Render.stemHtml` 现裁）+ 说明输入框 +
    **显示大小滑杆**（30~100%，即时反映到缩略图）+ **显示位置**（左/居中/右 + 文字环绕）+
    **「替换」**（整页原图重新框选 = 换这张图）+ 删除（占位行同步清掉）；
    列表下面常驻 **「＋ 从原图切一张图」**（识别漏了图、或想再切一块时的入口，见下节）。
  - **「√ 公式编辑器」**（文本框下方常驻，2026-10-07 加）：复杂公式（分式/根号/上下标）不用手写
    LaTeX —— 弹层里是 **MathLive** `<math-field>`（自托管 `js/vendor/mathlive/`，模块 + KaTeX 字体
    约 1.7MB，**动态 `import()` 懒加载**，只在点开时拉），点符号拼结构、所见即所得，
    也认得直接打的 LaTeX（**已关掉过度智能**，2026-10-07 用户反馈「输入除法就变成了分数」：
    inlineShortcuts 换最小表 —— `*` 给 `\times` 不给 `\cdot`；`/` 是键盘绑定（`\frac{#@}{#?}`），
    `normalizeKeybindings` 会把 setOptions 追加项过滤掉，改为 **keydown 捕获阶段拦截** `/` 与
    `÷`，`executeCommand("insert", …)` 落字面字符。**虚拟键盘键帽也是坑**（2026-10-07 用户反馈
    「虚拟键盘上的 ÷ 会将数字变成分数」）：`[/]` 键帽 label 是 ÷ 但 latex 绑 `\frac{#@}{#?}`、
    `[*]` 键帽默认 `\cdot` —— insert 命令直发拦不到，已 **patch 自托管 vendor**（
    `mathlive.mjs` 搜 `PATCH(shijuan)` 两处：÷→`\div`、×→`\times`，原结构挪进长按变体；
    重装 vendor 后要重打）。模块 import 带 `?v=` 防缓存。「插入公式」写回光标处（选中/光标落在一段 `$…$`
    **插入内容分模式**（2026-10-07 修，用户截图反馈「插入公式很奇怪」）：**算式/比大小模式**里
    整框本来就是可读符号一行一式，先 `texToPlain` 把编辑器的 LaTeX 转回 `×÷·` 落成普通文字，
    转不平的（`\frac` 等）才包 `$…$`；其它题型照旧包 `$…$`。算式预览（`runPv`）按行喂 KaTeX 时
    认 `$…$` 段（段内原样、段外走 `plainToTex`），`［图：…］` 占位行不进公式（`lineToTex`）。
    存储仍是 `$…$` → latex 片段，schema 与渲染端（KaTeX）零改动。
    Esc / 取消关闭不落内容。自检 compose_lay_check ⑭-1e（拼 3/4 → `$\frac{3}{4}$`）、
    ⑭-1f（算式模式插 `3 \times 4 \cdot 5 =` → 框里是可读的 `3 × 4 · 5 =`、无 `$`、预览照排）。
- **存储约定**（schema v2 不变，批11 验证过的模型 + 批16 的可读符号改进）：
  stem 片段数组（text / latex / figure）与编辑框文本互转 —— **可读算式直接存 text 片段**
  （渲染层 `mathify` 把 ×÷ 包成 KaTeX，观感与 latex 一致，无损）；`$…$` 存 latex 片段（复杂公式）；
  `［图：…］` 按顺序回填 figure 原片段（bbox/fix 全保留，**占位删了图也不丢**——剩下的图自动补回末尾）。
  算式/比大小载入时片段之间换行（一行一式），其余题型连排（算式留在句子里）。
  没动过的片段原引用回写 —— 改一个字不影响别的片段。
- **保存**：见上；`source.edited = true` 后
  详情页挂绿色「已人工校对」角标、meta 里多一行「内容：已人工修改」。原图 / 坐标不动。
- **演示模式**：local-demo 的题库只读，内容修正另存覆盖层
  `localStorage["sj-demo-qtags-v1"]` 之外的 `sj-demo-qedits-v1` = `{题目id: {stem, options, edited}}`，
  读取时 `applyEdits()`（在 `applyTags()` 之前）叠回去，刷新不丢。
- ⚠️ 验证渲染别用 `textContent` 判断重复 —— KaTeX 的 `.katex` 里 hidden MathML（`katex-mathml`
  的 `<annotation>` + `<math>` 本体）会把公式原文**再带两份**进 textContent；mathify 场景更糟：
  多个独立 `\(...\)` 的 MathML 注释会**插在正文中间**把连续文字拆断（`12×3=` 的 textContent 变成
  `12×{}\times{}×3={}=`）。断言前先克隆节点删掉所有 `.katex-mathml` 再取 textContent。
  自检 compose_lay_check ⑭（8 条：公式编辑器+预览 → 改算式保存 → 刷新还原（text 片段）→
  文本题补算式 → 填空纯文本框 → 图列表（缩略图宽 ≥60）→ 选择题 4 行+加选项）。
- ⚠️ 自检断言写在**模板字符串**里时 LaTeX 反斜杠要按两层转义：`"3\\\\times4=12"` ——
  模板字面量吃一层、浏览器 JS 字符串再吃一层；写 `"3\\times4=12"` 浏览器收到的是 `\t`（制表符），
  永远匹配不上（⑭-2b 踩过）。
- ⚠️ 覆盖层两端都要按「有才覆盖」：图片微调只带 stem 不带 options，`clone(undefined)` 会
  **抛异常**（JSON.stringify(undefined) 不是字符串）→ 保存静默失败、刷新全丢（自检 ⑮-4 抓过）。

##### 题内插图：切图 / 替换 / 摆正 / 显示大小 / 显示位置（question.html，2026-10-11 更新）

题内插图 = 按 `seg.bbox` 从**整页原图现裁**（CSS 裁切，不是独立文件）。识别漏了图、或想再切
一块出来，都在编辑态「图列表」里做。

- **「＋ 从原图切一张图」= 新增一张插图**（2026-10-11 用户要求：「有些，你没有切图片，所以编辑
  的时候，是需要支持切图片的」）：开 `#figm` 的**新建模式**（标题/主按钮换成「从原图切一张图 /
  加进题目」、「恢复识别原状」收起、先给一个页面正中的默认框）。在整页原图上**直接拖一下**就画出
  框（`#figm-page` 的 pointerdown/move：只有点在原图本身才画，且拉不开 6px 就不动框 —— 免得点
  一下就把原框毁掉），拖四角改大小、拖顶上圆点转选区，与替换模式共用同一套手势。
  保存 = `figmCreate`：新 `{t:"figure", bbox, caption, rot?, fix?}` + `seg.img`（从哪张原图上切的）
  插进 `q.stem`，同时往编辑框文本里插一个 `［图：说明］` 占位行。
  ⚠️ 位置按**占位符**对齐：文本里第 k 个 `［图：］` 对应 efigs 第 k 项，所以**两边一起插在 k**
  （新片段插在"第 k 张老图"前面；占位符插在**文本框最后停过的光标**处 —— 点「＋切图」时焦点已经
  跑到按钮上、读不到实时光标，所以点/敲键盘时随手记进 `CARET`；公式编辑器没有光标概念，补末尾）。
  一律补末尾的话，「保存修改」时占位符会把别的图换到自己位置上。
- **「替换」（`#figm`）= 改这张图的裁剪区域**：左边整页原图 + 可拖框（移动 / 四角 / 顶上圆点转选区，
  pointer capture，初始框 = `bbox || bbox0`）+ 8 个缘微调钮 + 坐标读数 + 摆正滑杆（±8°）
  + 「图下说明」输入框。只动框（角度 0）→ 写 `seg.bbox` 纯数据零开销；角度 ≠ 0 → 烤 `seg.fix`。
  ⚠️ 「摆正」转的是**选区本身**（2026-10-11 用户纠正）：在选区自己的坐标系里裁（原图绕框心反向
  转回来再切），不是"先框一个正框、再转框里的内容"——那样四周会多出一圈背景。
- **显示大小 / 显示位置**（2026-10-11 用户要求）：figure 片段上三个字段，`Render.figView` 一个入口：
  `dw`（30~100 百分数）/ `pos`（l / c / r）/ `wrap`（文字环绕，只有左右成立）。**三端口径必须一致**
  —— 网页端 `app/js/render.js`、单文件导出 `engine/render.py` 的内联 `figView`、打印链
  `engine/paper.py` 的 `fig_view`；样式统一落成 `--fdw` + `fp-*` / `fw-*` 类名
  （`tools/fig_view_check.py` 专门钉这一条）。
  - 大小用 **zoom**（`--fdw`），**不要用 max-width**：`.figbox` 是 inline-block 收缩包装，
    百分比 max-width 是相对题栏算的 —— 203px 的图，50% 的题栏 = 286px 根本碰不到它，图纹丝不动。
  - 位置在外层 `.figwrap` 上用 **text-align** 摆，图自身宽度一点不变；直接给 `.figbox` 加
    `display:block + margin auto` 会让它撑满整栏（图突然变通栏大，实测 203px → 572px）。
  - 卷面（`sheet.js`）另有一套：那边 `.figbox` 是块级、宽有定值（`--figw`），位置用 margin auto 摆，
    默认宽按 `题型默认 × dw` 折算（排版态拖过的**绝对毫米**优先，不再乘 dw），`figHtml` 会把外层
    包裹拆掉（留着会挡住"手柄挂进 .figbox"的位置判断）。**手工定过位置的图不再被题型默认落位抢走**
    （`Render.figPosFixed`：应用题"靠右"、带图选择题"贴选项右侧"都让位给用户）。
  - 打印链 `paper.py` 里 img 是常规流内元素（有固有尺寸），按 `max-height/max-width × dw` 缩即可
    （那边没有 zoom）。
- **多张原图**：弹层顶上给一排原图缩略图选「从哪张上切」（只有一张原图就不显示）；切下来的片段记
  `seg.img = 文件名` —— 不记的话渲染时按题干那页去抠，**从别的照片上切的图会抠错**。
- **留底与恢复**：第一次动过就记 `seg.bbox0`（识别原状）；「恢复识别原状」一键清 `fix/rot/bbox0`，
  bbox 回识别值。
- **渲染层**：见 `seg.fix` 直接 `<img>`（data URI + 大小/位置类名），否则按 `seg.img || 题干页` 的
  bbox 现裁。**不能用 `seg.src`**：引擎数据里 src 是预裁子图路径（`data/crops/…`），含义不同。
- 持久化走 ⑭ 同一条 `updateQuestion(stem)` 通道（云库落库 / 演示覆盖层 `sj-demo-qedits-v1`）。
  **从编辑器图列表点进弹层**：保存后留在编辑态，图列表按新 stem 重建（保存后 seg 是新克隆，
  引用必须重建，不然改的是旧对象）。
  自检：`tools/fig_edit_check.mjs`（29 条：入口/切图/拖框/占位符位置/大小位置控件/真像素/落库往返/
  卷面口径/多图）+ `tools/fig_view_check.py`（21 条，钉打印链与三端一致）。
- ⚠️ 编辑器缩略图：`.figbox` 是 inline-block 收缩包装、里面的 img 又绝对定位（cropBox 实现），
  **不显式撑宽会塌成边框宽（~3px）**——`.fthumb .figbox{display:block}` 必须留着（⑭-1d 断言
  缩略图宽 ≥60 抓过）。但缩略图**不能吃 zoom**：`width:100%` 会把 zoom 抵消掉（渲染宽还是 180），
  所以缩略图直接把 `--fdw` 当宽度百分比（`width: calc(var(--fdw,100)*1%)`）。
- ⚠️ 「调整」弹层（大小/旋转/拉伸、四点透视矫正）已于 2026-10-07 按用户要求整体移除，别再主动
  加回来（`fig_edit_check` ⑩-1 / `fig_view_check` ⑦-1 断言不回潮）。变形修正只剩「替换」弹层里的
  摆正角度一条路；要改显示大小/位置，用图列表里的滑杆与位置按钮（2026-10-11 加）。
- **canvas 跨域**：演示图片 `assets/benchmark/…` 与页面**同源**没问题；云端 signedUrl 若跨域，
  `drawImage` 会污染 canvas → `toDataURL` 抛错，部署时要给存储 URL 配 CORS。

#### 题内插图：独占一行 + 带图题跨整行 + 应用题靠右 + **带图选择题「左选项右插图」**

题内插图是 `stem` 里的 `t:"figure"` 片段，此前 `inline-block` 挤在句子尾巴上，
在多列板块（计算题 3 列）里被压成一条。现在：

- `.gitem .figbox { display:block; max-width:68mm }` —— 图另起一行、限宽，不再跟文字抢行；
- 带图的题整个 `.gitem.wide { grid-column: 1 / -1 }` —— **跨整行**，不然图会被窄列挤扁；
- **应用题（`solve` 桶）的图靠右**：`.gitem.figright .figbox { margin-left:auto }` ——
  左边整块留给学生写算式。判定在 `figRight(q)`（`bucketOf(q) === "solve" && hasFigure(q)`），
  与本地成卷链路 `engine/paper.py` 的 `.figwrap-right` 是同一条规矩，两条链看着才一致。
  其他题型的插图仍靠左；
- **带图的选择题排成「左选项 / 右插图」**（用户要求）：`.gitem .figduo` 是两栏 grid，
  右栏放图、左栏吃掉剩下的宽度排选项。判定在 `figChoice(q)`
  （`choice` 桶 + 有选项 + 有图）。`itemHtml` 把 `figure` 片段从文字流里摘出来单独放右栏，
  选项的可用宽度按插图**实际宽度**现算（`43em − (图宽/4.233mm + 列距)`），于是 4 个短选项
  自然排成 2×2；图调大，左栏就自动让位，不会把选项挤到图下面去。
  这类题（如「下面用竖式算出了…框住的这一步表示的是（ ）」）图是主体、选项是四个短句，
  左右并排一行读完，比「图独占一行、选项甩到图下面」省一半高度。

##### 插图大小可调（`layout.figs`）

图多大合适，只有排卷的人看得到，一个通用默认值不可能对每道题都对。所以排版态里
每张题内插图的**边**上挂了一条手柄，横拖改宽度：

- 宽度落在 `.gitem` 的 `--figw` 上（`itemHtml` 按 `layout.figs` 写），
  css 里 `.figbox` 的 `max-width` 与 `.figduo` 的右栏宽度都读它；默认普通题 68mm、
  带图选择题 62mm，可调范围 20–170mm（卷面内容宽 186mm）；
- **手柄挂哪条边取决于图靠哪边**：左对齐的图挂右边缘，右对齐的应用题图挂**左**边缘
  （`#sheets.editing .gitem.figright .figh { left:-12px }`）—— 右对齐时右边缘是钉住的，
  宽度一变是左边在动，手柄不挂左边就不跟手。拖动方向也相应取反（`FIG.dir = ±1`）；
- 拖动中**只改 `--figw` + 显示实时宽度**（`.fighw`），不重画：一是跟手，二是重画会重新
  分页、把正在拖的那个手柄换掉。松手才落数据 + `draw()`（这时才需要按新高度重分页）；
- **双击手柄恢复默认**；拖回默认值时把这条覆盖删掉，不在 `layout.figs` 留脏数据；
- 存进 `layout.figs = {题目id: mm}`，跟排版 / 题型覆盖一起落库（`SE.snapshot()`）。
  跟"手动改题型"一样属于**这份卷子本地的设置**，所以 `恢复智能排版` 不清它。
- ⚠️ 换算：`clientX` 是**视觉**坐标，组卷台给 `#sheets` 加了 `transform:scale`，
  所以要除以缩放比；mm 用 `Sheet.pxPerMm()`（量 10mm 探针，不受 transform 影响，
  也不写死 96dpi）。拖动开始时量一次就够，不用每帧重测。

##### 图下说明文字可移除（`layout.caps`）

识别时会给每张题内插图补一行小字（`figure.caption`，如「图：24×4 的竖式，框住的是
20×4 这一步」）—— 那是**识别过程的备注**（"图印不清时靠它读懂题意"），但印在卷面上
往往多余，有时还跟原卷自己印的图注打架。所以排版态里每张图右下角挂了个开关：

- 显示「**说明 ✕**」= 现在这行字印着，点一下**移掉**；变成「**说明 ↺**」= 已移掉，再点恢复；
- 移掉与否记进 `layout.caps = {题目id: [图序号…]}` —— 图序号是这道题 `stem` 里
  第几个 `figure` 片段（从 0 起），所以一道题有两张图时可以只移掉其中一张；
- 跟 `layout.figs` 一样属于**这份卷子本地的设置**：跟着排版落库，`恢复智能排版` 不清它；
- 移掉后**打印、预览、排版都不印**（`sheet.js` 的 `figHtml()` 在 `meta` 判断**之前**
  就把 `.figcap` 摘掉了，所以非排版态也生效）；开关本身带 `.no-print`，不会印到纸上；
- 说明还在时给 `.figcap` 留 60px 右内边距（`#sheets.editing` 下），否则按钮会压在
  最后一个字上；打印态没有这条规则，说明照原样排。

##### 打印预览（排版工具条「打印预览」）

排版态的卷面全是编辑控件（把手/列数/图手柄/说明按钮），看的是结构不是成品。工具条上的
「打印预览」（`lay-preview`）用**同一份排版数据（含未保存改动）**按打印态重画一份干净的
（`sheetHtml(..., ed=false)`，`buildFromManual` 的 keepEmpty 传 false 过滤空板块），
盖进全屏遮罩 `.lay-pv` 里，按 A4 分页并在左上角标「共 N 页」：

- 遮罩里的「打印 / 存为 PDF」直接 `window.print()`：打印 CSS 靠 `body.pv-open` 把 body 下
  **除遮罩以外的全部孩子**藏掉（`> :not(#lay-pv)`）、遮罩转静态流 —— 打出来就只有预览卷面；
- 「关闭预览」或 **Esc** 退出，排版态原样保留（预览只读，不动任何数据）；
- ⚠️ CSS 按**类**选（`.lay-pv`），JS 必须 `className = "lay-pv on"` —— 只写 `id="lay-pv"`
  的话规则一条都匹配不上（踩过：遮罩在 DOM 里、自检只查存在性全绿，实际 `display:block`
  落在页面底部看不见；自检 ⑫-2 已补 `getComputedStyle().display === "flex"`）；
- 预览里插图异步解码（data: URI 也要解），等完（上限 1.2s）再 `Sheet.paginate()`，页高才准；
- 两个页面共用：print.html 走默认按钮组，compose.html 的 buttons 里加了 `"preview"`。

#### A4 真分页：实测贪心装箱 + 搬真实 DOM 节点

浏览器的分页是「打印时才知道」，用户看不到；而且不分页就会从题目中间劈开。做法是
**先让浏览器把一个 `.sheet` 排出来，量完再真分页**（`Sheet.paginate()`）：

1. **拆块**：卷头 / 「板块标题 + 第一行」/ **每一行题**各算一块。多列 grid 里同一行是一整块，
   行不能跨页拆（拆了就是半道题）。
2. **贪心装箱**：按页内容高 `297 - 28(上下边距) - 5(留白) = 264mm` 依次装，
   `used + gap + h > 264mm` 就换页。量出来的 px/页高由 10mm 探针现测（不写死系数）。
3. **重建**：建新的 `.sheet`，把**真实 DOM 节点搬进去**（不是重画）—— 所以 KaTeX 只排一次、
   图片不重新请求、编辑态的输入焦点不丢；每页右下角加 `.pgno`「第 i / n 页」（`.no-print`，不印到纸上）。

⚠️ **量高一律用 `offsetTop` / `offsetHeight`，不能用 `getBoundingClientRect()`** ——
组卷台给卷面加了 `transform: scale`，rect 是缩放后的视觉尺寸，会把页高算错（曾经因此永不换页）。

跨页的板块（同一板块被拆到两页）有两条暗线：

- 页面上是多个 `.grid-sec`，但共用同一个 `data-si`，自检/读数都要**按 `data-si` 归并**；
- 每个网格记 `data-qbase` =「本格第一题在整段板块里的下标」，拖拽落点用
  `gridBase(grid) + dropIndex(...)` 换算成全局下标，否则跨页后会拖错题。

打印侧 `.sheet + .sheet { page-break-before: always }`，`@media print` 里 `.sheet` 去掉
padding/min-height —— **不再靠 CSS 自动分页，而是我们分好了让浏览器照打**。
一份 41 题的卷实测打出 4 页 A4（行距加大后），每题完整不断开。

⚠️ **打印时外面的包装必须让开**（2026-10-06 踩的坑）：`#sheets` 外面套着 `.wrap`
（`padding: 22px 20px 60px`），上内边距把卷面整体往下推 5.8mm、末尾再留 15.9mm、横向还缩窄 40px。
分页是按 12mm 页边距（269mm 可用）算的，卷面一旦被顶出去一点点就溢出成两页 ——
**表现就是打印多出一张空白页**（屏幕上 2 页、打印 3 页）。所以 `@media print` 里
`.wrap { padding:0; max-width:none; margin:0 }`、`.msg` 不占位；组卷台那边再把
左栏（`.bank`）、页头（`.phead`）、`fitSheet()` 的 `transform`/裁高一起还原，
**从组卷台直接 Ctrl+P 印出来也是原大、只印卷面**。

排版态的大题标题是一行就地控件（`≡` 拖拽 / 序号 / 改名框 / `1-4` 列 / `#` / `↑↓` / `×`），
整行挂着 `.no-print` —— 直接打印的话卷面上**一道大题标题都没有**。`@media print` 里把这行
还原成「序号 + 标题文字」的纯标题（用 `display:flex !important` 顶掉 `.no-print`）。

自检：`node tools/sheet_fix_check.mjs`（**52 项** = ① 分类 11 项 ② 插图 6 项 ③ 分页 9 项
④ 口径一致 6 项 ⑤ 题距 2 项 ⑥ 插图大小 10 项 ⑦ 图下说明 8 项），其中 ③-1/③-4 数出「4 页 / 41 题没丢」，②-4 量应用题插图的右缘
是否贴住题格右缘，②-5 量带图选择题是不是真的「左选项右插图」，**③-8/③-9 真打一份 PDF 数页数，
跟屏幕上的卷面张数对比** —— 「所见即所印」不能靠肉眼，空白页就是这一步抓出来的。

### 登录与权限：微信登录 + 每账号 2 次识别（2026-10-26 起）

2026-10-06 曾加过一套「开通制」（登录 ≠ 能用），2026-10-26 按要求整体移除；同一天又收紧成
**只允许微信登录 + 每个账号 2 次免费识别**。

**1. 登录方式**

| 环境 | 可用登录 | 实现 |
|---|---|---|
| 生产（发布域名） | **只有微信扫码** | `ui.js` 的 `LOCAL_HOST` 不命中 → 登录卡加 `.wxonly`：手机号表单被 CSS 收起，微信从圆形图标变成整行主按钮 |
| 本地（127.0.0.1 / localhost） | 手机号验证码 + 微信 | 命中 `LOCAL_HOST` 就不加 `.wxonly`，保持原样（本地本来还会自动进演示模式） |

- 手机端微信内置浏览器没法扫码（没有第二块屏），文案已写「手机端请改用电脑打开」。
- ⚠️ 前端隐藏 ≠ 服务端禁止：静态站点没有后端，绕过页面直接调 auth 接口理论上仍能发短信。
  真要封死得去云服务后台把 phone provider 关掉。
- 登录卡底部与首页页脚都有源仓库入口，**只用 GitHub 的 mark 图标（圆形按钮 `.repo-gh`），页面上不印 URL**；
  地址放在 `title` / `aria-label`（悬停可见，读屏能念），下方一行小字「建议自行部署，不限次数」。
  `<https://github.com/nicoaigc/juan>` 只出现在代码常量（`ui.js` 的 `REPO_URL`）、配额用完的提示句里
  （正文「自行部署」四个字做链接）和错误文案中 —— **别再把 URL 文本加到页面上**。

**2. 识别次数（生产固定 2 次）**

- 表 `recognition_usage`（`owner_id` 主键、`used`、`updated_at`）：**只有 SELECT 策略**，
  INSERT / UPDATE 一条策略都不给 → 客户端改不了，只能走函数。
- `app_recognition_quota()`（STABLE）：读 `used / quota / remain`，不扣次数。
- `app_consume_recognition()`（VOLATILE，SECURITY DEFINER）：条件更新
  `UPDATE ... SET used = used + 1 WHERE used < 2` —— 并发下也不会超发；扣不动就
  `RAISE EXCEPTION '识别次数已用完（2/2）'`。
- 计数口径：**一次整卷识别、一次单页重扫各算 1 次**；删卷、删题、换设备、清缓存都不返还。
- **应用所有者豁免**：`wu:oYQVK6hFHTnEpwJNQaesnfblL-8c` 在两个函数开头直接返回
  `quota = null`（前端把 null 当「不限」，顶栏显示「识别不限」），**不写计数行** —— 自己的应用自己用不受限。
  要给别人也豁免：把那个 uid 加成一个 `IN (...)` 列表即可。
- 前端：`Recognize.recognizePaper()` / `Recognize.rescanPage()` 在**动任何数据之前**先扣一次，
  扣不动直接抛 → 「重新识别」不会先把旧题删掉再失败。顶栏每页显示「还可识别 N 次」，
  上传页另有一条明细；用完会把「创建并上传」按住并给出 GitHub 去处。
- 改次数：把两个函数里的 `q CONSTANT integer := 2` 改掉，`CREATE OR REPLACE` 重跑即可。

**3. 本地默认不限**

`app/js/local-demo.js` 的 `LIMIT` 默认 `null` = 不限（顶栏显示「识别不限」）。
要试限额用 `?limit=2`：**会记住、跨页面生效**（识别在卷详情页跑，参数不跟着跳转走），
`?limit=0` 关闭。计数存 `localStorage["sj-demo-quota"]`，所以本地也能验「删了卷再传照扣」。

**4. 数据隔离（不变）**

5 张业务表的 RLS 仍是 `USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())`：
`papers` / `paper_files` / `questions` / `custom_papers` / `question_backups`。
`recognition_usage` 是第 6 张表，只管计数、不存题目。

- **要恢复开通制**：执行 `.workbuddy/migrations/2026-10-26-remove-access-gate.sql` 的「回滚」段
  （重建表 + 4 个函数 + 5 条带 `app_can_use()` 的策略 + 当时的 2 行账号），再把
  `admin.html` 与对应前端代码还原。**那个迁移文件别删**。

### 本地预览与演示模式（2026-10-06 加）

线上后端是**云服务，按 Origin 精确校验**，本地 `127.0.0.1` 天然连不上（登录、拉数据全失败）。
所以本地想看界面走的是**演示模式**：`app/js/local-demo.js` 拿 `app/assets/demo-library.json`
（5 份卷 135 题，图走 `assets/benchmark/` 静态文件）搭一套**内存版 `CloudAPI`**，
并把当前用户直接当成「已登录」，省掉登录。

```bash
# 1) 起本地静态服务（根目录必须是 app/，页面地址才形如 /index.html）
C:/Users/1/.workbuddy/binaries/python/versions/3.13.12/python.exe \
    tools/serve_with_csp.py --port 64911 --root app
# 2) 打开：http://127.0.0.1:64911/index.html
#    按 hostname 判定，本机自动进演示模式，不需要加任何参数
```

- **只在 `127.0.0.1` / `localhost` 下激活**：`local-demo.js` 第一行按 hostname 判断，判定不过直接 `return`；
  `cloud.js` 开头看 `window.__LOCAL_DEMO__` 决定是否早退 —— **线上零影响**。本机想关掉加 `?demo=0`。
- **能试**：我的试卷 / 卷详情 / 单题详情 / **组卷台（选题 + 排版同一页）** / 我的组卷 / 用户管理 / 打印版面。
- **不能试**：上传扫描件、AI 识别（要真云存储 + 云大模型，页面会自己报「云 SDK 还没就绪」）。
- 组卷数据写进 `localStorage`（key `sj-demo-customs-v1`），**刷新不丢**；右下角角标里有「重置演示数据」。
- 自检（都开一次性 Chrome profile，不污染你在试的浏览器）：
  - `node tools/compose_lay_check.mjs` —— **组卷台（19 项，本轮新增）**：加题落到卷面、卷面 `×` 移出、
    拖动换板块、标题/列数就地改、卷名即卷头、保存后留在本页且题目顺序与排版一起落库、刷新还原、编号面板；
  - `node tools/demo_check.mjs` —— 演示模式端到端（10 项）：进排版 → 拖题跨板块 → 改标题/列数 → 保存 →
    刷新仍在 → 组卷台保存后留在本页；
  - `node tools/print_no_check.mjs` —— 卷面编号规约（21 项）：顶栏入口、大题序号随位置重排、
    每板块小题号从 1 起、计算题默认不印、`#` 单独开关、编号面板的显示/数字形式/包裹样式、
    刷新后方案仍在、关掉显示后整卷无号、恢复智能排版回默认。

**把本地题库导到云上：**

```bash
# 原图像素尺寸（Pillow，用隔离 venv）
C:/Users/1/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/bench_sizes.py
# 生成导入 SQL（一份卷 = 一条 CTE 语句，原子写入三张表）+ 应用内示例题库
C:/Users/1/.workbuddy/binaries/python/versions/3.13.12/python.exe tools/cloud_sync.py \
    --owner <目标用户 uid> --copy-assets
```

生成的 `data/cloud_push/*.sql` 逐条交给云数据库管理通道执行（管理员代为导入，
所以 `owner_id` 是显式指定的——**应用自己的运行时代码永远不传 owner_id**，由 DEFAULT + RLS 决定归属）。
`app/assets/demo-library.json` 则供首页「载入示例卷」按钮使用：那一条走应用自己的会话写入，
只进当前登录用户自己的题库。

**发布：**

```bash
# 目录 app/ 就是应用根；重新发布复用同一个 applicationId 才能保住域名与云登录
# （用 WorkBuddy 的「发布为应用」能力，domainPrefix = shijuan-question-bank）
```

## 日常流程

1. 把试卷照片发给 WorkBuddy，说「识别题目」/「收进题库」
2. agent 按识别规范整页切题 → **所有题目**写 JSON（schema v2：只有题干/选项/图形/题型/来源/置信度）→ 裁剪题区（题干含插图时**另裁插图子图**）→ 裁剪自检 → 入库 → 生成校对页
3. 在浏览器里校对（重点看 `[?]` 标记和低置信度项），口头反馈修正
4. 确认无误即完成归档（无后续字段要补）
5. 要出卷时：改 `engine/paper.py` 顶部的板块/分值/版面参数 → 跑 `engine/paper.py` →
   `tools/export_paper_pdf.py` 看页数与留白 → 不满意就调参数重跑（HTML 是源，PDF 是成品）

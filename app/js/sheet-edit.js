/* ============================================================================ 卷面就地排版控制器
   SheetEd —— 让「卷面本身就是编辑画布」：题目卡片可拖动（同板块内调先后、拖到别的
   板块就换过去），板块标题就地改、列数就地切、板块本身也能拖动换序，外加「编号」面板
   （大题 / 小题各一套序号方案）。

   print.html（自建卷校对 / 照片卷打印）与 compose.html（组卷台）共用这一份，别再各写一套。
   与 js/sheet.js 的分工：那份只管画，这份只管交互与状态；数据存哪儿由页面决定
   （SheetEd 只提供 snapshot() 把当前排版吐出来）。

   两个页面的差别全在 opts 里，不再各写一套交互：
     · autoSecs —— 「智能排版」长什么样：自建卷按题型分板块（默认 Sheet.collectByType），
       照片卷按原卷板块还原（Sheet.collect）。
     · autoNo:false —— 照片卷专用：板块标题是原卷原文（含"一、"），序号不自动生成、
       小题号不重编（沿用识别存的原卷题号），所以标题框里放原文、不显示序号与 # 开关。

   两个必须守住的坑（都踩过）：
     · 编辑态**保留空板块**（先建好、还没往里拖题的那种），否则 DOM 上的 data-si 与
       LAY.manual 的下标错位 → 拖动会挪错题。所以打印态才过滤空板块。
     · 板块标题此刻显示的就是那个 input 本身，改名**不能重画卷面**（重画会丢焦点），
       只更新数据 + 打「未保存」。
   ============================================================================ */
window.SheetEd = (function () {
  "use strict";

  var BTN_DEF = {
    numbering: { text: "编号", cls: "btn sec sm" },
    reset:     { text: "恢复智能排版", cls: "btn sec sm" },
    save:      { text: "保存排版", cls: "btn sm" },
    preview:   { text: "打印预览", cls: "btn sec sm" },
    done:      { text: "完成", cls: "btn sec sm" },
  };
  /* 文案可以被页面覆盖（组卷台把「保存排版」叫成「保存试卷」—— 那边存的是整份卷子） */
  function btnText(k, labels) { return (labels && labels[k]) || (BTN_DEF[k] || {}).text || k; }
  /* 工具条按钮的 id：沿用旧写法（自检脚本、README 都按这几个 id 找），别随手改 */
  var BTN_ID = { numbering: "lay-no", reset: "lay-auto", save: "lay-save",
                 preview: "lay-preview", done: "lay-done" };
  function btnId(k) { return BTN_ID[k] || ("lay-" + k); }
  function btnKey(id) {
    var hit = null;
    Object.keys(BTN_ID).forEach(function (k) { if (BTN_ID[k] === id) hit = k; });
    return hit;
  }

  var NO_PANEL_HTML =
    '<div class="no-panel" id="no-panel" style="display:none">'
    + '<div class="no-row">'
    + '<span class="no-lab">大题序号</span>'
    + '<label class="no-chk"><input type="checkbox" id="no-big-show"><span>显示</span></label>'
    + '<span id="no-big-style" style="width:10.5em"></span>'
    + '<span id="no-big-wrap" style="width:10.5em"></span>'
    + '<span class="no-demo" id="no-big-demo"></span>'
    + "</div>"
    + '<div class="no-row">'
    + '<span class="no-lab">小题序号</span>'
    + '<label class="no-chk"><input type="checkbox" id="no-small-show"><span>显示</span></label>'
    + '<span id="no-small-style" style="width:10.5em"></span>'
    + '<span id="no-small-wrap" style="width:10.5em"></span>'
    + '<span class="no-demo" id="no-small-demo"></span>'
    + "</div>"
    + '<div class="no-tip">计算题默认不印小题号；某一个大题要不要号，用板块行上的 <b>#</b> 单独开关。改完记得保存。</div>'
    + "</div>";

  function el(x) { return typeof x === "string" ? document.querySelector(x) : x; }

  return {
    create: function (opts) {
      opts = opts || {};
      var host = el(opts.host);
      var bar = el(opts.bar);
      if (!host) throw new Error("SheetEd: 缺少卷面容器");
      var LAY = {
        qs: [], byId: {}, manual: null, types: {}, figw: {}, caps: {},
        open: !!opts.alwaysEdit, dirty: false,
      };
      var DRAG = null;
      var noOpen = false, noDD = {};
      /* 大题序号是不是自动生成（默认是，自建卷）。照片卷传 autoNo:false ——
         板块标题就是原卷印的那行字，序号与题号都沿用原卷，见 Sheet.buildFromManual。 */
      var AUTO_NO = opts.autoNo !== false;
      /* 「智能排版」长什么样由页面定：自建卷按题型分板块（默认），照片卷按原卷板块还原。 */
      function autoSecs() {
        return opts.autoSecs ? opts.autoSecs() : Sheet.collectByType(LAY.qs);
      }
      function manualOpt() { return { autoNo: AUTO_NO }; }

      /* ------------------------------------------------------------ 工具条 + 编号面板
         内容在这里生成（两个页面共用一套 id，自检脚本按 id 找），页面只给容器与按钮清单。 */
      var buttons = opts.buttons || ["numbering", "reset", "save", "preview", "done"];
      var btnHtml = buttons.map(function (k) {
        var d = BTN_DEF[k] || { text: k, cls: "btn sec sm" };
        return '<button type="button" class="' + d.cls + '" id="' + btnId(k) + '">'
          + btnText(k, opts.labels) + "</button>";
      }).join("");

      if (bar) {
        /* 2026-10-07：常驻说明文字收成「?」弹出 —— 8 行小字每次进页都占 1/4 屏，
           学过就不需要再看；操作按钮单独留在一行里。 */
        var helpText = opts.hint || "拖动题目卡片换位置 —— 同板块内调先后，拖到别的板块就换过去；"
          + "板块标题点开即改，右侧 1/2/3/4 切列数，左侧 ≡ 拖动整块板块。"
          + "带图的题拖图片右缘的小手柄调图片大小（双击回默认），图右下角的「说明 ✕」"
          + "移掉图片下面那行小字（再点一下恢复）。「打印预览」随时看按 A4 分页的成品效果。改完记得保存。";
        bar.classList.add("no-print");
        bar.innerHTML =
          '<span class="lay-tag">' + (opts.tag || "排版") + "</span>"
          + '<button type="button" class="ico lay-help" id="lay-help" title="操作说明"'
          + ' aria-expanded="false">?</button>'
          + '<div class="lay-helpbox" id="lay-helpbox" style="display:none">' + helpText + "</div>"
          + '<span class="spacer"></span>'
          + '<span class="lay-dirty" id="lay-dirty" style="display:none">未保存</span>'
          + btnHtml
          + (buttons.indexOf("numbering") >= 0 ? NO_PANEL_HTML : "");
        bar.addEventListener("click", function (ev) {
          if (ev.target.closest("#lay-help")) {
            var box = document.getElementById("lay-helpbox");
            var open = box.style.display === "none";
            box.style.display = open ? "" : "none";
            document.getElementById("lay-help").setAttribute("aria-expanded", open ? "true" : "false");
          }
        });
        document.addEventListener("click", function (ev) {   // 点外面收起
          var box = document.getElementById("lay-helpbox");
          if (!box || box.style.display === "none") return;
          if (!ev.target.closest("#lay-helpbox") && !ev.target.closest("#lay-help")) {
            box.style.display = "none";
            var h = document.getElementById("lay-help");
            if (h) h.setAttribute("aria-expanded", "false");
          }
        });
      }

      /* ------------------------------------------------------------ 编号方案面板 */
      function noWrapItems() {
        return Sheet.NO_WRAPS.map(function (w) { return { value: w[0], label: w[0] || "无" }; });
      }

      function noWrapByKey(k) {
        for (var i = 0; i < Sheet.NO_WRAPS.length; i++) if (Sheet.NO_WRAPS[i][0] === k) return Sheet.NO_WRAPS[i];
        return Sheet.NO_WRAPS[0];
      }

      function noDemo(s) {
        if (!s.show) return "（不印序号）";
        return [0, 1, 2].map(function (i) { return Sheet.noText(i, s); }).join(" ") + " …";
      }

      /* 改完只重画卷面 + 刷新预览串；面板（含两个下拉）不动，所以连着调不失焦 */
      function onNoChange() {
        markDirty();
        drawSheets(curSecs());
        syncNoPanel();
      }

      (function initNoPanel() {
        var panel = document.getElementById("no-panel");
        if (!panel || !bar || !bar.contains(panel)) return;
        [["big", "bigStyle", "bigWrap"], ["small", "smallStyle", "smallWrap"]].forEach(function (g) {
          var which = g[0];
          noDD[g[1]] = UI.select(document.getElementById("no-" + which + "-style"),
            Sheet.NO_STYLES.map(function (s) { return { value: s[0], label: s[1] }; }),
            { small: true, keepId: true, onChange: function (v) {
                Sheet.getNo()[which].style = v; onNoChange();
              } });
          noDD[g[2]] = UI.select(document.getElementById("no-" + which + "-wrap"), noWrapItems(),
            { small: true, keepId: true, onChange: function (v) {
                var w = noWrapByKey(v);
                Sheet.getNo()[which].pre = w[1];
                Sheet.getNo()[which].suf = w[2];
                onNoChange();
              } });
        });
        panel.addEventListener("change", function (ev) {
          var m = /^no-(big|small)-show$/.exec(ev.target.id || "");
          if (!m) return;
          Sheet.getNo()[m[1]].show = !!ev.target.checked;
          onNoChange();
        });
      })();

      function syncNoPanel() {
        var panel = document.getElementById("no-panel");
        if (!panel || !bar || !bar.contains(panel)) return;
        panel.style.display = noOpen ? "" : "none";
        var btn = document.getElementById(btnId("numbering"));
        if (btn) btn.classList.toggle("on", noOpen);
        if (!noOpen) return;
        [["big", "bigStyle", "bigWrap"], ["small", "smallStyle", "smallWrap"]].forEach(function (g) {
          var spec = Sheet.getNo()[g[0]];
          document.getElementById("no-" + g[0] + "-show").checked = !!spec.show;
          if (noDD[g[1]]) noDD[g[1]].set(spec.style);
          if (noDD[g[2]]) noDD[g[2]].set(Sheet.wrapKey(spec));
          document.getElementById("no-" + g[0] + "-demo").textContent = noDemo(spec);
        });
      }

      function toggleNoPanel() {
        noOpen = !noOpen;
        syncNoPanel();
      }

      /* ------------------------------------------------------------ 卷面 */
      function curSecs() {
        return LAY.manual
          ? Sheet.buildFromManual(LAY.manual, LAY.byId, LAY.qs, LAY.open, manualOpt())
          : autoSecs();
      }

      function drawSheets(secs) {
        host.className = LAY.open ? "editing" : "";
        host.innerHTML = Sheet.sheetHtml(secs, { title: opts.title ? opts.title() : "" },
          opts.ctx ? opts.ctx() : null, LAY.open,
          { canRemove: !!opts.canRemove, emptyText: opts.emptyText,
            autoNo: AUTO_NO, smallNo: opts.smallNo });
        Render.typeset(host);
        Sheet.paginate(host);            // 按 A4 分页（KaTeX 排完之后量高度才准）
        if (opts.onDraw) opts.onDraw(secs);
      }

      function draw() {
        drawSheets(curSecs());
        renderBar();
      }

      function renderBar() {
        if (bar) bar.style.display = LAY.open ? "flex" : "none";
        var d = document.getElementById("lay-dirty");
        if (d) d.style.display = LAY.dirty ? "" : "none";
        if (opts.onOpenChange) opts.onOpenChange(LAY.open);
        syncNoPanel();
      }

      function markDirty() {
        if (LAY.dirty) return;
        LAY.dirty = true;
        renderBar();
        if (opts.onDirtyChange) opts.onDirtyChange(true);
      }

      /* ------------------------------------------------------------ 编辑动作 */
      /* 第一次动手之前先把「智能排版」物化成 manual —— 之后就在它上面改。
         已有的 layout 不覆盖（那才是用户上次存下的样子）。 */
      function ensureManual() {
        if (LAY.manual) return;
        LAY.manual = autoSecs().map(function (s) {
          return { title: s.title, type: s.type, cols: s.cols,
                   ids: s.items.map(function (q) { return Number(q.id); }) };
        });
      }

      function moveQ(si, qi, si2, idx2) {
        var S = LAY.manual, a = S[si], b = S[si2];
        if (!a || !b) return;
        var id = a.ids[qi];
        if (id == null) return;
        if (si === si2 && idx2 > qi) idx2--;    // 自己被摘出去后，后面的位置整体前移一位
        a.ids.splice(qi, 1);
        b.ids.splice(Math.max(0, Math.min(idx2, b.ids.length)), 0, id);
        markDirty();
        draw();
      }

      function moveSec(from, to) {
        if (from === to) return;
        var S = LAY.manual;
        S.splice(to, 0, S.splice(from, 1)[0]);
        markDirty();
        draw();
      }

      function secCols(si, c) {
        ensureManual();
        var s = LAY.manual[si];
        if (!s) return;
        s.cols = Sheet.clampCols(c);
        markDirty();
        draw();
      }

      function secAction(si, act) {
        ensureManual();
        var S = LAY.manual;
        if (act === "sup" && si > 0) S.splice(si - 1, 0, S.splice(si, 1)[0]);
        else if (act === "sdown" && si < S.length - 1) S.splice(si + 1, 0, S.splice(si, 1)[0]);
        else if (act === "sdel" && S.length > 1) {
          var target = si > 0 ? S[si - 1] : S[1];
          target.ids = target.ids.concat(S[si].ids);   // 板块里的题不能凭空消失，并入相邻板块
          S.splice(si, 1);
        } else if (act === "sno") {
          /* 单个板块要不要小题号：以「当前实际印没印」取反，所以第一次点一定能翻转过来
             （没设过时走的是计算题默认，不设过也能一下点对）。 */
          var sec = S[si];
          sec.smallNo = !Sheet.smallNoFor(sec, sec.ids.map(function (i) { return LAY.byId[i]; }));
        } else return;                                  // 到头了就别打「未保存」（等于没改）
        markDirty();
        draw();
      }

      /* ------------------------------------------------------------ 改题型
         自动分桶再准也会有判错的（模型只看得到题干，看不出这是"用竖式计算"），
         所以给每道题一个就地入口：点右上角那个「计算 / 应用」小标 → 选一个板块。
         结果记进 layout.types，跟排版一起存，换台机器打开也一样。 */
      var TYPE_MENU = null;

      function closeTypeMenu() {
        if (TYPE_MENU && TYPE_MENU.parentNode) TYPE_MENU.parentNode.removeChild(TYPE_MENU);
        TYPE_MENU = null;
      }

      function openTypeMenu(item, qid) {
        closeTypeMenu();
        var cur = Sheet.bucketOf(LAY.byId[qid]);
        var m = document.createElement("div");
        m.className = "qmenu no-print";
        m.innerHTML = Sheet.TYPE_SECTION.map(function (t) {
          return '<button type="button" class="qmi' + (t[0] === cur ? " on" : "") + '"'
            + ' data-qid="' + qid + '" data-t="' + t[0] + '">' + t[1] + "</button>";
        }).join("");
        item.appendChild(m);
        TYPE_MENU = m;
      }

      function setBucket(qid, k) {
        qid = Number(qid);
        ensureManual();
        LAY.types[qid] = Sheet.normBucket(k);
        Sheet.setBuckets(LAY.types);
        LAY.manual.forEach(function (s) {           // 先从原板块里摘出来
          s.ids = (s.ids || []).filter(function (i) { return Number(i) !== qid; });
        });
        var hit = null;
        LAY.manual.forEach(function (s) { if (!hit && Sheet.secBucket(s) === k) hit = s; });
        if (!hit) {                                  // 没有同型板块就按题型顺序新开一个
          hit = { title: Sheet.TYPE_TITLE[k], type: k,
                  cols: Sheet.TYPE_SECTION[Sheet.typeIndex(k)][2], ids: [] };
          var at = LAY.manual.length, want = Sheet.typeIndex(k);
          for (var i = 0; i < LAY.manual.length; i++) {
            if (Sheet.typeIndex(Sheet.secBucket(LAY.manual[i])) > want) { at = i; break; }
          }
          LAY.manual.splice(at, 0, hit);
        }
        hit.ids.push(qid);
        closeTypeMenu();
        markDirty();
        draw();
      }

      function qAction(si, qi, act) {
        ensureManual();
        var S = LAY.manual, s = S[si];
        if (!s) return;
        if (act === "qup" && qi > 0) s.ids.splice(qi - 1, 0, s.ids.splice(qi, 1)[0]);
        else if (act === "qdown" && qi < s.ids.length - 1) s.ids.splice(qi + 1, 0, s.ids.splice(qi, 1)[0]);
        else if (act === "qprev" && si > 0) S[si - 1].ids.push(s.ids.splice(qi, 1)[0]);
        else if (act === "qnext" && si < S.length - 1) S[si + 1].ids.unshift(s.ids.splice(qi, 1)[0]);
        else if (act === "qdel") {
          /* 从这份卷子里移出：题型池与板块里都要摘掉，否则下次重画又挂着一条空 id */
          var id = Number(s.ids.splice(qi, 1)[0]);
          dropQuestion(id);
          if (opts.onRemoveQuestion) opts.onRemoveQuestion(id);
        } else return;
        markDirty();
        draw();
      }

      /* ------------------------------------------------------------ 插图大小
         排版态里每张题内插图的右边缘有一条手柄，横拖改宽度 —— 竖式这种图在卷面上
         到底多大合适，只有排的人自己看才知道（默认 62/68mm 只是个通用值）。
         结果记进 layout.figs = {题目id: mm}，跟排版一起存。
         ⚠️ 拖动过程中**只改 --figw 和提示文字，不重画卷面**：一是跟手，二是重画会重新
         分页、手柄本身也被替换掉（正在拖的元素没了，后续 pointermove 全丢）。松手才落
         数据 + 重画（这时候才需要按新高度重新分页）。 */
      var FIG = null;

      /* 组卷台给 #sheets 加了 transform: scale（等比缩小塞进半屏），而 clientX 是**视觉**
         坐标、offsetWidth 是布局尺寸（不受 transform 影响）—— 两者之比就是缩放比。 */
      function scaleOf() {
        var r = host.getBoundingClientRect();
        return (host.offsetWidth > 0 && r.width > 0) ? r.width / host.offsetWidth : 1;
      }

      function onFigMove(ev) {
        if (!FIG) return;
        /* dir：右对齐的应用题图，手柄在左边缘、往左拖才是变大（见 css 的 .figright .figh） */
        var dmm = (ev.clientX - FIG.x0) / FIG.sc / FIG.pxmm * FIG.dir;
        var w = Sheet.clampFigW(FIG.w0 + dmm);
        FIG.w = w;
        FIG.item.style.setProperty("--figw", w + "mm");
        if (FIG.badge) FIG.badge.textContent = w + "mm";
      }

      function endFig() {
        if (!FIG) return;
        var f = FIG;
        FIG = null;
        window.removeEventListener("pointermove", onFigMove);
        window.removeEventListener("pointerup", endFig);
        window.removeEventListener("pointercancel", endFig);
        if (f.h) f.h.classList.remove("on");
        if (f.w === f.orig) {                       // 没动过就别打「未保存」、别重画
          f.item.style.setProperty("--figw", f.orig + "mm");
          return;
        }
        if (f.w === f.dflt) delete LAY.figw[f.qid];  // 拖回默认 = 恢复默认，不留脏数据
        else LAY.figw[f.qid] = f.w;
        Sheet.setFigW(LAY.figw);
        markDirty();
        draw();
      }

      host.addEventListener("pointerdown", function (ev) {
        if (!LAY.open) return;
        var h = ev.target.closest(".figh");
        if (!h) return;
        var it = h.closest(".gitem[data-qid]");
        if (!it || it.dataset.si === undefined) return;
        ev.preventDefault();                        // 别触发题目卡片的原生拖拽
        ev.stopPropagation();
        var qid = Number(it.dataset.qid);
        var w0 = Sheet.figWidthMm(LAY.byId[qid]);
        var badge = h.querySelector(".fighw");
        h.classList.add("on");
        if (badge) badge.textContent = w0 + "mm";
        FIG = { qid: qid, item: it, h: h, badge: badge, w: w0, w0: w0, orig: w0,
                x0: ev.clientX, sc: scaleOf() || 1, pxmm: Sheet.pxPerMm() || 3.78,
                dir: it.classList.contains("figright") ? -1 : 1,
                dflt: Sheet.figChoice(LAY.byId[qid]) ? Sheet.FIG_W_DUO : Sheet.FIG_W_DEF };
        if (!FIG.pxmm) { FIG = null; return; }      // 量不出 mm 就别进拖拽态
        window.addEventListener("pointermove", onFigMove);
        window.addEventListener("pointerup", endFig);
        window.addEventListener("pointercancel", endFig);
      });

      /* 双击手柄 = 恢复默认大小（不用一点点拖回去） */
      host.addEventListener("dblclick", function (ev) {
        var h = ev.target.closest(".figh");
        if (!h || !LAY.open) return;
        var it = h.closest(".gitem[data-qid]");
        if (!it) return;
        ev.preventDefault();
        delete LAY.figw[Number(it.dataset.qid)];
        Sheet.setFigW(LAY.figw);
        markDirty();
        draw();
      });

      /* ------------------------------------------------------------ 图下说明文字
         题内插图下面那行小字（figure.caption）是识别时补的备注，卷面上常不需要。
         排版态点图右下角的「说明 ✕」逐张移掉、再点一次恢复；结果记进
         layout.caps = {题目id: [图序号…]}，跟 layout.figs 一样跟着排版存。 */
      function toggleFigCap(qid, fi) {
        if (!(fi >= 0)) return;
        var k = String(qid), cur = LAY.caps[k] || [];
        var a = cur.filter(function (n) { return n !== fi; });
        if (a.length === cur.length) a.push(fi);        // 原来没移过 -> 移掉它
        if (a.length) LAY.caps[k] = a.sort(function (x, y) { return x - y; });
        else delete LAY.caps[k];                        // 全恢复了 -> 不留空壳
        Sheet.setCaps(LAY.caps);
        markDirty();
        draw();
      }

      /* ------------------------------------------------------------ 打印预览
         排版态的卷面上全是编辑控件（把手/列数按钮/图手柄/说明按钮），看的是"结构"，
         不是"成品"。预览用**同一份排版数据**（含未保存的改动）按打印态重画一份干净的
         （不带任何编辑件、按 A4 贪心分页），盖进全屏遮罩里；遮罩里的「打印」直接
         window.print() —— 打印 CSS 靠 body.pv-open 把遮罩外的全部藏掉，打出来就只有
         这份预览卷面。Esc 或「关闭预览」退出，排版态原样保留。 */
      var PV = null;

      function onPvKey(ev) { if (ev.key === "Escape") closePreview(); }

      function buildPreview() {
        closePreview();
        var secs = LAY.manual
          ? Sheet.buildFromManual(LAY.manual, LAY.byId, LAY.qs, false, manualOpt())   // 打印态过滤空板块
          : autoSecs();
        var wrap = document.createElement("div");
        wrap.id = "lay-pv";
        wrap.className = "lay-pv on";   /* CSS 按类选（.lay-pv），id 只给自检/打印豁免用 */
        wrap.innerHTML =
          '<div class="pv-bar no-print">'
          + "<b>打印预览</b>"
          + '<span class="pv-pages" id="pv-pages"></span>'
          + '<span class="spacer"></span>'
          + '<span id="pv-mg"></span>'
          + '<button type="button" class="btn sm" id="pv-print">打印 / 存为 PDF</button>'
          + '<button type="button" class="btn sec sm" id="pv-close">关闭预览</button>'
          + "</div>"
          + '<div class="pv-body"><div id="pv-sheets"></div></div>';
        var host = wrap.querySelector("#pv-sheets");
        host.innerHTML = Sheet.sheetHtml(secs, { title: opts.title ? opts.title() : "" },
          opts.ctx ? opts.ctx() : null, false);
        document.body.appendChild(wrap);
        document.body.classList.add("pv-open");
        Render.typeset(host);
        /* 重新按当前页边距分页 + 刷新「共 N 页」（边距一改，页数就可能变） */
        function refit() {
          var n = Sheet.paginate(host);
          var p = wrap.querySelector("#pv-pages");
          if (p) p.textContent = n ? "共 " + n + " 页" : "";
        }
        /* 页边距：改完当场重排（纸上的边距跟着变；所见即所印不能靠猜） */
        wrap.querySelector("#pv-mg").appendChild(Sheet.marginCtl(refit));
        /* 图片（题内插图）即使 data: URI 也异步解码，等完（上限 1.2s）再分页，页高才准 */
        var imgs = [].slice.call(host.querySelectorAll("img"));
        Promise.race([
          Promise.all(imgs.map(function (im) {
            if (im.complete) return Promise.resolve();
            return new Promise(function (res) {
              im.addEventListener("load", res, { once: true });
              im.addEventListener("error", res, { once: true });
            });
          })),
          new Promise(function (res) { setTimeout(res, 1200); }),
        ]).then(function () {
          if (PV !== wrap) return;                 // 预览已被关掉又重开，别动新的那份
          refit();
        });
        wrap.querySelector("#pv-close").addEventListener("click", closePreview);
        wrap.querySelector("#pv-print").addEventListener("click", function () { window.print(); });
        window.addEventListener("keydown", onPvKey);
        PV = wrap;
      }

      function closePreview() {
        window.removeEventListener("keydown", onPvKey);
        if (!PV) return;
        var w = PV;
        PV = null;
        if (w.parentNode) w.parentNode.removeChild(w);
        document.body.classList.remove("pv-open");
      }

      function togglePreview() { PV ? closePreview() : buildPreview(); }

      /* ------------------------------------------------------------ 拖拽（原生 DnD，不引第三方库）
         题目卡片和板块把手各拖各的，用 DRAG.kind 分目标。 */
      function gitems(grid) {
        return [].slice.call(grid.querySelectorAll(".gitem[data-qid]"));
      }

      /* 只清"落点提示"这一类临时标记 —— .dragging 是「正在被拖的那张卡」，
         拖的过程中要一直保持半透明，别跟着一起清掉（否则看不出在拖哪一道）。 */
      function clearDropMarks() {
        [].forEach.call(
          host.querySelectorAll(".drop-before, .drop-after, .drop-hot"),
          function (e) {
            e.classList.remove("drop-before");
            e.classList.remove("drop-after");
            e.classList.remove("drop-hot");
          });
      }

      /* 落点：按阅读顺序（先上下行、再左右列）找第一个「指针还在它前半」的题。
         卷面是多列 grid，用矩形几何判断比单纯数 DOM 顺序准得多。
         注意：卷面可能被 CSS transform: scale 缩放过（组卷台为了塞进半屏做等比缩放），
         但 getBoundingClientRect 与 clientX/Y 都是缩放后的视觉坐标，两边口径一致。 */
      function dropIndex(grid, x, y) {
        var items = gitems(grid);
        for (var i = 0; i < items.length; i++) {
          var r = items[i].getBoundingClientRect();
          if (y < r.top) return i;
          if (y <= r.bottom && x < r.left + r.width / 2) return i;
        }
        return items.length;
      }

      /* 分页会把一个板块拆到两页上（两个 .grid-sec 共用一个 data-si），
         所以网格里的下标要加上 data-qbase 才是它在**整段板块**里的位置。 */
      function gridBase(grid) { return Number(grid.getAttribute("data-qbase") || 0); }

      function markDrop(grid, idx) {
        var items = gitems(grid);
        if (!items.length) return;
        if (idx >= items.length) items[items.length - 1].classList.add("drop-after");
        else items[idx].classList.add("drop-before");
      }

      /* 卷面上的一切编辑都从这里收口：拖拽 + 就地按钮 + 标题输入。
         事件委托挂在 host 上（卷面会被反复重画，绑在元素上会跟着一起没）。 */
      host.addEventListener("dragstart", function (ev) {
        if (!LAY.open) return;
        /* 从插图手柄上按下时别把整张卡片当成拖拽源（手柄是改大小的，不是挪题的） */
        if (ev.target.closest && ev.target.closest(".figh")) { ev.preventDefault(); return; }
        ensureManual();
        var grip = ev.target.closest(".sec-grip");
        if (grip) {
          var se = grip.closest(".sec-edit");
          DRAG = { kind: "s", si: Number(se.dataset.si) };
          se.classList.add("dragging");
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", "section");
          ev.dataTransfer.setDragImage(se, 24, 12);
          return;
        }
        var it = ev.target.closest(".gitem[data-qid]");
        if (it && it.dataset.si !== undefined) {
          DRAG = { kind: "q", si: Number(it.dataset.si), qi: Number(it.dataset.qi) };
          it.classList.add("dragging");
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", "question");
        }
      });

      host.addEventListener("dragover", function (ev) {
        if (!DRAG) return;
        ev.preventDefault();                     // 不 preventDefault 就不会有 drop
        ev.dataTransfer.dropEffect = "move";
        if (DRAG.kind === "q") {
          var grid = ev.target.closest(".grid-sec");
          if (!grid) return;
          clearDropMarks();
          grid.classList.add("drop-hot");
          markDrop(grid, dropIndex(grid, ev.clientX, ev.clientY));
        } else {
          clearDropMarks();
          var se = ev.target.closest(".sec-edit");
          if (se) se.classList.add("drop-hot");
        }
      });

      host.addEventListener("drop", function (ev) {
        if (!DRAG) return;
        ev.preventDefault();
        var d = DRAG;
        DRAG = null;                              // 落点要在重画之前算
        if (d.kind === "q") {
          var grid = ev.target.closest(".grid-sec");
          if (!grid) return;
          moveQ(d.si, d.qi, Number(grid.dataset.si),
            gridBase(grid) + dropIndex(grid, ev.clientX, ev.clientY));
        } else {
          var se = ev.target.closest(".sec-edit");
          if (!se) return;
          moveSec(d.si, Number(se.dataset.si));
        }
      });

      host.addEventListener("dragend", function () {
        clearDropMarks();
        [].forEach.call(host.querySelectorAll(".dragging"),
          function (e) { e.classList.remove("dragging"); });
        DRAG = null;
      });

      host.addEventListener("click", function (ev) {
        if (!LAY.open) return;
        /* 图下说明的开关：先于题目卡片的按钮分发拦下来，别当成 qAction 丢掉 */
        var cb = ev.target.closest(".figcapbtn");
        if (cb) {
          var cit = cb.closest(".gitem[data-qid]");
          if (cit) {
            ev.preventDefault();
            ev.stopPropagation();
            return toggleFigCap(Number(cit.dataset.qid), Number(cb.dataset.fi));
          }
        }
        var mi = ev.target.closest(".qmenu .qmi");
        if (mi) { ev.preventDefault(); return setBucket(mi.dataset.qid, mi.dataset.t); }
        var b = ev.target.closest("button");
        var it = b && b.closest(".gitem[data-qid]");
        var sameMenu = TYPE_MENU && it && TYPE_MENU.parentNode === it;   // 点同一个再点一下 = 收起
        if (!ev.target.closest(".qmenu")) closeTypeMenu();
        if (!b || b.disabled) return;
        if (it && it.dataset.si !== undefined) {
          if (b.dataset.act === "qtype") return sameMenu ? undefined : openTypeMenu(it, Number(it.dataset.qid));
          return qAction(Number(it.dataset.si), Number(it.dataset.qi), b.dataset.act);
        }
        if (b.dataset.sec === undefined || b.dataset.sec === "") return;
        var si = Number(b.dataset.sec);
        if (b.dataset.act === "scols") return secCols(si, Number(b.dataset.set));
        return secAction(si, b.dataset.act);
      });

      /* 标题就地改：此刻卷面上显示的就是这个输入框本身，所以不必重画（重画会丢焦点），
         只更新数据 + 打「未保存」标记。 */
      host.addEventListener("input", function (ev) {
        var t = ev.target;
        if (!t.classList || !t.classList.contains("sec-tinp")) return;
        ensureManual();
        var s = LAY.manual[Number(t.dataset.title)];
        if (!s) return;
        s.title = t.value;
        markDirty();
      });

      if (bar) {
        bar.addEventListener("click", function (ev) {
          var b = ev.target.closest("button");
          if (!b || b.disabled) return;
          var act = btnKey(b.id || "");
          if (!act) return;
          if (act === "numbering") return toggleNoPanel();
          if (act === "preview") return togglePreview();
          if (opts.onAction) opts.onAction(act);
        });
      }

      window.addEventListener("beforeunload", function (ev) {
        if (!LAY.dirty) return;
        ev.preventDefault();
        ev.returnValue = "";                     // 改了没存就关页面，浏览器会拦一下
      });

      /* ------------------------------------------------------------ 对外接口 */
      function dropQuestion(id) {
        LAY.qs = LAY.qs.filter(function (q) { return Number(q.id) !== id; });
        delete LAY.byId[id];
        if (LAY.manual) {
          LAY.manual.forEach(function (s) {
            s.ids = (s.ids || []).filter(function (i) { return Number(i) !== id; });
          });
        }
      }

      var api = {
        /* 题目池 */
        setQuestions: function (list) {
          LAY.qs = (list || []).slice();
          LAY.byId = {};
          LAY.qs.forEach(function (q) { LAY.byId[Number(q.id)] = q; });
        },
        addQuestion: function (q) {
          if (!q || LAY.byId[Number(q.id)]) return;
          LAY.qs.push(q);
          LAY.byId[Number(q.id)] = q;
        },
        removeQuestion: function (id) {
          dropQuestion(Number(id));
          markDirty();
          draw();
        },
        hasQuestion: function (id) { return !!LAY.byId[Number(id)]; },

        /* 排版数据 */
        setManual: function (m) { LAY.manual = m || null; },
        manual: function () { return LAY.manual; },
        clearManual: function () { LAY.manual = null; },
        ensureManual: ensureManual,
        setNo: function (o) { Sheet.setNo(o); },
        no: function () { return Sheet.getNo(); },
        /* 手动改过的题型（layout.types = {题目id: 桶}）：驱动"这道题进哪个板块" */
        setTypes: function (o) {
          LAY.types = {};
          if (o) Object.keys(o).forEach(function (k) { LAY.types[k] = Sheet.normBucket(o[k]); });
          Sheet.setBuckets(LAY.types);
          return LAY.types;
        },
        types: function () { return LAY.types; },
        /* 题内插图的宽度（layout.figs = {题目id: mm}）：驱动"这张图排多大" */
        setFigW: function (o) {
          LAY.figw = {};
          if (o) Object.keys(o).forEach(function (k) { var w = Sheet.clampFigW(o[k]); if (w) LAY.figw[k] = w; });
          Sheet.setFigW(LAY.figw);
          return LAY.figw;
        },
        figws: function () { return LAY.figw; },
        /* 图下说明的移除名单（layout.caps = {题目id: [图序号…]}）：驱动"这行说明印不印" */
        setCaps: function (o) {
          LAY.caps = {};
          if (o) Object.keys(o).forEach(function (k) {
            var a = o[k];
            if (!a || !a.length) return;
            LAY.caps[k] = [].slice.call(a).map(Number)
              .filter(function (n) { return n >= 0; })
              .sort(function (x, y) { return x - y; });
          });
          Sheet.setCaps(LAY.caps);
          return LAY.caps;
        },
        caps: function () { return LAY.caps; },

        /* 编辑态 */
        setOpen: function (b) {
          LAY.open = !!b;
          if (LAY.open) ensureManual();
          draw();
        },
        isOpen: function () { return LAY.open; },

        /* 画 */
        draw: draw,
        secs: curSecs,

        /* 打印预览（排版态随时看 A4 成品；从外面也能关） */
        preview: togglePreview,
        closePreview: closePreview,

        /* 打「未保存」/ 清「未保存」 */
        markDirty: markDirty,
        setDirty: function (b) {
          LAY.dirty = !!b;
          renderBar();
          if (opts.onDirtyChange) opts.onDirtyChange(LAY.dirty);
        },
        isDirty: function () { return LAY.dirty; },

        /* 当前排版 -> 可直接写进 custom_papers.layout 的对象 */
        snapshot: function () {
          var out = { numbering: Sheet.getNo() };
          if (Object.keys(LAY.types).length) out.types = LAY.types;
          if (Object.keys(LAY.figw).length) out.figs = LAY.figw;
          if (Object.keys(LAY.caps).length) out.caps = LAY.caps;
          if (LAY.manual) {
            out.sections = LAY.manual.map(function (s) {
              var title = AUTO_NO ? Sheet.stripSecNo(s.title) : String(s.title == null ? "" : s.title);
              var row = { title: title, type: s.type || "",
                          cols: Sheet.clampCols(s.cols),
                          ids: (s.ids || []).map(Number).filter(function (i) { return !!LAY.byId[i]; }) };
              /* smallNo 只在明确设过时才写；没写 = 跟题型默认走（计算题不印） */
              if (s.smallNo === true || s.smallNo === false) row.smallNo = s.smallNo;
              return row;
            });
          }
          return out;
        },
      };
      return api;
    },
  };
})();

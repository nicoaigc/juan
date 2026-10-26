/* 云服务数据层：SDK 初始化 + 登录 + 云端读写。
   所有页面共用这一个文件，**不要**在页面里重新 createWorkBuddyCloud（一个应用一个客户端）。

   SDK 来自 jsvendor/workbuddy-cloud-sdk.js（IIFE，挂 window.WorkBuddyCloud）。
   注意：它必须等脚本加载完再调用，所以本文件在所有 <script> 之后执行。 */
(function () {
  "use strict";

  /* 本地演示模式（js/local-demo.js 已把内存版 CloudAPI 挂好了）：这里不干活。
     判定只在「本机 hostname」成立，线上恒为 undefined，零影响。 */
  if (window.__LOCAL_DEMO__) return;

  var cfg = window.PUBLIC_CONFIG;
  if (!cfg) throw new Error("缺少 js/config.js 里的 PUBLIC_CONFIG");
  if (!window.WorkBuddyCloud) throw new Error("云 SDK 未加载（js/vendor/workbuddy-cloud-sdk.js）");

  var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,                 // 必填，且只能来自 publicConfig
    oauthRelayBaseUrl: cfg.oauthRelayBaseUrl, // 必填：不带它微信登录会在运行时报错
    publishableKey: cfg.publishableKey,
  });

  // ------------------------------------------------------------- 小工具
  function unwrap(res, what) {
    if (res && res.error) throw new Error((res.error.message || "请求失败") + (what ? "（" + what + "）" : ""));
    return res ? res.data : null;
  }

  var UID = null;          // 当前登录用户 id（auth.uid()）
  var urlCache = {};       // storage_path -> {url, at}；签名 URL 最长 1 小时，缓存 50 分钟

  // ------------------------------------------------------------- 会话
  function session() {
    return cloud.auth.getSession().then(function (res) { return res && res.data ? res.data : null; });
  }

  function currentUser() {
    return session().then(function (s) {
      if (!s) { UID = null; return null; }
      UID = (s.user && (s.user.id || s.user.sub)) || s.user_id || null;
      return s.user || { id: UID };
    });
  }

  function displayName(u) {
    if (!u) return "";
    if (u.name) return u.name;
    if (u.phoneNumber) return String(u.phoneNumber).replace(/^(\+?86)?(\d{3})\d{4}(\d{4})$/, "$1$2****$3");
    if (u.email) return String(u.email);
    return u.id ? "用户 " + String(u.id).slice(0, 6) : "已登录";
  }

  // ------------------------------------------------------------- 登录
  var pendingOtp = null;   // { phone, verificationId, isExistingUser }

  function sendPhoneCode(phone) {
    return cloud.auth.sendOtp({ phone: phone }).then(function (res) {
      if (res.error) throw new Error(res.error.message || "验证码发送失败");
      pendingOtp = { phone: phone, verificationId: res.data.verificationId, isExistingUser: res.data.isExistingUser };
      return pendingOtp;
    });
  }

  function verifyPhone(code) {
    if (!pendingOtp) throw new Error("请先获取验证码");
    return cloud.auth.verifyOtp({
      phone: pendingOtp.phone,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token: code,
    }).then(function (res) {
      if (res.error) throw new Error(res.error.message || "验证码不正确");
      pendingOtp = null;
      UID = (res.data.user && res.data.user.id) || null;
      return res.data;
    });
  }

  function signInWechat() {
    return cloud.auth.signInWithOAuth({ provider: "wechat", redirectTo: location.origin }).then(function (res) {
      if (res.error) throw new Error(res.error.message || "微信登录未开启或不可用");
      location.assign(res.data.url);   // 不自己跳转，SDK 返回要去哪儿
    });
  }

  /* 微信回调：**必须在任何路由守卫之前**无条件调用一次。
     返回 session 表示刚登录成功（要把 URL 上的 code/state 抹掉，否则刷新会重放已用过的 code）。 */
  function handleWechatCallback() {
    if (!cloud.auth.handleWechatWebCallback) return Promise.resolve(null);
    return cloud.auth.handleWechatWebCallback().then(function (res) {
      if (res && res.error) return { error: res.error };
      if (res && res.data) {
        history.replaceState(null, "", location.pathname + location.search.replace(/[?&](code|state|provider_id)=[^&]*/g, "").replace(/^\?$/, ""));
        return { session: res.data };
      }
      return null;   // URL 里没有 code：普通访问，不是错误
    }).catch(function (e) { return { error: e }; });
  }

  function signOut() { UID = null; urlCache = {}; return cloud.auth.signOut(); }

  // ------------------------------------------------------------- 识别次数
  /* 免费识别次数：一次整卷识别、一次单页重扫各算一次。计数存在云端 recognition_usage，
     客户端只能读，扣减只走 SECURITY DEFINER 函数 —— 所以删卷、换设备、清缓存都刷不回来。
     本地演示模式另有一套（默认不限，见 local-demo.js）。 */
  var REPO_URL = "https://github.com/nicoaigc/juan";
  var OUT_OF_QUOTA = "免费识别次数已用完。建议自行部署后继续使用：" + REPO_URL;

  function quotaShape(row) {
    var r = row || {};
    if (r.quota == null) return { used: 0, quota: null, remain: null };
    return { used: Number(r.used) || 0, quota: Number(r.quota), remain: Number(r.remain) || 0 };
  }

  function recognitionQuota() {
    return cloud.database.rpc("app_recognition_quota").then(function (r) {
      var rows = unwrap(r, "读取识别次数");
      return quotaShape(Array.isArray(rows) ? rows[0] : rows);
    });
  }

  function consumeRecognition() {
    return cloud.database.rpc("app_consume_recognition").then(function (r) {
      var rows = unwrap(r, "记录识别次数");
      return quotaShape(Array.isArray(rows) ? rows[0] : rows);
    }).catch(function (e) {
      if (/已用完|quota|exhaust/i.test(String((e && e.message) || ""))) throw new Error(OUT_OF_QUOTA);
      throw e;
    });
  }

  // ------------------------------------------------------------- 数据库
  function listPapers() {
    return cloud.database.from("papers").select("*")
      .order("paper_date", { ascending: false }).order("id", { ascending: false })
      .then(function (r) { return unwrap(r, "读取试卷") || []; });
  }

  function getPaper(id) {
    return cloud.database.from("papers").select("*").eq("id", id).maybeSingle()
      .then(function (r) { return unwrap(r, "读取试卷"); });
  }

  function createPaper(row) {
    return cloud.database.from("papers").insert(row).select()
      .then(function (r) {
        var rows = unwrap(r, "创建试卷");
        if (!rows || !rows.length) throw new Error("创建试卷没有返回记录（可能是登录已过期）");
        return rows[0];
      });
  }

  function updatePaper(id, patch) {
    patch.updated_at = new Date().toISOString();
    return cloud.database.from("papers").update(patch).eq("id", id).select()
      .then(function (r) {
        var rows = unwrap(r, "更新试卷");
        if (!rows || !rows.length) throw new Error("没有改到任何记录：试卷不存在或不属于当前账号");
        return rows[0];
      });
  }

  function deletePaper(id) {
    return cloud.database.from("papers").delete().eq("id", id).select()
      .then(function (r) {
        var rows = unwrap(r, "删除试卷");
        if (!rows || !rows.length) throw new Error("没有删到记录：试卷不存在或不属于当前账号");
        return rows[0];
      });
  }

  function listFiles(paperId) {
    return cloud.database.from("paper_files").select("*").eq("paper_id", paperId)
      .order("page_no", { ascending: true }).order("id", { ascending: true })
      .then(function (r) { return unwrap(r, "读取原图记录") || []; });
  }

  function addFile(row) {
    return cloud.database.from("paper_files").insert(row).select()
      .then(function (r) {
        var rows = unwrap(r, "登记原图");
        if (!rows || !rows.length) throw new Error("原图记录没有写入成功");
        return rows[0];
      });
  }

  function addFiles(rows) {
    if (!rows || !rows.length) return Promise.resolve(true);
    return cloud.database.from("paper_files").insert(rows).select()
      .then(function (r) { unwrap(r, "批量登记原图"); return true; });
  }

  function addQuestions(rows) {
    if (!rows || !rows.length) return Promise.resolve(true);
    return insertQuestions(rows).then(function () { return true; });
  }

  /* 批量插入并把**落库后的行**（带 id/seq）返回。单页重扫要把新题的 id 接回
     顺序表里，所以不能像 addQuestions 那样把结果丢掉。 */
  function insertQuestions(rows) {
    if (!rows || !rows.length) return Promise.resolve([]);
    return cloud.database.from("questions").insert(rows).select()
      .then(function (r) { return unwrap(r, "批量写入题目") || []; });
  }

  function removeFileRow(id) {
    return cloud.database.from("paper_files").delete().eq("id", id).select()
      .then(function (r) { return unwrap(r, "删除原图记录"); });
  }

  function listQuestions(paperId) {
    var PAGE = 1000;   // 单次上限；正常一份卷几十题，够用
    return cloud.database.from("questions").select("*").eq("paper_id", paperId)
      .order("seq", { ascending: true }).limit(PAGE)
      .then(function (r) { return unwrap(r, "读取题目") || []; });
  }

  function getQuestion(id) {
    return cloud.database.from("questions").select("*").eq("id", id).maybeSingle()
      .then(function (r) { return unwrap(r, "读取题目"); });
  }

  /* 题库级字段修正（题型手动打标等）。patch 是顶层列的浅合并 —— 打标走
     { source: <合并后的完整 source 对象> }（jsonb 整列替换，调用方先读旧值合并好再传）。
     RLS 的 owner_all 策略含 UPDATE，只能改到自己的题。 */
  function updateQuestion(id, patch) {
    return cloud.database.from("questions").update(patch).eq("id", id).select()
      .then(function (r) {
        var rows = unwrap(r, "更新题目");
        if (!rows || !rows.length) throw new Error("题目更新没有生效");
        return rows[0];
      });
  }

  /* 清掉一卷的全部题目（重新识别时用）。云端没有"按条件删除"以外的批量口子，
     这里就是按 paper_id 删——RLS 保证只能删到自己的。 */
  function deleteQuestions(paperId) {
    return cloud.database.from("questions").delete().eq("paper_id", paperId).select()
      .then(function (r) { return (unwrap(r, "清除旧题目") || []).length; });
  }

  /* ---- 按「页」操作（单页重扫用 --------------------------------------------------
     一页一道题存了 source.page（第几页）与 source.file（哪张图）。
     **先按 file 精确匹配**，匹配不到才退回按 page —— 老数据里 page_no 可能重复
     （演示库里就有一卷 3 张图都是"第 1 页"），只按 page 会把别的照片的题一起圈进来。 */
  function pageRowsOf(rows, page, filename) {
    var all = rows || [];
    if (filename) {
      var byFile = all.filter(function (q) {
        return String((q.source || {}).file || "") === String(filename);
      });
      if (byFile.length) return byFile;
    }
    return all.filter(function (q) {
      var s = q.source || {};
      if (s.page == null || s.page === "") return false;
      return Number(s.page) === Number(page);
    });
  }

  /* 按 id 逐条删题。云端没有"按 jsonb 路径删除"的口子，只能先筛出 id 再删。
     ⚠️ 调用方必须传**改动前就抓到的那批 id**（单页重扫是"先插新题、再删旧题"，
        此刻按条件重查会把刚插进去的新题也一起查出来删掉）。 */
  function deleteQuestionsByIds(ids) {
    var list = (ids || []).filter(function (id) { return id != null; });
    if (!list.length) return Promise.resolve(0);
    var chain = Promise.resolve();
    list.forEach(function (id) {
      chain = chain.then(function () {
        return cloud.database.from("questions").delete().eq("id", id).select()
          .then(function (r) { return (unwrap(r, "清除这一页的旧题") || []).length; });
      });
    });
    return chain.then(function () { return list.length; });
  }

  /* 重排一卷题目的 seq（它是**顺序依据**：列表、打印、组卷都按它排）。
     pairs: [{id, cur, seq}]，只写真的变了的行。
     本机实测过写操作会偶发不生效（见 memory），所以每行回读校验 + 重试一次。 */
  function setQuestionSeqs(pairs) {
    var todo = (pairs || []).filter(function (p) { return Number(p.cur) !== Number(p.seq); });
    if (!todo.length) return Promise.resolve(0);
    function one(p, retry) {
      return cloud.database.from("questions").update({ seq: p.seq }).eq("id", p.id).select()
        .then(function (r) {
          var rows = unwrap(r, "重排题号");
          if (!rows || !rows.length) throw new Error("第 " + p.seq + " 题的重排没有生效");
          return true;
        })
        .catch(function (e) {
          if (retry) return one(p, false);      // 偶发不生效：原样重试一次
          throw e;
        });
    }
    var chain = Promise.resolve(), n = 0;
    todo.forEach(function (p) {
      chain = chain.then(function () { return one(p, true).then(function () { n += 1; }); });
    });
    return chain.then(function () { return n; });
  }

  // ------------------------------------------------------------- 重新识别前的自动备份
  /* 重扫是"重掷骰子"：文字、坐标、题目切分都会变，原来对的可能被换成错的
     （2026-10-11 paper6 实测：同一张图、同一模型调两次，错的题完全不重合）。
     所以点「重新识别」前先把这卷现有题目整份存下来，不满意可以一键恢复。
     表 question_backups，RLS 与其它表同口径（本人 + 已开通）。 */
  var BACKUP_KEEP = 5;    // 每卷最多留 5 份，超出自动清最旧的

  function fmtStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function backupQuestions(paperId, rows, reason) {
    rows = rows || [];
    if (!rows.length) return Promise.resolve(null);
    return cloud.database.from("question_backups")
      .insert({ paper_id: paperId, reason: String(reason || ""), q_count: rows.length, payload: rows })
      .select()
      .then(function (r) {
        var got = unwrap(r, "备份旧题");
        var row = (got && got[0]) || null;
        return pruneBackups(paperId).then(function () { return row; });
      });
  }

  /* 列表只取几列 —— payload 是整卷快照，列表带着就要白传几十 KB × N。 */
  function listBackups(paperId) {
    return cloud.database.from("question_backups")
      .select("id,paper_id,created_at,reason,q_count")
      .eq("paper_id", paperId).order("created_at", { ascending: false }).limit(20)
      .then(function (r) { return unwrap(r, "读取备份") || []; });
  }

  function pruneBackups(paperId) {
    return listBackups(paperId).then(function (rows) {
      var old = rows.slice(BACKUP_KEEP);
      if (!old.length) return 0;
      return Promise.all(old.map(function (b) {
        return cloud.database.from("question_backups").delete().eq("id", b.id)
          .then(function (r) { unwrap(r, ""); return true; })
          .catch(function () { return false; });    // 清理失败不打扰用户
      })).then(function () { return old.length; });
    });
  }

  function deleteBackup(id) {
    return cloud.database.from("question_backups").delete().eq("id", id).select()
      .then(function (r) { return (unwrap(r, "删除备份") || []).length; });
  }

  /* 恢复一份备份。**按 seq 原地改**，不删重建：
     questions.id 是 GENERATED ALWAYS（不接受显式插 id），删了重建会拿到新 id ——
     自建卷的 question_ids 引用、question.html?id=… 的链接就全断了。
     所以：备份里有、现在也有的 seq → 逐列 UPDATE（id 不变）；
     题数变了才会走到补/删那两条（重扫极少改变题数）。 */
  var RESTORE_NULLABLE = ["qno", "printed_no", "section", "qtype"];    // 可空列：null 也要写回去
  var RESTORE_REQUIRED = ["stem", "options", "source", "confidence"];  // 非空列：只在有值时写

  function restoreQuestions(backupId, onProgress) {
    var say = onProgress || function () {};
    return cloud.database.from("question_backups").select("*").eq("id", backupId).maybeSingle()
      .then(function (r) { return unwrap(r, "读取备份"); })
      .then(function (bak) {
        if (!bak) throw new Error("这份备份已经不在了");
        var rows = Array.isArray(bak.payload) ? bak.payload : [];
        if (!rows.length) throw new Error("这份备份是空的");
        return listQuestions(bak.paper_id).then(function (cur) {
          var bySeq = {};
          cur.forEach(function (q) { bySeq[String(q.seq)] = q; });
          var stat = { updated: 0, inserted: 0, removed: 0 };
          var chain = Promise.resolve();

          rows.forEach(function (b, i) {
            chain = chain.then(function () {
              var patch = {};
              RESTORE_NULLABLE.forEach(function (k) { if (k in b) patch[k] = b[k]; });
              RESTORE_REQUIRED.forEach(function (k) { if (b[k] != null) patch[k] = b[k]; });
              var old = bySeq[String(b.seq)];
              if (old) {
                delete bySeq[String(b.seq)];
                say(i + 1, rows.length);
                return updateQuestion(old.id, patch).then(function () { stat.updated++; });
              }
              return addQuestions([Object.assign({ paper_id: bak.paper_id, seq: b.seq }, patch)])
                .then(function () { stat.inserted++; });
            });
          });

          Object.keys(bySeq).forEach(function (k) {
            var q = bySeq[k];
            chain = chain.then(function () {
              return cloud.database.from("questions").delete().eq("id", q.id).select()
                .then(function (r) { unwrap(r, "删除多余题目"); stat.removed++; });
            });
          });

          return chain.then(function () {
            return updatePaper(bak.paper_id, {
              question_count: rows.length, status: "done",
              status_note: "已恢复到 " + fmtStamp(bak.created_at) + " 的备份（" + rows.length + " 题）",
            });
          }).then(function () { return stat; });
        });
      });
  }

  /* 题库全量（跨卷）：组卷选题、自建卷取题都用它。
     之所以不按 id 批量查（`.in()`），是因为打包进来的 SDK 是压缩版、没有把握
     `.in()` 一定可用；题库总量就几百题，一次取回来在前端过滤最省事也最快。 */
  function listAllQuestions() {
    var PAGE = 3000;
    return cloud.database.from("questions").select("*")
      .order("paper_id", { ascending: true }).order("seq", { ascending: true })
      .limit(PAGE)
      .then(function (r) { return unwrap(r, "读取题库") || []; });
  }

  /* 原图记录全量：自建卷的题来自多份卷，渲染插图时要按 paper_id 找到对应的原图。 */
  function listAllFiles() {
    var PAGE = 3000;
    return cloud.database.from("paper_files").select("*")
      .order("paper_id", { ascending: true }).order("page_no", { ascending: true })
      .limit(PAGE)
      .then(function (r) { return unwrap(r, "读取原图记录") || []; });
  }

  // ------------------------------------------------------------- 自建卷（手动组卷）
  /* 从已识别的题库里挑题排成一份新卷。question_ids 是**有序**的题目 id 数组，
     顺序就是卷面顺序；题目本身仍存在 questions 表里，这里只存引用（不复制），
     所以原题改动/重识别会直接反映到自建卷上 —— 这正是我们要的。 */
  function listCustomPapers() {
    return cloud.database.from("custom_papers").select("*")
      .order("updated_at", { ascending: false })
      .then(function (r) { return unwrap(r, "读取自建卷") || []; });
  }

  function getCustomPaper(id) {
    return cloud.database.from("custom_papers").select("*").eq("id", id).maybeSingle()
      .then(function (r) { return unwrap(r, "读取自建卷"); });
  }

  function createCustomPaper(row) {
    return cloud.database.from("custom_papers").insert(row).select()
      .then(function (r) {
        var rows = unwrap(r, "创建自建卷");
        if (!rows || !rows.length) throw new Error("创建没有返回记录（可能是登录已过期）");
        return rows[0];
      });
  }

  function updateCustomPaper(id, patch) {
    patch.updated_at = new Date().toISOString();
    return cloud.database.from("custom_papers").update(patch).eq("id", id).select()
      .then(function (r) {
        var rows = unwrap(r, "保存自建卷");
        if (!rows || !rows.length) throw new Error("没有保存到：这份卷不存在或不属于当前账号");
        return rows[0];
      });
  }

  function deleteCustomPaper(id) {
    return cloud.database.from("custom_papers").delete().eq("id", id).select()
      .then(function (r) {
        var rows = unwrap(r, "删除自建卷");
        if (!rows || !rows.length) throw new Error("没有删到记录：这份卷不存在或不属于当前账号");
        return rows[0];
      });
  }

  // ------------------------------------------------------------- 存储
  function photoPath(rel) {
    if (!UID) throw new Error("登录状态已失效，请重新登录");
    return cloud.storage.userPath(UID, rel);
  }

  function safeName(name) {
    // 只保留安全字符；服务端也会再校验一遍，这里是为了路径好看且稳定
    var base = String(name || "photo").replace(/[^\w.\-]+/g, "_").slice(-60);
    return base || "photo.jpg";
  }

  function imageSize(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
      img.src = url;
    });
  }

  /* 上传一张试卷照片 -> 云端 + 登记 paper_files 行（含像素尺寸，网页端裁图要用）。 */
  function uploadPhoto(paperId, file, pageNo) {
    var path = photoPath("papers/" + paperId + "/p" + pageNo + "-" + Date.now() + "-" + safeName(file.name));
    return imageSize(file).then(function (dim) {
      return cloud.storage.upload(path, file, { contentType: file.type || "image/jpeg", upsert: false })
        .then(function (res) {
          if (res && res.error) throw new Error(res.error.message || "上传失败");
          return addFile({
            paper_id: paperId, page_no: pageNo, filename: file.name || safeName(file.name),
            storage_path: path, width: dim.w, height: dim.h, size_bytes: file.size || 0,
          });
        });
    });
  }

  function removePhoto(path) {
    return cloud.storage.remove([path]).catch(function () { /* 记录删掉即可，文件残留不影响使用 */ });
  }

  /* 把已上传的照片从云端下载回 File（「重新识别免重传」用）。
     走 SDK 的 download()：请求发往**与应用同源**的 /.cloud/storage 通道、自带鉴权头，
     所以既没有跨域问题、也不会污染 canvas —— 以前"必须重传照片"的顾虑（签名地址不带
     CORS 头）不适用于这条通道。失败时抛错，调用方提示用户改走「重传照片」。 */
  function downloadPhoto(path, filename) {
    if (!path) return Promise.reject(new Error("这条记录没有云端照片"));
    return cloud.storage.download(path).then(function (res) {
      if (res && res.error) throw new Error(res.error.message || "照片取回失败");
      var blob = res.data;
      if (!blob) throw new Error("照片取回失败（云端没有内容）");
      return new File([blob], filename || "photo.jpg",
                      { type: blob.type || "image/jpeg" });
    });
  }

  /* 签一个短时下载地址（最长 1 小时）。同一路径缓存 50 分钟，避免列表里反复签。 */
  function signedUrl(path) {
    if (!path) return Promise.resolve("");
    // `local:` = 随应用一起打包的演示原图（见 app/assets/benchmark/），直接当静态文件用，不签
    if (path.indexOf("local:") === 0) return Promise.resolve(path.slice(6));
    var hit = urlCache[path];
    if (hit && Date.now() - hit.at < 50 * 60 * 1000) return Promise.resolve(hit.url);
    return cloud.storage.createSignedUrl(path, 3600).then(function (res) {
      if (res && res.error) throw new Error(res.error.message || "无法获取原图地址");
      var url = (res.data && (res.data.signedUrl || res.data.url || res.data)) || "";
      urlCache[path] = { url: url, at: Date.now() };
      return url;
    });
  }

  window.CloudAPI = {
    cloud: cloud,
    unwrap: unwrap,
    session: session,
    currentUser: currentUser,
    displayName: displayName,
    uid: function () { return UID; },
    sendPhoneCode: sendPhoneCode,
    verifyPhone: verifyPhone,
    signInWechat: signInWechat,
    handleWechatCallback: handleWechatCallback,
    signOut: signOut,
    onAuthChange: function (cb) { return cloud.auth.onAuthStateChange(cb); },
    recognitionQuota: recognitionQuota,
    consumeRecognition: consumeRecognition,
    listPapers: listPapers,
    getPaper: getPaper,
    createPaper: createPaper,
    updatePaper: updatePaper,
    deletePaper: deletePaper,
    listFiles: listFiles,
    addFile: addFile,
    addFiles: addFiles,
    addQuestions: addQuestions,
    insertQuestions: insertQuestions,
    removeFileRow: removeFileRow,
    listQuestions: listQuestions,
    getQuestion: getQuestion,
    updateQuestion: updateQuestion,
    deleteQuestions: deleteQuestions,
    pageRowsOf: pageRowsOf,
    deleteQuestionsByIds: deleteQuestionsByIds,
    setQuestionSeqs: setQuestionSeqs,
    backupQuestions: backupQuestions,
    listBackups: listBackups,
    restoreQuestions: restoreQuestions,
    deleteBackup: deleteBackup,
    fmtStamp: fmtStamp,
    listAllQuestions: listAllQuestions,
    listAllFiles: listAllFiles,
    listCustomPapers: listCustomPapers,
    getCustomPaper: getCustomPaper,
    createCustomPaper: createCustomPaper,
    updateCustomPaper: updateCustomPaper,
    deleteCustomPaper: deleteCustomPaper,
    uploadPhoto: uploadPhoto,
    downloadPhoto: downloadPhoto,
    removePhoto: removePhoto,
    signedUrl: signedUrl,
  };
})();

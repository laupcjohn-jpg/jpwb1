/* =========================================================
 * app.js —— 界面逻辑
 *  负责：视图路由、单词表单、分类查看（含统计）、测验流程、
 *        导入/导出、编辑/删除。
 * ========================================================= */
(function () {
  'use strict';

  /* ---------- 工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 过长文本截断（确认框里用，避免整句撑满弹窗） */
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* 语句条目（只输入句子）与普通单词共用同一份数据，靠 type 区分 */
  function isSentence(w) { return !!w && w.type === 'sentence'; }

  /* 动词类分类（一类/二类/三类动词，或自建的「××动词」）才显示「自他」这一列 */
  function isVerbPos(pos) {
    return /动词|動詞/.test(String(pos == null ? '' : pos));
  }

  /* ---------- 测验会话状态 ---------- */
  var quizState = null; // { questions, index, results[] } —— 读音 + 意思（原题型）
  var sentState = null; // { questions, index, results[] } —— AI 造句练习
  var quizMode = 'classic'; // 'classic' = 读音+意思；'sentence' = AI 造句
  /* 上一次做完的成绩。留着它，同步/重渲染时才不会把结果页顶掉；
     离开测验界面（或点「再来一次」）才清掉。 */
  var lastRun = null;
  /* 分类连做点「停止做题」时把会话存在这里：点「继续做这个分类」能接着刚才的位置，
     而不是从头再来。 */
  var pausedDrill = null;
  var aiInfo = { checked: false, ok: false, message: '未检测', model: '' }; // AI 后端探测结果
  var editId = null;    // 当前正在编辑的单词 id
  var libraryPos = null; // 当前查看的分类名，null 表示分类列表模式
  var libraryFav = false; // 单词库里正在看「收藏夹」
  var searchTerm = '';     // 已提交的检索关键词，空串表示未检索（行内不高亮）
  var searchMatches = [];  // 命中条目的 id，按词库顺序
  var searchCursor = -1;   // 最近一次跳转落在 searchMatches 的下标，回车时循环前进

  /* ---------- 收藏夹 / 出题方式（都存 localStorage） ---------- */
  var FAV_KEY = '__fav__';        // 收藏夹在出题范围里的内部标识（不会和分类名撞）
  var FAV_LABEL = '⭐ 收藏夹';
  var LS_QUIZ_STYLE = 'jpStudy.quiz.style';
  var LS_QUIZ_DRILL = 'jpStudy.quiz.drillCat';
  var LS_QUIZ_ORDER = 'jpStudy.quiz.order';
  var LS_QUIZ_AUTOFAV = 'jpStudy.quiz.autoFav';

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 存不下也不影响本次 */ }
  }

  /* 出题方式：random = 随机抽 10 题；drill = 分类连做（一直做下去） */
  function quizStyle() { return lsGet(LS_QUIZ_STYLE) === 'drill' ? 'drill' : 'random'; }
  function setQuizStyle(s) { lsSet(LS_QUIZ_STYLE, s === 'drill' ? 'drill' : 'random'); }

  /* 分类连做：按词库顺序 / 乱序 */
  function drillOrder() { return lsGet(LS_QUIZ_ORDER) === 'shuffle' ? 'shuffle' : 'seq'; }
  function setDrillOrder(o) { lsSet(LS_QUIZ_ORDER, o === 'shuffle' ? 'shuffle' : 'seq'); }

  /* 答错自动加入收藏夹（默认开） */
  function autoFavOn() { return lsGet(LS_QUIZ_AUTOFAV) !== '0'; }
  function setAutoFav(on) { lsSet(LS_QUIZ_AUTOFAV, on ? '1' : '0'); }

  function favWords() {
    return Store.all().filter(function (w) { return !isSentence(w) && w.fav; });
  }

  function drillCat() { return lsGet(LS_QUIZ_DRILL) || ''; }
  function setDrillCat(c) { lsSet(LS_QUIZ_DRILL, c || ''); }

  /* 收藏夹 / 分类里的词都可能很少，意思选项要能从整个词库里凑 */
  function wordLibrary() {
    return Store.all().filter(function (w) { return !isSentence(w); });
  }

  /* 某个分类的出题池；FAV_KEY 代表收藏夹（可以跨分类） */
  function drillPool(cat) {
    if (!cat) return [];
    if (cat === FAV_KEY) return favWords();
    return Store.all().filter(function (w) { return !isSentence(w) && w.pos === cat; });
  }


  /* ---------- 词性展示顺序：按分类表顺序，未登记的排最后 ---------- */
  function orderPosKeys(posKeys) {
    var cats = Store.categories();
    var known = cats.filter(function (c) { return posKeys.indexOf(c) >= 0; });
    var orphans = posKeys
      .filter(function (p) { return cats.indexOf(p) < 0; })
      .sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    return known.concat(orphans);
  }

  /* 用分类表填充词性下拉框；current 不在表中时临时加入，避免编辑时被改掉 */
  function renderPosSelect(sel, current) {
    if (!sel) return;
    var list = Store.categories().slice();
    if (current && list.indexOf(current) < 0) list.unshift(current);
    sel.innerHTML = list.map(function (c) {
      return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }).join('');
    if (current) sel.value = current;
  }

  function refreshPosSelects() {
    renderPosSelect($('#f-pos'));
    $('#e-pos').innerHTML = Store.categories().map(function (c) {
      return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }).join('');
  }

  /* 自他下拉：第一项是「未填写」，词条可选填（名词/形容词不填即可） */
  function renderVtSelect(sel, current) {
    if (!sel) return;
    sel.innerHTML = [''].concat(Store.VERB_TYPES).map(function (v) {
      return '<option value="' + escapeHtml(v) + '">' +
        (v ? escapeHtml(v) : '— 未填写（可选）—') + '</option>';
    }).join('');
    if (current) sel.value = current; // 不在预设里的外来值保持「未填写」
  }

  function refreshVtSelects() {
    renderVtSelect($('#f-vt'));
    renderVtSelect($('#e-vt'));
  }

  /* =========================================================
   * 视图路由
   * ========================================================= */
  function showView(name) {
    // 离开测验界面就把上次成绩收起来，下次进来是开始页
    if (name !== 'quiz') { lastRun = null; pausedDrill = null; }
    $$('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    $$('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name);
    });
    if (name === 'library') renderLibrary();
    if (name === 'quiz') renderQuizView();
    updateSidebarStats();
  }

  function updateSidebarStats() {
    $('#stat-total').textContent = Store.all().length;
  }

  /* =========================================================
   * 添加单词表单
   * ========================================================= */
  function initForm() {
    var form = $('#word-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var kanji = $('#f-kanji').value.trim();
      var kana = $('#f-kana').value.trim();
      var pos = $('#f-pos').value.trim();
      var meaning = $('#f-meaning').value.trim();
      var example = $('#f-example').value.trim();
      var verbType = $('#f-vt').value;
      var msg = $('#form-msg');

      if (!kana) { setFormMsg('请填写假名', false); return; }
      if (!pos) { setFormMsg('请填写词性', false); return; }
      if (!meaning) { setFormMsg('请填写意思', false); return; }

      try {
        Store.add({ kanji: kanji, kana: kana, pos: pos, meaning: meaning, example: example, verbType: verbType });
      } catch (err) {
        setFormMsg('保存失败：本地存储不可用', false);
        return;
      }
      setFormMsg('已保存 ✓', true);
      form.reset();
      updateSidebarStats();
      $('#f-kanji').focus();
    });
  }

  /* 表单提示：sel 缺省作用于「添加单词」表单；计时器挂在元素上，
     这样单词表单与语句表单各自的提示互不干扰 */
  function setFormMsg(text, ok, sel) {
    var msg = $(sel || '#form-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'form-msg ' + (ok ? 'is-ok' : 'is-error');
    clearTimeout(msg._t);
    msg._t = setTimeout(function () {
      msg.textContent = '';
      msg.className = 'form-msg';
    }, 3000);
  }

  function clearFormMsgs() {
    ['#form-msg', '#s-form-msg'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      clearTimeout(el._t);
      el.textContent = '';
      el.className = 'form-msg';
    });
  }

  /* ---------- 录入模式：单词 / 语句 ---------- */
  var inputMode = 'word';

  function setInputMode(mode) {
    inputMode = mode === 'sentence' ? 'sentence' : 'word';
    $$('#input-mode .mode-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === inputMode);
    });
    var isSent = inputMode === 'sentence';
    $('#word-form').hidden = isSent;
    $('#sentence-form').hidden = !isSent;
    $('#tip-word').hidden = isSent;
    $('#tip-sentence').hidden = !isSent;
    clearFormMsgs();
    (isSent ? $('#s-text') : $('#f-kanji')).focus();
  }

  function initInputMode() {
    $('#input-mode').addEventListener('click', function (e) {
      var btn = e.target.closest('.mode-btn');
      if (btn && btn.dataset.mode !== inputMode) setInputMode(btn.dataset.mode);
    });
  }

  /* ---------- 添加语句表单（只输入句子，翻译可选） ---------- */
  function saveSentence() {
    var text = $('#s-text').value.trim();
    if (!text) {
      setFormMsg('请填写句子', false, '#s-form-msg');
      $('#s-text').focus();
      return;
    }
    try {
      Store.addSentence(text, $('#s-meaning').value);
    } catch (err) {
      setFormMsg('保存失败：本地存储不可用', false, '#s-form-msg');
      return;
    }
    setFormMsg('已保存 ✓', true, '#s-form-msg');
    $('#sentence-form').reset();
    updateSidebarStats();
    $('#s-text').focus();
  }

  function initSentenceForm() {
    $('#sentence-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveSentence();
    });
    // 多行输入框里回车是换行，用 Ctrl/Cmd + Enter 提交
    $('#s-text').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveSentence();
      }
    });
  }

  /* =========================================================
   * 单词库（按词性分类）
   * ========================================================= */
  function renderLibrary() {
    var words = Store.all();
    var empty = $('#library-empty');
    var groups = $('#library-groups');
    var panel = $('.cat-panel');

    if (words.length === 0) {
      empty.style.display = 'block';
      groups.innerHTML = '';
      panel.style.display = 'none';
      libraryPos = null;
      libraryFav = false;
      return;
    }
    empty.style.display = 'none';

    if (libraryFav) {
      // 收藏夹：跨分类把收藏过的词列在一起
      panel.style.display = 'none';
      groups.innerHTML = '';
      groups.appendChild(renderFavDetail(words.filter(function (w) {
        return !isSentence(w) && w.fav;
      })));
      return;
    }

    if (libraryPos) {
      // 详情模式：只显示被点开分类的单词
      var list = words.filter(function (w) { return w.pos === libraryPos; });
      if (list.length === 0) {
        // 分类可能被改名或删光了，回退到列表
        libraryPos = null;
        renderLibrary();
        return;
      }
      panel.style.display = 'none';
      groups.innerHTML = '';
      groups.appendChild(renderDetail(libraryPos, list));
    } else {
      // 列表模式：显示分类卡片
      panel.style.display = 'block';
      groups.innerHTML = '';
      groups.appendChild(renderCategoryGrid());
    }
  }

  /* 一组条目是否全是语句：是的话表头与统计列都不该出现 */
  function allSentences(list) {
    return list.length > 0 && list.every(isSentence);
  }

  /* 统计量：语句不参与测验，也就没有「已掌握」可算 */
  function masteredCount(list) {
    return list.filter(function (w) { return !isSentence(w) && Quiz.isMastered(w); }).length;
  }

  /* 一组词在测验里的合计：出现次数 / 答对次数 / 正确率 */
  function groupStats(list) {
    var appeared = 0, correct = 0;
    list.forEach(function (w) {
      if (isSentence(w)) return;
      appeared += Number(w.stats.appeared) || 0;
      correct += Number(w.stats.correct) || 0;
    });
    return {
      appeared: appeared,
      correct: correct,
      rate: appeared ? Math.round(correct / appeared * 100) : 0
    };
  }

  function renderGroup(pos, list) {
    var mastered = masteredCount(list);
    var stat = groupStats(list);
    var sentencesOnly = allSentences(list);
    // 「自他」列只对动词类分类有意义；但该分类里已经有自他数据时（例如导入来的）
    // 也照样显示，免得数据被藏起来看不见
    var showVt = !sentencesOnly && (isVerbPos(pos) || list.some(function (w) { return !!w.verbType; }));
    // 词性不在当前分类表里（例如导入的数据或分类被改名前的残留）
    var isOrphan = Store.categories().indexOf(pos) < 0;

    var section = document.createElement('section');
    section.className = 'group card';

    var header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML =
      '<div class="group-title">' +
        '<span class="pos-badge">' + escapeHtml(pos) + '</span>' +
        (isOrphan ? '<span class="group-orphan" title="该词性不在当前分类表中，可在上方「分类管理」里添加同名分类">未登记分类</span>' : '') +
        '<span class="group-count">' + list.length + (sentencesOnly ? ' 条语句' : ' 个单词') + '</span>' +
        (mastered ? '<span class="group-mastered">已掌握 ' + mastered + '</span>' : '') +
        (stat.appeared
          ? '<span class="group-stat" title="这个分类在测验里的合计：出现次数 / 答对次数 / 正确率">测验 ' +
              stat.appeared + ' 次 · 答对 ' + stat.correct + ' · ' + stat.rate + '%</span>'
          : '') +
      '</div>';
    section.appendChild(header);

    var table = document.createElement('div');
    table.className = 'word-table' + (showVt ? ' verb-table' : '');
    // 语句没有假名/统计，整行表头都省掉
    if (!sentencesOnly) {
      table.innerHTML =
        '<div class="word-row word-row-head">' +
          '<span class="c-kanji">汉字</span>' +
          '<span class="c-kana">假名</span>' +
          (showVt ? '<span class="c-vt">自他</span>' : '') +
          '<span class="c-meaning">意思</span>' +
          '<span class="c-stat" title="这个单词在测验中被考到的次数">出现</span>' +
          '<span class="c-stat" title="测验中答对的次数（正确次数）">答对</span>' +
          '<span class="c-stat" title="答对次数 ÷ 出现次数">正确率</span>' +
          '<span class="c-actions"></span>' +
        '</div>';
    }

    list.forEach(function (w) {
      table.appendChild(renderWordRow(w, showVt));
    });
    section.appendChild(table);
    return section;
  }

  function renderCategoryGrid() {
    var words = Store.all();
    var cats = Store.categories();
    var counts = {};
    words.forEach(function (w) { counts[w.pos] = (counts[w.pos] || 0) + 1; });
    var posKeys = orderPosKeys(Object.keys(counts));

    var grid = document.createElement('div');
    grid.className = 'cat-grid';

    function makeCard(name, list, opts) {
      opts = opts || {};
      var mastered = masteredCount(list);
      var stat = groupStats(list);
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'cat-card' + (opts.fav ? ' is-fav' : '');
      if (opts.fav) card.dataset.fav = '1';
      else card.dataset.pos = name;
      card.innerHTML =
        '<div class="cat-card-top">' +
          '<span class="cat-card-name">' + escapeHtml(name) + '</span>' +
          (opts.orphan ? '<span class="group-orphan">未登记</span>' : '') +
        '</div>' +
        '<div class="cat-card-meta">' +
          '<span>' + list.length + (allSentences(list) ? ' 条语句' : ' 个单词') + '</span>' +
          (mastered ? '<span class="cat-card-mastered">已掌握 ' + mastered + '</span>' : '') +
        '</div>' +
        (stat.appeared
          ? '<div class="cat-card-stat">测验 ' + stat.appeared + ' 次 · 答对 ' + stat.correct +
              ' · 正确率 ' + stat.rate + '%</div>'
          : '') +
        '<span class="cat-card-arrow">›</span>';
      return card;
    }

    // 收藏夹单独一张卡：错题复习的入口（跨分类）
    var favs = favWords();
    if (favs.length) grid.appendChild(makeCard(FAV_LABEL, favs, { fav: true }));

    posKeys.forEach(function (pos) {
      var list = words.filter(function (w) { return w.pos === pos; });
      grid.appendChild(makeCard(pos, list, { orphan: cats.indexOf(pos) < 0 }));
    });

    return grid;
  }

  /* 收藏夹详情：按词性分组显示（收藏的词可能来自不同分类） */
  function renderFavDetail(list) {
    var wrap = document.createElement('div');
    var bar = document.createElement('div');
    bar.className = 'detail-bar';
    bar.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" id="lib-back">← 返回分类列表</button>' +
      '<span class="detail-title">' + escapeHtml(FAV_LABEL) + ' · ' + list.length + ' 个词</span>';
    wrap.appendChild(bar);

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '收藏夹还是空的：在单词库里点 ☆ 收藏，或者做「分类连做」时把答错的题自动收进来。';
      wrap.appendChild(empty);
      return wrap;
    }

    var byPos = {};
    list.forEach(function (w) { (byPos[w.pos] = byPos[w.pos] || []).push(w); });
    orderPosKeys(Object.keys(byPos)).forEach(function (pos) {
      wrap.appendChild(renderGroup(pos, byPos[pos]));
    });
    return wrap;
  }

  function renderDetail(pos, list) {
    var wrap = document.createElement('div');
    var stat = groupStats(list);
    var bar = document.createElement('div');
    bar.className = 'detail-bar';
    bar.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" id="lib-back">← 返回分类列表</button>' +
      (stat.appeared
        ? '<span class="detail-title">测验 ' + stat.appeared + ' 次 · 答对 ' + stat.correct +
            ' · 正确率 ' + stat.rate + '%</span>'
        : '');
    wrap.appendChild(bar);
    wrap.appendChild(renderGroup(pos, list));
    return wrap;
  }

  /**
   * 检索关键词高亮：先转义再包 <mark>，大小写不敏感。
   * 高亮的是「已提交的关键词」（searchTerm），不是输入框里正在敲的内容。
   */
  function highlightTerm(text) {
    var s = String(text == null ? '' : text);
    if (!searchTerm) return escapeHtml(s);
    var idx = s.toLowerCase().indexOf(searchTerm.toLowerCase());
    if (idx < 0) return escapeHtml(s);
    var end = idx + searchTerm.length;
    return escapeHtml(s.slice(0, idx)) +
      '<mark>' + escapeHtml(s.slice(idx, end)) + '</mark>' +
      escapeHtml(s.slice(end));
  }

  /* 自他小标签：三种取值配色区分，未填写显示「—」 */
  function verbTypeTag(vt) {
    if (!vt) return '<em class="muted">—</em>';
    var cls = vt === '自动词' ? 'is-auto' : (vt === '他动词' ? 'is-tran' : 'is-both');
    return '<span class="vt-tag ' + cls + '">' + highlightTerm(vt) + '</span>';
  }

  /* 词库里的造句成绩：只有做过 AI 造句练习的词才显示这一行 */
  function sentStatHtml(w) {
    var s = w.stats || {};
    var appeared = Number(s.sentAppeared) || 0;
    if (!appeared) return '';
    var passed = Number(s.sentPassed) || 0;
    return '<span class="c-sentstat">✍️ 造句 ' + passed + ' / ' + appeared +
      ' 通过（' + Math.round(passed / appeared * 100) + '%）</span>';
  }

  function renderWordRow(w, showVt) {
    var row = document.createElement('div');
    row.dataset.id = w.id; // 检索定位用（id 已限安全字符，可直接进选择器）

    var fav = !!(w && w.fav);
    var favBtn = '<button class="icon-btn fav' + (fav ? ' is-on' : '') + '" data-action="fav" ' +
      'data-id="' + escapeHtml(w.id) + '" title="' + (fav ? '取消收藏' : '加入收藏夹') + '">' +
      (fav ? '★' : '☆') + '</button>';
    var actionsHtml =
      favBtn +
      '<button class="icon-btn" data-action="edit" data-id="' + escapeHtml(w.id) + '" title="编辑">✎</button>' +
      '<button class="icon-btn danger" data-action="delete" data-id="' + escapeHtml(w.id) + '" title="删除">🗑</button>';

    // 语句：整句 + 翻译单独一行，没有假名与统计
    if (isSentence(w)) {
      row.className = 'word-row sentence-row';
      row.innerHTML =
        '<span class="c-sentence">' + highlightTerm(w.kanji) + '</span>' +
        (w.meaning ? '<span class="c-sentence-meaning">' + highlightTerm(w.meaning) + '</span>' : '') +
        '<span class="c-actions">' + actionsHtml + '</span>';
      return row;
    }

    var rate = w.stats.appeared > 0
      ? Math.round(w.stats.correct / w.stats.appeared * 100) + '%'
      : '—';

    row.className = 'word-row';
    row.innerHTML =
      '<span class="c-kanji">' + (highlightTerm(w.kanji) || '<em class="muted">（无）</em>') + '</span>' +
      '<span class="c-kana">' + highlightTerm(w.kana) + '</span>' +
      (showVt ? '<span class="c-vt">' + verbTypeTag(w.verbType) + '</span>' : '') +
      '<span class="c-meaning">' + highlightTerm(w.meaning) + '</span>' +
      '<span class="c-stat">' + w.stats.appeared + '</span>' +
      '<span class="c-stat">' + w.stats.correct + '</span>' +
      '<span class="c-stat rate">' + rate + '</span>' +
      '<span class="c-actions">' + actionsHtml + '</span>' +
      // 手机上三个统计列会隐藏，这一行保证「出现 / 答对 / 正确率」还能看到
      '<span class="c-statline">出现 ' + w.stats.appeared + ' 次 · 答对 ' + w.stats.correct +
        ' 次 · 正确率 ' + rate + '</span>' +
      (w.example ? '<span class="c-example">' + highlightTerm(w.example) + '</span>' : '') +
      sentStatHtml(w);
    return row;
  }

  function onLibraryClick(e) {
    // 分类卡片 → 进入该分类（收藏夹卡片进收藏夹）
    var card = e.target.closest('.cat-card');
    if (card) {
      if (card.dataset.fav) { libraryFav = true; libraryPos = null; }
      else { libraryFav = false; libraryPos = card.dataset.pos; }
      renderLibrary();
      return;
    }
    // 返回按钮 → 回到分类列表
    if (e.target.closest('#lib-back')) {
      libraryPos = null;
      libraryFav = false;
      renderLibrary();
      return;
    }
    // 收藏 / 编辑 / 删除
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.action === 'fav') {
      var w = Store.get(id);
      if (!w) return;
      try {
        Store.setFav(id, !w.fav);
      } catch (err) {
        alert('收藏失败：本地存储不可用或空间不足。');
        return;
      }
      renderLibrary();
      updateSidebarStats();
      return;
    }
    if (btn.dataset.action === 'edit') openEdit(id);
    if (btn.dataset.action === 'delete') deleteWord(id);
  }

  function deleteWord(id) {
    var w = Store.get(id);
    if (!w) return;
    var label = isSentence(w)
      ? clip(w.kanji, 24)
      : (w.kanji ? w.kanji + '（' + w.kana + '）' : w.kana);
    var kind = isSentence(w) ? '语句' : '单词';
    if (confirm('确定删除' + kind + '「' + label + '」吗？')) {
      try {
        Store.remove(id);
      } catch (err) {
        alert('删除失败：本地存储不可用或空间不足。');
        return;
      }
      renderLibrary();
      updateSidebarStats();
    }
  }

  /* =========================================================
   * 单词库检索（跳转 + 高亮）
   *   回车 → 跳到第一个匹配条目所在分类，滚动到该行并闪烁；
   *   再按回车 → 在多个匹配之间循环。
   *   匹配范围：汉字 / 假名 / 意思 / 例句 / 自他（语句则匹配句子正文与翻译）。
   * ========================================================= */
  function matchesTerm(w, term) {
    var t = term.toLowerCase();
    return [w.kanji, w.kana, w.meaning, w.example, w.verbType].some(function (f) {
      return String(f == null ? '' : f).toLowerCase().indexOf(t) >= 0;
    });
  }

  function setSearchInfo(text, isError) {
    var el = $('#lib-search-info');
    el.textContent = text;
    el.className = 'search-info' + (isError ? ' is-error' : '');
  }

  function resetSearch() {
    searchTerm = '';
    searchMatches = [];
    searchCursor = -1;
    setSearchInfo('');
  }

  /* 滚动到刚渲染出的那一行，并闪烁一下提示「就是这行」 */
  function flashRow(id) {
    var row = $('#library-groups .word-row[data-id="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth; // 强制重排，保证连续跳同一行时动画能重放
    row.classList.add('flash');
    clearTimeout(flashRow._t);
    flashRow._t = setTimeout(function () { row.classList.remove('flash'); }, 1600);
  }

  function runSearch() {
    var term = $('#lib-search').value.trim();

    if (!term) { resetSearch(); renderLibrary(); return; }

    // 关键词变了就重新从第一个匹配开始，否则在同一个词上继续回车是「下一个」
    if (term !== searchTerm || !searchMatches.length) {
      searchTerm = term;
      searchMatches = Store.all()
        .filter(function (w) { return matchesTerm(w, term); })
        .map(function (w) { return w.id; });
      searchCursor = -1;
    }

    if (!searchMatches.length) {
      renderLibrary(); // 清掉上一次检索留下的高亮
      setSearchInfo('未找到「' + term + '」', true);
      return;
    }

    searchCursor = (searchCursor + 1) % searchMatches.length;
    var target = Store.get(searchMatches[searchCursor]);
    if (!target) { resetSearch(); renderLibrary(); return; }

    libraryPos = target.pos; // 跳进该条目所在的分类
    renderLibrary();
    setSearchInfo('第 ' + (searchCursor + 1) + ' / ' + searchMatches.length + ' 个匹配');
    flashRow(target.id);
  }

  function initSearch() {
    $('#lib-search').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch();
    });
    // 清空输入框即退出检索状态，恢复完整列表
    $('#lib-search').addEventListener('input', function () {
      if (!this.value.trim()) { resetSearch(); renderLibrary(); }
      else if (this.value.trim() !== searchTerm) setSearchInfo('回车跳到匹配行');
    });
  }

  /* ---------- 编辑弹窗 ---------- */
  function openEdit(id) {
    var w = Store.get(id);
    if (!w) return;
    editId = id;
    if (isSentence(w)) { openEditSentence(w); return; }
    $('#e-kanji').value = w.kanji;
    $('#e-kana').value = w.kana;
    renderPosSelect($('#e-pos'), w.pos);
    renderVtSelect($('#e-vt'), w.verbType || '');
    $('#e-meaning').value = w.meaning;
    $('#e-example').value = w.example || '';
    $('#edit-modal').hidden = false;
    $('#e-kanji').focus();
  }

  function initEditModal() {
    $('#edit-cancel').addEventListener('click', closeEdit);
    $('#edit-modal').addEventListener('click', function (e) {
      if (e.target === $('#edit-modal')) closeEdit();
    });
    $('#edit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var kana = $('#e-kana').value.trim();
      var pos = $('#e-pos').value.trim();
      var meaning = $('#e-meaning').value.trim();
      if (!kana) { alert('请填写假名'); return; }
      if (!pos) { alert('请填写词性'); return; }
      if (!meaning) { alert('请填写意思'); return; }
      try {
        Store.update(editId, {
          kanji: $('#e-kanji').value,
          kana: kana,
          pos: pos,
          meaning: meaning,
          example: $('#e-example').value,
          verbType: $('#e-vt').value
        });
      } catch (err) {
        alert('保存失败：本地存储不可用或空间不足。');
        return;
      }
      closeEdit();
      renderLibrary();
      updateSidebarStats();
    });
  }

  function closeEdit() {
    $('#edit-modal').hidden = true;
    editId = null;
  }

  /* ---------- 编辑语句弹窗 ---------- */
  function openEditSentence(w) {
    $('#es-text').value = w.kanji;
    $('#es-meaning').value = w.meaning || '';
    $('#edit-sentence-modal').hidden = false;
    $('#es-text').focus();
  }

  function closeEditSentence() {
    $('#edit-sentence-modal').hidden = true;
    editId = null;
  }

  function initEditSentenceModal() {
    $('#edit-sentence-cancel').addEventListener('click', closeEditSentence);
    $('#edit-sentence-modal').addEventListener('click', function (e) {
      if (e.target === $('#edit-sentence-modal')) closeEditSentence();
    });
    $('#edit-sentence-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('#es-text').value.trim();
      if (!text) { alert('请填写句子'); return; }
      try {
        // 只改正文与翻译；词性、type、统计都由 Store.update 原样保留
        Store.update(editId, { kanji: text, meaning: $('#es-meaning').value });
      } catch (err) {
        alert('保存失败：本地存储不可用或空间不足。');
        return;
      }
      closeEditSentence();
      renderLibrary();
      updateSidebarStats();
    });
  }

  /* =========================================================
   * 分类管理
   * ========================================================= */
  var catEditing = null; // 正在重命名的分类名，null 表示无

  function catMsg(text, ok) {
    var el = $('#cat-msg');
    el.textContent = text;
    el.className = 'form-msg ' + (ok ? 'is-ok' : 'is-error');
    clearTimeout(catMsg._t);
    catMsg._t = setTimeout(function () {
      el.textContent = '';
      el.className = 'form-msg';
    }, 3500);
  }

  function renderCategories() {
    var list = $('#cat-list');
    var cats = Store.categories();
    list.innerHTML = '';

    cats.forEach(function (name) {
      var count = Store.catCount(name);
      var row = document.createElement('div');
      row.className = 'cat-row';
      row.dataset.name = name;

      if (catEditing === name) {
        row.innerHTML =
          '<input type="text" class="cat-edit-input" maxlength="20" value="' + escapeHtml(name) + '">' +
          '<span class="cat-count">' + count + ' 个单词</span>' +
          '<span class="cat-actions">' +
            '<button type="button" class="icon-btn" data-action="cat-save" title="保存">✓</button>' +
            '<button type="button" class="icon-btn" data-action="cat-cancel" title="取消">✕</button>' +
          '</span>';
      } else {
        row.innerHTML =
          '<span class="cat-name">' + escapeHtml(name) + '</span>' +
          '<span class="cat-count">' + count + ' 个单词</span>' +
          '<span class="cat-actions">' +
            '<button type="button" class="icon-btn" data-action="cat-edit" title="重命名">✎</button>' +
            '<button type="button" class="icon-btn danger" data-action="cat-delete" title="删除">🗑</button>' +
          '</span>';
      }
      list.appendChild(row);
    });

    if (catEditing !== null) {
      var input = $('.cat-edit-input', list);
      if (input) { input.focus(); input.select(); }
    }
  }

  /* 分类变动后统一刷新相关界面 */
  function afterCategoryChange() {
    catEditing = null;
    renderCategories();
    refreshPosSelects();
    renderLibrary();
    updateSidebarStats();
  }

  function saveCategoryRename(oldName) {
    var input = $('#cat-list .cat-edit-input');
    if (!input) return;
    try {
      Store.renameCategory(oldName, input.value);
      afterCategoryChange();
      catMsg('已重命名为「' + input.value.trim() + '」，该分类下的单词已同步更新 ✓', true);
    } catch (err) {
      catMsg(err.message || '重命名失败', false);
    }
  }

  function initCategories() {
    renderCategories();

    // 展开 / 收起
    $('#cat-toggle').addEventListener('click', function () {
      var body = $('#cat-body');
      body.hidden = !body.hidden;
      $('#cat-toggle').textContent = body.hidden ? '展开' : '收起';
    });

    // 列表内的编辑 / 保存 / 取消 / 删除
    $('#cat-list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var row = btn.closest('.cat-row');
      var name = row.dataset.name;
      var action = btn.dataset.action;

      if (action === 'cat-edit') {
        catEditing = name;
        renderCategories();
      } else if (action === 'cat-cancel') {
        catEditing = null;
        renderCategories();
      } else if (action === 'cat-save') {
        saveCategoryRename(name);
      } else if (action === 'cat-delete') {
        if (!confirm('确定删除分类「' + name + '」吗？')) return;
        try {
          Store.deleteCategory(name);
          afterCategoryChange();
          catMsg('已删除分类「' + name + '」', true);
        } catch (err) {
          catMsg(err.message || '删除失败', false);
        }
      }
    });

    // 重命名输入框：回车保存，Esc 取消
    $('#cat-list').addEventListener('keydown', function (e) {
      if (!e.target.classList.contains('cat-edit-input')) return;
      var name = e.target.closest('.cat-row').dataset.name;
      if (e.key === 'Enter') { e.preventDefault(); saveCategoryRename(name); }
      if (e.key === 'Escape') { catEditing = null; renderCategories(); }
    });

    // 添加分类
    function doAdd() {
      var input = $('#cat-new');
      try {
        var added = Store.addCategory(input.value);
        input.value = '';
        afterCategoryChange();
        catMsg('已添加分类「' + added + '」 ✓', true);
      } catch (err) {
        catMsg(err.message || '添加失败', false);
      }
    }
    $('#cat-add-btn').addEventListener('click', doAdd);
    $('#cat-new').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    });
  }

  /* =========================================================
   * 测验流程
   * ========================================================= */
  function renderQuizView() {
    if (sentState) { renderSentenceQuestion(); return; }
    if (quizState) {
      if (quizState.kind === 'drill') ensureDrillQuestions();
      if (quizState.index < quizState.questions.length) { renderQuestion(); return; }
      if (quizState.kind === 'drill') { stopDrill(); return; } // 极端情况：分类被删空
    }
    if (lastRun) { renderLastRun(); return; }
    if (quizMode === 'sentence') {
      renderSentenceStart();
    } else {
      renderQuizStart();
    }
  }

  /**
   * 上次的成绩页。只要 lastRun 还在（没离开测验界面、没点「再来一次」），
   * 无论同步还是重渲染，看到的都是这一页——这就是结果页不会自动跳走的原因。
   */
  function renderLastRun() {
    if (!lastRun) { renderQuizStart(); return; }
    if (lastRun.kind === 'sentence') renderSentenceResult(lastRun);
    else if (lastRun.kind === 'drill') renderDrillResult(lastRun);
    else renderQuizResult(lastRun);
  }

  /* 两种练习模式的切换条 */
  function quizModeSwitchHtml(active) {
    return '<div class="mode-toggle quiz-mode-toggle">' +
      '<button type="button" class="mode-btn' + (active === 'classic' ? ' is-active' : '') + '" data-qmode="classic">📖 读音 + 意思</button>' +
      '<button type="button" class="mode-btn' + (active === 'sentence' ? ' is-active' : '') + '" data-qmode="sentence">✍️ AI 造句</button>' +
    '</div>';
  }

  function wireQuizMode() {
    $$('#view-quiz [data-qmode]').forEach(function (b) {
      b.addEventListener('click', function () {
        quizMode = b.dataset.qmode === 'sentence' ? 'sentence' : 'classic';
        renderQuizView();
      });
    });
  }

  /* ---------- 限定分类（可多选）：把出题范围缩到某几个分类 ---------- */
  var LS_QUIZ_CATS = 'jpStudy.quiz.cats';

  function quizCatCounts() {
    var counts = {};
    Store.all().forEach(function (w) {
      if (isSentence(w)) return;
      counts[w.pos] = (counts[w.pos] || 0) + 1;
    });
    return counts;
  }

  /* 分类顺序：先按分类表，未登记的排后面 */
  function quizCatNames(counts) {
    var known = Store.categories().filter(function (c) { return counts[c]; });
    var orphans = Object.keys(counts).filter(function (c) { return known.indexOf(c) < 0; });
    return known.concat(orphans.sort());
  }

  /* 存的是「勾选了哪些分类」；从没存过 = 全选（null） */
  function loadQuizCats() {
    var raw = null;
    try { raw = localStorage.getItem(LS_QUIZ_CATS); } catch (e) { raw = null; }
    if (raw === null) return null;
    return String(raw).split(',').filter(function (x) { return x; });
  }

  function saveQuizCats(arr) {
    try { localStorage.setItem(LS_QUIZ_CATS, arr.join(',')); } catch (e) { /* 存不下也不影响本次 */ }
  }

  /* 当前生效的分类（已被删掉的自动忽略）。收藏夹用 FAV_KEY 表示，和分类名互不影响。 */
  function selectedQuizCats() {
    var all = quizCatNames(quizCatCounts());
    var stored = loadQuizCats();
    if (stored === null) return all; // 没存过 = 全选（收藏夹默认不勾）
    return stored.filter(function (c) {
      return c === FAV_KEY || all.indexOf(c) >= 0;
    });
  }

  /* 出题池：勾选的分类，加上（勾了收藏夹时）所有收藏过的词 */
  function quizPool() {
    var sel = selectedQuizCats();
    var favOn = sel.indexOf(FAV_KEY) >= 0;
    return Store.all().filter(function (w) {
      if (isSentence(w)) return false;
      return sel.indexOf(w.pos) >= 0 || (favOn && !!w.fav);
    });
  }

  function renderQuizFilterHtml() {
    var counts = quizCatCounts();
    var cats = quizCatNames(counts);
    var favN = favWords().length;
    if (cats.length <= 1 && !favN) return '';   // 只有一个分类、也没有收藏时没必要筛
    var sel = selectedQuizCats();
    return '<div class="qf" id="qf">' +
      '<div class="qf-head"><span>限定分类（可多选）</span>' +
        '<button type="button" class="qf-btn" id="qf-all">全选</button>' +
        '<button type="button" class="qf-btn" id="qf-none">清空</button>' +
      '</div>' +
      '<div class="qf-list">' +
        (favN
          ? '<label class="qf-item qf-fav-item">' +
              '<input type="checkbox" class="qf-fav" value="' + FAV_KEY + '"' +
                (sel.indexOf(FAV_KEY) >= 0 ? ' checked' : '') + '>' +
              '<span class="qf-name">' + FAV_LABEL + '</span>' +
              '<span class="qf-count">' + favN + '</span>' +
            '</label>'
          : '') +
        cats.map(function (c) {
          return '<label class="qf-item">' +
            '<input type="checkbox" class="qf-cat" value="' + escapeHtml(c) + '"' +
              (sel.indexOf(c) >= 0 ? ' checked' : '') + '>' +
            '<span class="qf-name">' + escapeHtml(c) + '</span>' +
            '<span class="qf-count">' + counts[c] + '</span>' +
          '</label>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function wireQuizFilter() {
    var box = $('#qf');
    if (!box) return;
    function allBoxes() { return $$('.qf-cat, .qf-fav', box); }
    allBoxes().forEach(function (cb) {
      cb.addEventListener('change', function () {
        saveQuizCats(allBoxes().filter(function (x) { return x.checked; })
          .map(function (x) { return x.value; }));
        renderQuizStart();   // 立刻刷新「本次可抽 N 个单词」和按钮状态
      });
    });
    $('#qf-all').addEventListener('click', function () {
      // 收藏夹不是分类，不参与「全选」
      saveQuizCats(quizCatNames(quizCatCounts()));
      renderQuizStart();
    });
    $('#qf-none').addEventListener('click', function () {
      saveQuizCats([]);      // 空数组 = 一个都不选（与「没存过 = 全选」区分开）
      renderQuizStart();
    });
  }

  /* 「自他判断」题开关：默认开。只有出题范围里存在「填了自他的动词」时才显示这个选项 */
  var LS_QUIZ_VT = 'jpStudy.quiz.verbType';

  function quizVtEnabled() {
    var raw = null;
    try { raw = localStorage.getItem(LS_QUIZ_VT); } catch (e) { raw = null; }
    return raw === null ? true : raw === '1';
  }

  function setQuizVt(on) {
    try { localStorage.setItem(LS_QUIZ_VT, on ? '1' : '0'); } catch (e) { /* 存不下也不影响本次 */ }
  }

  /* 分类连做单独记一个开关：就算之前在「随机」里把自他题关了，
     连做默认还是带自他判断（很多人是练名词时关的，不该连带影响动词连做）。 */
  var LS_QUIZ_DRILL_VT = 'jpStudy.quiz.drillVt';

  function drillVtEnabled() {
    var raw = null;
    try { raw = localStorage.getItem(LS_QUIZ_DRILL_VT); } catch (e) { raw = null; }
    return raw === null ? true : raw === '1';
  }

  function setDrillVt(on) {
    try { localStorage.setItem(LS_QUIZ_DRILL_VT, on ? '1' : '0'); } catch (e) { /* 存不下也不影响本次 */ }
  }

  /* ---------- 开始页：出题方式（随机 10 题 / 分类连做） ---------- */
  function quizStyleHtml() {
    return '<div class="quiz-style" role="group" aria-label="出题方式">' +
      '<button type="button" class="mode-btn' + (quizStyle() === 'random' ? ' is-active' : '') +
        '" data-qstyle="random">🎲 随机抽 ' + Quiz.QUIZ_SIZE + ' 题</button>' +
      '<button type="button" class="mode-btn' + (quizStyle() === 'drill' ? ' is-active' : '') +
        '" data-qstyle="drill">🔁 分类连做</button>' +
    '</div>';
  }

  function drillOrderHtml() {
    return '<div class="quiz-style drill-order" role="group" aria-label="出题顺序">' +
      '<button type="button" class="mode-btn' + (drillOrder() === 'seq' ? ' is-active' : '') +
        '" data-qorder="seq">按词库顺序</button>' +
      '<button type="button" class="mode-btn' + (drillOrder() === 'shuffle' ? ' is-active' : '') +
        '" data-qorder="shuffle">乱序</button>' +
    '</div>';
  }

  /* 连做时可选的「分类」：所有有词的分类在前，收藏夹放最后 */
  function drillCatOptions() {
    var counts = quizCatCounts();
    var cats = quizCatNames(counts);
    var opts = [];
    cats.forEach(function (c) { opts.push({ value: c, label: c, n: counts[c] }); });
    var favN = favWords().length;
    if (favN) opts.push({ value: FAV_KEY, label: FAV_LABEL, n: favN });
    return opts;
  }

  function currentDrillCat(opts) {
    var cur = drillCat();
    var found = opts.filter(function (o) { return o.value === cur; })[0];
    return found ? cur : (opts.length ? opts[0].value : '');
  }

  /* 「自他判断」开关（两种出题方式共用） */
  function vtToggleHtml(pool, vtOn) {
    var vtPool = pool.filter(function (w) { return !!w.verbType; });
    if (!vtPool.length) return '';
    return '<label class="qf-item vt-toggle">' +
      '<input type="checkbox" id="qf-vt"' + (vtOn ? ' checked' : '') + '>' +
      '<span class="qf-name">加一道「自他判断」题</span>' +
      '<span class="qf-count">可出题 ' + vtPool.length + ' 个动词</span>' +
    '</label>';
  }

  function wireVtToggle() {
    var vtBox = $('#qf-vt');
    if (!vtBox) return;
    vtBox.addEventListener('change', function () {
      // 两种出题方式各记各的：连做默认带自他题，不受「随机」里关掉的影响
      if (quizStyle() === 'drill') setDrillVt(this.checked);
      else setQuizVt(this.checked);
      renderQuizStart();
    });
  }

  function wireQuizStyle() {
    $$('#view-quiz [data-qstyle]').forEach(function (b) {
      b.addEventListener('click', function () { setQuizStyle(b.dataset.qstyle); renderQuizStart(); });
    });
    $$('#view-quiz [data-qorder]').forEach(function (b) {
      b.addEventListener('click', function () { setDrillOrder(b.dataset.qorder); renderQuizStart(); });
    });
  }

  function renderQuizStart() {
    // 语句不参与测验，页面上显示的词库规模也只算单词
    var words = Store.all().filter(function (w) { return !isSentence(w); });
    var container = $('#view-quiz');

    if (words.length === 0) {
      container.innerHTML = '<div class="empty">' +
        (Store.all().length
          ? '词库里只有语句，没有可测验的单词。请先到「添加单词」录入单词，再开始练习。'
          : '词库为空，请先到「添加单词」录入单词，再开始练习。') +
        '</div>';
      return;
    }

    if (quizStyle() === 'drill') { renderDrillStart(words, container); return; }

    var pool = quizPool();   // 受上面的「限定分类」影响
    var n = Math.min(Quiz.QUIZ_SIZE, pool.length);
    var mastered = pool.filter(function (w) { return Quiz.isMastered(w); }).length;

    // 「自他判断」这一问只在出题范围里有动词、而且这些动词填了自他时才提供
    var vtPool = pool.filter(function (w) { return !!w.verbType; });
    var vtOn = vtPool.length > 0 && quizVtEnabled();

    container.innerHTML =
      '<div class="card quiz-start">' +
        quizModeSwitchHtml('classic') +
        quizStyleHtml() +
        '<h2>🎯 开始练习</h2>' +
        '<p class="quiz-desc">每次练习 <strong>' + n + '</strong> 个单词，先看汉字写假名，再选正确意思：</p>' +
        '<ul class="quiz-rules">' +
          '<li>① 看汉字写假名（纯假名词跳过此题）</li>' +
          '<li>② 从同词性单词抽出的意思中选出正确的一个（最多 4 个选项）</li>' +
          (vtOn ? '<li>③ 判断动词的自他性（自动词 / 他动词 / 自他动词）</li>' : '') +
        '</ul>' +
        renderQuizFilterHtml() +
        vtToggleHtml(pool, vtOn) +
        '<p class="quiz-note">' + (vtOn ? '三问' : '两问') + '都答对才计 1 分；任意一问答错不计分。刚做过的词会被记住，下一轮先抽没做过的。已掌握（出现 &gt; 5 次且正确率 &gt; 80%）的单词会降低出现概率。</p>' +
        '<div class="quiz-start-meta">' +
          '<span>本次可抽 <strong>' + pool.length + '</strong> 个单词（词库共 ' + words.length + ' 个）</span>' +
          '<span>已掌握 <strong>' + mastered + '</strong> 个</span>' +
        '</div>' +
        (pool.length
          ? '<button class="btn btn-primary btn-lg" id="quiz-start-btn">开始练习</button>'
          : '<div class="qf-warn">上面至少勾选一个分类才能开始练习。</div>') +
        '<p class="quiz-note">想自己写句子让 AI 批改？切到上面的「✍️ AI 造句」' +
          (AI.isLocalFile() ? '（需要先把网站部署到 Cloudflare Pages）。' : '。') + '</p>' +
      '</div>';

    if (pool.length) $('#quiz-start-btn').addEventListener('click', startQuiz);
    wireQuizStyle();
    wireVtToggle();
    wireQuizMode();
    wireQuizFilter();
  }

  /* ---------- 分类连做：开始页 ---------- */
  function renderDrillStart(words, container) {
    var opts = drillCatOptions();
    var cat = currentDrillCat(opts);
    var pool = drillPool(cat);
    var mastered = pool.filter(function (w) { return Quiz.isMastered(w); }).length;
    var vtOn = pool.some(function (w) { return !!w.verbType; }) && drillVtEnabled();
    var catLabel = cat === FAV_KEY ? FAV_LABEL : cat;

    container.innerHTML =
      '<div class="card quiz-start">' +
        quizModeSwitchHtml('classic') +
        quizStyleHtml() +
        '<h2>🔁 分类连做</h2>' +
        '<p class="quiz-desc">选定一个分类，把里面的词一直做下去（做完一轮自动从头再来），不限制题数；随时点「停止做题」看成绩。</p>' +
        '<ul class="quiz-rules">' +
          '<li>① 看汉字写假名（纯假名词跳过此题）</li>' +
          '<li>② 从同词性单词抽出的意思中选出正确的一个（最多 4 个选项）</li>' +
          (vtOn ? '<li>③ 判断动词的自他性（自动词 / 他动词 / 自他动词）</li>' : '') +
        '</ul>' +
        '<div class="drill-config">' +
          '<label class="drill-row"><span class="drill-label">分类</span>' +
            '<select id="drill-cat" class="drill-select">' +
              opts.map(function (o) {
                return '<option value="' + escapeHtml(o.value) + '"' +
                  (o.value === cat ? ' selected' : '') + '>' +
                  escapeHtml(o.label) + '（' + o.n + '）</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<div class="drill-row"><span class="drill-label">顺序</span>' + drillOrderHtml() + '</div>' +
        '</div>' +
        vtToggleHtml(pool, vtOn) +
        (pool.some(function (w) { return isVerbPos(w.pos); }) &&
         !pool.some(function (w) { return !!w.verbType; })
          ? '<div class="qf-warn">这个分类的动词还没填「自他」标注，所以出不了自他判断题；' +
            '在单词库里给它们补上，下次就会自动出现。</div>'
          : '') +
        '<label class="qf-item ai-record drill-autofav">' +
          '<input type="checkbox" id="drill-autofav"' + (autoFavOn() ? ' checked' : '') + '>' +
          '<span class="qf-name">答错的题自动加入收藏夹</span>' +
        '</label>' +
        '<div class="quiz-start-meta">' +
          '<span><strong>' + escapeHtml(catLabel) + '</strong> 有 ' + pool.length +
            ' 个词（词库共 ' + words.length + ' 个）</span>' +
          '<span>已掌握 <strong>' + mastered + '</strong> 个</span>' +
        '</div>' +
        (pool.length
          ? '<button class="btn btn-primary btn-lg" id="quiz-start-btn">开始连做</button>'
          : '<div class="qf-warn">这个分类里还没有单词，换一个再开始。</div>') +
        '<p class="quiz-note">做过的题会立刻记进单词库的正确率；答错的词收在「' +
          FAV_LABEL + '」里，下次可以直接只练错题。</p>' +
      '</div>';

    if (pool.length) {
      $('#quiz-start-btn').addEventListener('click', function () { startDrill(cat); });
    }
    $('#drill-cat').addEventListener('change', function () { setDrillCat(this.value); renderQuizStart(); });
    var af = $('#drill-autofav');
    if (af) af.addEventListener('change', function () { setAutoFav(this.checked); });
    wireQuizStyle();
    wireVtToggle();
    wireQuizMode();
  }

  /* ---------- AI 造句练习：开始页 ---------- */
  function renderSentenceStart() {
    var words = Store.all().filter(function (w) { return !isSentence(w); });
    var container = $('#view-quiz');

    if (words.length === 0) {
      container.innerHTML = '<div class="empty">' +
        '词库里还没有可造句的单词，请先到「添加单词」录入单词。</div>';
      return;
    }

    var n = Math.min(Quiz.SENTENCE_SIZE, words.length);

    container.innerHTML =
      '<div class="card quiz-start">' +
        quizModeSwitchHtml('sentence') +
        '<h2>✍️ AI 造句练习</h2>' +
        '<p class="quiz-desc">每次 <strong>' + n + '</strong> 个词：给出中文意思和目标词，你写一句日语，交给 AI 老师批改。</p>' +
        '<ul class="quiz-rules">' +
          '<li>① 句子要真的用上目标词（词形可以变形，汉字 / 假名写法都算）</li>' +
          '<li>② 批改会指出助词、时态、活用、自他动词的问题，并给出更自然的说法</li>' +
          '<li>③ 判定分三档：✅ 正确 / ⚠️ 基本正确 / ❌ 需要修改</li>' +
        '</ul>' +
        '<label class="ai-record"><input type="checkbox" id="ai-record"' +
          (AI.getRecord() ? ' checked' : '') + '> 把判定结果计入统计（单词库里显示「✍️ 造句 通过/次数」）</label>' +
        '<div class="quiz-start-meta">' +
          '<span>可造句的词 <strong>' + words.length + '</strong> 个</span>' +
          '<span id="ai-start-status">' + escapeHtml(aiStatusText()) + '</span>' +
        '</div>' +
        '<button class="btn btn-primary btn-lg" id="sent-start-btn">开始造句</button>' +
      '</div>';

    $('#ai-record').addEventListener('change', function () { AI.setRecord(this.checked); });
    $('#sent-start-btn').addEventListener('click', startSentenceSession);
    wireQuizMode();

    // 第一次进来顺手探一次；失败只提示，不挡着开始
    if (!aiInfo.checked && !AI.isLocalFile() && AI.accessKey()) probeAi(true);
  }

  function startSentenceSession() {
    var questions = Quiz.makeSentenceSession(Store.all());
    if (!questions.length) { renderSentenceStart(); return; }
    lastRun = null;
    pausedDrill = null;
    sentState = {
      questions: questions,
      index: 0,
      results: new Array(questions.length).fill(null)
    };
    renderSentenceQuestion();
  }

  function startQuiz() {
    var words = quizPool();   // 只从勾选的分类里抽题
    var questions = Quiz.makeSession(words, {
      withVerbType: quizVtEnabled(),
      distractors: wordLibrary()
    });
    if (!questions.length) { renderQuizStart(); return; }
    lastRun = null;
    pausedDrill = null;
    quizState = {
      kind: 'random',
      questions: questions,
      index: 0,
      results: new Array(questions.length).fill(null)
    };
    renderQuestion();
  }

  /* ---------- 分类连做：开始 / 续题 ---------- */
  function startDrill(catOpt) {
    var cat = catOpt || currentDrillCat(drillCatOptions());
    setDrillCat(cat);
    var pool = drillPool(cat);
    if (!pool.length) { renderQuizStart(); return; }
    lastRun = null;
    pausedDrill = null;
    quizState = {
      kind: 'drill',
      cat: cat,
      order: drillOrder(),
      autoFav: autoFavOn(),
      withVerbType: drillVtEnabled(),
      questions: [],
      results: [],
      index: 0,
      cycleStart: 0,
      cycleLen: 0
    };
    ensureDrillQuestions();
    renderQuestion();
  }

  /* 题目用完就接着生成下一轮（同一个分类，做到用户点「停止做题」为止） */
  function ensureDrillQuestions() {
    var st = quizState;
    if (!st || st.kind !== 'drill') return;
    while (st.index >= st.questions.length) {
      var pool = drillPool(st.cat);
      if (!pool.length) return;
      var lastId = st.questions.length ? st.questions[st.questions.length - 1].wordId : '';
      var cycle = Quiz.makeDrillCycle(pool, {
        shuffle: st.order === 'shuffle',
        withVerbType: st.withVerbType,
        lastId: lastId,
        distractors: wordLibrary()
      });
      if (!cycle.length) return;
      st.cycleStart = st.questions.length;
      st.cycleLen = cycle.length;
      st.questions = st.questions.concat(cycle);
      st.results = st.results.concat(new Array(cycle.length).fill(null));
    }
  }

  function renderQuestion() {
    var container = $('#view-quiz');
    var st = quizState;
    var idx = st.index;
    var q = st.questions[idx];
    var existing = st.results[idx];

    if (existing) {
      renderFeedback(q, existing);
    } else {
      renderAnswer(q, idx);
    }
  }

  /* ---------- 答题 / 反馈共用的头部与按钮 ---------- */
  function quizProgressHtml(st, no, total) {
    var width = total ? (no / total * 100) : 0;
    var text = '第 ' + no + ' / ' + total + ' 题';
    if (st.kind === 'drill') {
      var inCycle = st.index - st.cycleStart + 1;
      width = st.cycleLen ? (inCycle / st.cycleLen * 100) : 0;
      var answered = st.results.filter(function (r) { return !!r; }).length;
      var correct = st.results.filter(function (r) { return r && r.allCorrect; }).length;
      text = '第 ' + no + ' 题 · 已答 ' + answered + ' · 正确 ' + correct;
    }
    return '<div class="quiz-progress">' +
      '<span>' + text + '</span>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + width + '%"></div></div>' +
    '</div>';
  }

  /* 连做模式多一行：分类 / 顺序 / 本轮进度 */
  function drillMetaHtml(st) {
    if (!st || st.kind !== 'drill') return '';
    var inCycle = st.index - st.cycleStart + 1;
    return '<div class="drill-meta">' +
      '<span class="pos-badge">' + escapeHtml(st.cat === FAV_KEY ? FAV_LABEL : st.cat) + '</span>' +
      '<span>' + (st.order === 'shuffle' ? '乱序' : '按词库顺序') + '</span>' +
      '<span>本轮 ' + inCycle + ' / ' + st.cycleLen + '</span>' +
    '</div>';
  }

  /* 题头小字：这道题有几问，一眼能看到自他判断在不在（手机上也省得往下翻才发现） */
  function quizPartsHint(q) {
    var parts = [];
    if (q.readPart) parts.push('① 读音');
    parts.push((q.readPart ? '②' : '①') + ' 意思');
    // 纯假名词没有读音题，自他就是第②问
    if (q.verbPart) parts.push((q.readPart ? '③' : '②') + ' 自他');
    return '<div class="quiz-parts">本题：' + parts.join(' · ') + '</div>';
  }

  /* 词性标签：连做某个分类时，分类已经在上面显示过了，不再重复一个一样的徽章；
     练「收藏夹」时词来自不同分类，这里仍然显示词性 */
  function wordMetaHtml(q, st) {
    if (st && st.kind === 'drill' && st.cat !== FAV_KEY) return '';
    return '<div class="quiz-word-meta"><span class="pos-badge">' + escapeHtml(q.pos) + '</span></div>';
  }

  /* 停止做题：只有「分类连做」才有 */
  function quizStopRowHtml() {
    return '<div class="quiz-stop-row">' +
      '<button type="button" class="btn btn-ghost btn-sm" id="quiz-stop">■ 停止做题</button>' +
      '<span class="quiz-stop-hint">停下后会显示本次成绩和错题</span>' +
    '</div>';
  }

  function wireQuizStop() {
    var btn = $('#quiz-stop');
    if (btn) btn.addEventListener('click', stopDrill);
  }

  /* 收藏按钮：错题复习的快捷入口 */
  function favButtonHtml(q) {
    var w = Store.get(q.wordId);
    var on = !!(w && w.fav);
    return '<button type="button" class="btn btn-ghost btn-sm fav-toggle' + (on ? ' is-on' : '') +
      '" id="quiz-fav" data-id="' + escapeHtml(q.wordId) + '">' +
      (on ? '★ 已收藏' : '☆ 收藏') + '</button>';
  }

  function wireFavButton() {
    var btn = $('#quiz-fav');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var w = Store.get(btn.dataset.id);
      if (!w) return;
      var on;
      try { on = Store.setFav(w.id, !w.fav); } catch (e) { return; }
      btn.classList.toggle('is-on', on);
      btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    });
  }

  function renderAnswer(q, idx) {
    var container = $('#view-quiz');
    var total = quizState.questions.length;
    var no = idx + 1;
    var rp = q.readPart;
    var meaningNo = rp ? '②' : '①';
    var meaningLabel = meaningNo + (rp ? ' 选择正确的中文意思' : ' 选择这个词正确的中文意思');
    var vtNo = rp ? '③' : '②';

    var optionsHtml = q.meaningOptions.map(function (o, i) {
      return '<button type="button" class="meaning-option" data-id="' + escapeHtml(o.id) + '">' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span>' + escapeHtml(o.meaning) + '</span>' +
      '</button>';
    }).join('');

    // 自他判断题（只有动词、且填了自他才会有）
    var vtHtml = q.verbPart
      ? '<div class="quiz-part">' +
          '<div class="part-label">' + vtNo + ' ' + escapeHtml(q.verbPart.label) + '</div>' +
          '<div class="meaning-options vt-group">' +
            q.verbPart.options.map(function (v) {
              return '<button type="button" class="meaning-option" data-vt="' + escapeHtml(v) + '">' +
                '<span>' + escapeHtml(v) + '</span></button>';
            }).join('') +
          '</div>' +
        '</div>'
      : '';

    // 纯假名词没有读音题（没汉字可考），但题干不能省：否则用户只看到四个选项，
    // 根本不知道在考哪个词。这里把词本身作为题干显示出来。
    var readHtml = rp
      ? '<div class="quiz-part">' +
          '<div class="part-label">① ' + escapeHtml(rp.label) + '</div>' +
          '<div class="prompt-text">' + escapeHtml(rp.prompt) + '</div>' +
          '<input type="text" id="read-input" class="read-input" placeholder="输入假名" autocomplete="off">' +
        '</div>'
      : '<div class="quiz-part">' +
          '<div class="prompt-text">' + escapeHtml(q.kana) + '</div>' +
        '</div>';

    container.innerHTML =
      '<div class="card quiz-question">' +
        quizProgressHtml(quizState, no, total) +
        drillMetaHtml(quizState) +
        wordMetaHtml(q, quizState) +
        quizPartsHint(q) +
        readHtml +
        '<div class="quiz-part">' +
          '<div class="part-label">' + meaningLabel + '</div>' +
          '<div class="meaning-options meaning-group">' + optionsHtml + '</div>' +
        '</div>' +
        vtHtml +
        '<div id="quiz-feedback" class="quiz-feedback" hidden></div>' +
        '<button class="btn btn-primary btn-lg" id="quiz-confirm" style="width:100%">确认答案</button>' +
        (quizState.kind === 'drill' ? quizStopRowHtml() : '') +
      '</div>';

    // 选项选中高亮：每个选项组各自独立（意思题选一个不能把自他题的选择清掉）
    $$('.meaning-options', container).forEach(function (group) {
      $$('.meaning-option', group).forEach(function (btn) {
        btn.addEventListener('click', function () {
          $$('.meaning-option', group).forEach(function (b) { b.classList.remove('selected'); });
          btn.classList.add('selected');
        });
      });
    });

    var readInput = $('#read-input');
    if (readInput) {
      readInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') confirmAnswer(q);
      });
      readInput.focus();
    }

    $('#quiz-confirm').addEventListener('click', function () { confirmAnswer(q); });
    wireQuizStop();
  }

  function confirmAnswer(q) {
    var container = $('#view-quiz');
    var readInput = $('#read-input');
    var selected = $('.meaning-group .meaning-option.selected', container);
    var vtSel = q.verbPart ? $('.vt-group .meaning-option.selected', container) : null;

    if (readInput && !readInput.value.trim()) { readInput.focus(); flashRequire('请先输入假名'); return; }
    if (!selected) { flashRequire('请先选择一个意思'); return; }
    if (q.verbPart && !vtSel) { flashRequire('请先选择自他性'); return; }

    var readCorrect = true;
    var readValue = '';
    if (readInput) {
      readValue = readInput.value.trim();
      readCorrect = Quiz.checkRead(q, readValue);
    }
    var meaningCorrect = selected.dataset.id === q.wordId;
    var vtId = vtSel ? (vtSel.dataset.vt || '') : '';
    var vtCorrect = q.verbPart ? (vtId === q.verbPart.answer) : true;
    var allCorrect = readCorrect && meaningCorrect && vtCorrect;

    quizState.results[quizState.index] = {
      readInput: readValue,
      meaningId: selected.dataset.id,
      readCorrect: readCorrect,
      meaningCorrect: meaningCorrect,
      vtId: vtId,
      vtCorrect: vtCorrect,
      allCorrect: allCorrect,
      autoFaved: false
    };

    // 每答一题立刻落库：单词库里的「出现 / 答对 / 正确率」当场更新，
    // 中途点「停止做题」或直接关页面也不会白做一遍。
    try { Store.recordResults([q.wordId], [allCorrect]); } catch (e) { /* 统计失败不影响继续答题 */ }

    // 连做模式下答错自动收进收藏夹（开始页可以关掉）
    if (!allCorrect && quizState.kind === 'drill' && quizState.autoFav) {
      try {
        var w = Store.get(q.wordId);
        if (w && !w.fav) {
          Store.setFav(q.wordId, true);
          quizState.results[quizState.index].autoFaved = true;
        }
      } catch (e) { /* 收藏失败不影响答题 */ }
    }

    renderFeedback(q, quizState.results[quizState.index]);
  }

  function flashRequire(text) {
    var fb = $('#quiz-feedback');
    fb.hidden = false;
    fb.className = 'quiz-feedback is-wrong';
    fb.textContent = text;
    setTimeout(function () {
      if (fb.className.indexOf('is-wrong') >= 0 && fb.textContent === text) {
        fb.hidden = true;
      }
    }, 1500);
  }

  function renderFeedback(q, result) {
    var container = $('#view-quiz');
    var total = quizState.questions.length;
    var no = quizState.index + 1;
    var rp = q.readPart;
    var meaningNo = rp ? '②' : '①';
    var meaningLabel = meaningNo + (rp ? ' 选择正确的中文意思' : ' 选择这个词正确的中文意思');
    var isLast = quizState.index + 1 >= total;
    var vtNo = rp ? '③' : '②';

    // 选项着色：正确项绿色，选错项红色，并保留字母序号
    var optionsHtml = q.meaningOptions.map(function (o, i) {
      var cls = 'meaning-option';
      var mark = String.fromCharCode(65 + i);
      if (o.id === q.wordId) { cls += ' is-correct'; mark = '✓'; }
      else if (o.id === result.meaningId && !result.meaningCorrect) { cls += ' is-wrong'; mark = '✗'; }
      return '<div class="' + cls + '" style="cursor:default">' +
        '<span class="opt-key">' + mark + '</span>' +
        '<span>' + escapeHtml(o.meaning) + '</span>' +
      '</div>';
    }).join('');

    // 自他判断题的着色反馈
    var vtHtml = '';
    if (q.verbPart) {
      var vtOptions = q.verbPart.options.map(function (v, i) {
        var cls = 'meaning-option';
        var mark = String.fromCharCode(65 + i);
        if (v === q.verbPart.answer) { cls += ' is-correct'; mark = '✓'; }
        else if (v === result.vtId && !result.vtCorrect) { cls += ' is-wrong'; mark = '✗'; }
        return '<div class="' + cls + '" style="cursor:default">' +
          '<span class="opt-key">' + mark + '</span>' +
          '<span>' + escapeHtml(v) + '</span>' +
        '</div>';
      }).join('');
      vtHtml = '<div class="quiz-part">' +
        '<div class="part-label">' + vtNo + ' ' + escapeHtml(q.verbPart.label) + '</div>' +
        '<div class="meaning-options vt-group">' + vtOptions + '</div>' +
      '</div>';
    }

    // 无读音题时同样保留题干（词本身），否则答完题后页面会「空一块」
    var readHtml = rp
      ? '<div class="quiz-part">' +
          '<div class="part-label">① ' + escapeHtml(rp.label) + '</div>' +
          '<div class="prompt-text">' + escapeHtml(rp.prompt) + '</div>' +
          '<div class="read-input" style="text-align:center">你的答案：<strong>' + escapeHtml(result.readInput) + '</strong>' +
            ' <span class="' + (result.readCorrect ? 'form-msg is-ok' : 'form-msg is-error') + '">' +
            (result.readCorrect ? '✓ 正确' : '✗ 正确答案：' + escapeHtml(rp.target)) + '</span></div>' +
        '</div>'
      : '<div class="quiz-part">' +
          '<div class="prompt-text">' + escapeHtml(q.kana) + '</div>' +
        '</div>';

    var ok = result.allCorrect;
    var isDrill = quizState.kind === 'drill';
    container.innerHTML =
      '<div class="card quiz-question">' +
        quizProgressHtml(quizState, no, total) +
        drillMetaHtml(quizState) +
        wordMetaHtml(q, quizState) +
        quizPartsHint(q) +
        readHtml +
        '<div class="quiz-part">' +
          '<div class="part-label">' + meaningLabel + '</div>' +
          '<div class="meaning-options meaning-group">' + optionsHtml + '</div>' +
        '</div>' +
        vtHtml +
        '<div class="quiz-feedback ' + (ok ? 'is-correct' : 'is-wrong') + '">' +
          '<div class="fb-title">' + (ok ? '✅ 回答正确！' : '❌ 回答错误') + '</div>' +
          '<div class="fb-word">' + escapeHtml(q.kanji || q.kana) + ' 「' + escapeHtml(q.kana) + '」 — ' + escapeHtml(q.meaning) + '</div>' +
          (q.example ? '<div class="fb-example">' + escapeHtml(q.example) + '</div>' : '') +
        '</div>' +
        '<div class="quiz-fb-bar">' + favButtonHtml(q) +
          (result.autoFaved ? '<span class="quiz-fb-hint">答错，已自动加入收藏夹</span>' : '') +
        '</div>' +
        '<button class="btn btn-primary btn-lg" id="quiz-next" style="width:100%">' +
          (isDrill || !isLast ? '下一题' : '查看结果') + '</button>' +
        (isDrill ? quizStopRowHtml() : '') +
      '</div>';

    wireFavButton();
    wireQuizStop();
    $('#quiz-next').addEventListener('click', function () {
      quizState.index++;
      if (quizState.kind === 'drill') {
        ensureDrillQuestions();
        renderQuestion();
        return;
      }
      if (quizState.index < total) {
        renderQuestion();
      } else {
        finishQuiz();
      }
    });
  }

  function finishQuiz() {
    var st = quizState;
    if (!st) return;
    // 统计已在 confirmAnswer 里逐题落库，这里只负责出成绩页
    lastRun = {
      kind: 'random',
      questions: st.questions.slice(),
      results: st.results.slice()
    };
    quizState = null;
    renderQuizResult(lastRun);
    updateSidebarStats();
  }

  /* ---------- 随机练习：成绩页 ---------- */
  function renderQuizResult(run) {
    var total = run.questions.length;
    var score = run.results.filter(function (r) { return r && r.allCorrect; }).length;

    var rows = run.questions.map(function (q, i) {
      var r = run.results[i];
      return '<div class="result-row ' + (r.allCorrect ? 'is-correct' : 'is-wrong') + '">' +
        '<span class="r-icon">' + (r.allCorrect ? '✅' : '❌') + '</span>' +
        '<span class="r-word">' + escapeHtml(q.kanji || q.kana) + ' <small>' + escapeHtml(q.kana) + '</small></span>' +
        '<span class="r-meaning">' + escapeHtml(q.meaning) + '</span>' +
        '<span class="r-detail">' +
          (q.readPart ? ('读音' + (r.readCorrect ? '✓' : '✗') + ' ') : '') +
          '意思' + (r.meaningCorrect ? '✓' : '✗') +
          (q.verbPart ? ' 自他' + (r.vtCorrect ? '✓' : '✗') : '') +
        '</span>' +
      '</div>';
    }).join('');

    var wrong = run.questions.filter(function (q, i) {
      return run.results[i] && !run.results[i].allCorrect;
    });
    var wrongLeft = wrong.filter(function (q) {
      var w = Store.get(q.wordId);
      return !(w && w.fav);
    }).length;

    var pct = total ? Math.round(score / total * 100) : 0;
    var container = $('#view-quiz');
    container.innerHTML =
      '<div class="card quiz-result">' +
        '<h2>练习完成</h2>' +
        '<div class="result-score">' +
          '<div class="score-number">' + score + '<span class="score-total"> / ' + total + '</span></div>' +
          '<div class="score-pct">正确率 ' + pct + '%</div>' +
        '</div>' +
        '<div class="result-list">' + rows + '</div>' +
        (wrong.length
          ? '<div class="result-tools">' +
              '<button type="button" class="btn btn-ghost btn-sm" id="quiz-fav-wrong">' +
                (wrongLeft ? '⭐ 把 ' + wrongLeft + ' 个错题加入收藏夹' : '★ 错题都已在收藏夹里') +
              '</button>' +
            '</div>'
          : '') +
        '<p class="quiz-note">结果会一直留在这个页面，点下面的按钮才离开。</p>' +
        '<div class="result-actions">' +
          '<button class="btn btn-primary" id="quiz-again">再来一次</button>' +
          '<button class="btn btn-ghost" id="quiz-back">返回单词库</button>' +
        '</div>' +
      '</div>';

    var favBtn = $('#quiz-fav-wrong');
    if (favBtn && wrongLeft) {
      favBtn.addEventListener('click', function () {
        wrong.forEach(function (q) {
          try { Store.setFav(q.wordId, true); } catch (e) { /* 忽略 */ }
        });
        renderQuizResult(run);
      });
    }

    $('#quiz-again').addEventListener('click', function () {
      lastRun = null;
      renderQuizStart();
    });
    $('#quiz-back').addEventListener('click', function () {
      lastRun = null;
      showView('library');
    });
  }

  /* ---------- 分类连做：停止 + 成绩页 ---------- */
  function firstUnanswered(st) {
    for (var i = 0; i < st.questions.length; i++) {
      if (!st.results[i]) return i;
    }
    return st.questions.length;
  }

  function stopDrill() {
    if (!quizState || quizState.kind !== 'drill') return;
    var st = quizState;
    var questions = [];
    var results = [];
    st.questions.forEach(function (q, i) {
      if (!st.results[i]) return;   // 只统计答过的题（当前这道没答就不算）
      questions.push(q);
      results.push(st.results[i]);
    });
    lastRun = {
      kind: 'drill',
      cat: st.cat,
      order: st.order,
      questions: questions,
      results: results
    };
    // 留着会话本身，点「继续做这个分类」时能接着下一题
    st.index = firstUnanswered(st);
    pausedDrill = st;
    quizState = null;
    renderDrillResult(lastRun);
    updateSidebarStats();
  }

  function renderDrillResult(run) {
    var total = run.results.length;
    var score = run.results.filter(function (r) { return r.allCorrect; }).length;
    var pct = total ? Math.round(score / total * 100) : 0;
    var catLabel = run.cat === FAV_KEY ? FAV_LABEL : run.cat;
    var orderLabel = run.order === 'shuffle' ? '乱序' : '按词库顺序';

    var wrong = [];
    run.questions.forEach(function (q, i) {
      if (!run.results[i].allCorrect) wrong.push({ q: q, r: run.results[i] });
    });
    var wrongLeft = wrong.filter(function (x) {
      var w = Store.get(x.q.wordId);
      return !(w && w.fav);
    }).length;

    var rows = wrong.map(function (x) {
      var q = x.q, r = x.r;
      return '<div class="result-row is-wrong">' +
        '<span class="r-icon">❌</span>' +
        '<span class="r-word">' + escapeHtml(q.kanji || q.kana) + ' <small>' + escapeHtml(q.kana) + '</small></span>' +
        '<span class="r-meaning">' + escapeHtml(q.meaning) + '</span>' +
        '<span class="r-detail">' +
          (q.readPart ? ('读音' + (r.readCorrect ? '✓' : '✗') + ' ') : '') +
          '意思' + (r.meaningCorrect ? '✓' : '✗') +
          (q.verbPart ? ' 自他' + (r.vtCorrect ? '✓' : '✗') : '') +
        '</span>' +
      '</div>';
    }).join('');

    var container = $('#view-quiz');
    container.innerHTML =
      '<div class="card quiz-result">' +
        '<h2>🔁 分类连做 · 已停止</h2>' +
        '<div class="drill-result-meta">' + escapeHtml(catLabel) + ' · ' + orderLabel +
          ' · 答了 ' + total + ' 题</div>' +
        '<div class="result-score">' +
          '<div class="score-number">' + score + '<span class="score-total"> / ' + total + '</span></div>' +
          '<div class="score-pct">正确率 ' + pct + '%</div>' +
        '</div>' +
        (total
          ? (wrong.length
              ? '<div class="wrong-head">错题 ' + wrong.length + ' 个</div>' +
                '<div class="result-list">' + rows + '</div>'
              : '<p class="quiz-note">这次做的题全对 ✓</p>')
          : '<p class="quiz-note">还没答题就停了，这次没有记录成绩。</p>') +
        (wrong.length
          ? '<div class="result-tools">' +
              '<button type="button" class="btn btn-ghost btn-sm" id="drill-fav-all">' +
                (wrongLeft ? '⭐ 把 ' + wrongLeft + ' 个错题加入收藏夹' : '★ 错题都已在收藏夹里') +
              '</button>' +
            '</div>'
          : '') +
        '<p class="quiz-note">每答一题都已记进单词库的正确率；错题可以去「' +
          FAV_LABEL + '」里复习。</p>' +
        '<div class="result-actions">' +
          '<button class="btn btn-primary" id="drill-resume">继续做这个分类</button>' +
          '<button class="btn btn-ghost" id="drill-restart">换个分类</button>' +
          '<button class="btn btn-ghost" id="drill-back">返回单词库</button>' +
        '</div>' +
      '</div>';

    var favBtn = $('#drill-fav-all');
    if (favBtn && wrongLeft) {
      favBtn.addEventListener('click', function () {
        wrong.forEach(function (x) {
          try { Store.setFav(x.q.wordId, true); } catch (e) { /* 忽略 */ }
        });
        renderDrillResult(run);
      });
    }

    $('#drill-resume').addEventListener('click', function () {
      lastRun = null;
      var st = pausedDrill;
      pausedDrill = null;
      if (st) {
        // 接着刚才停下的位置：跳过已经答过的题，回到第一道没答的
        quizState = st;
        st.index = firstUnanswered(st);
        ensureDrillQuestions();
        renderQuestion();
      } else {
        startDrill(run.cat);
      }
    });
    $('#drill-restart').addEventListener('click', function () {
      lastRun = null;
      pausedDrill = null;
      renderQuizStart();
    });
    $('#drill-back').addEventListener('click', function () {
      lastRun = null;
      pausedDrill = null;
      showView('library');
    });
  }

  /* =========================================================
   * AI 造句练习：答题 / 批改 / 结果
   * ========================================================= */
  function sentProgressHtml(no, total) {
    return '<div class="quiz-progress">' +
      '<span>第 ' + no + ' / ' + total + ' 题</span>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + (no / total * 100) + '%"></div></div>' +
    '</div>';
  }

  /* 题干：中文意思 + 目标词 + 词性/自他。故意不给例句——答题时给出来等于送答案 */
  function sentPromptHtml(q) {
    return '<div class="sent-prompt">' +
      '<div class="sent-meaning">' + escapeHtml(q.meaning) + '</div>' +
      '<div class="sent-word">' + escapeHtml(q.kanji || q.kana) +
        (q.kanji ? '<small>' + escapeHtml(q.kana) + '</small>' : '') + '</div>' +
      '<div class="sent-badges">' +
        '<span class="pos-badge">' + escapeHtml(q.pos || '未分类') + '</span>' +
        (q.verbType ? verbTypeTag(q.verbType) : '') +
      '</div>' +
      '<div class="sent-tip">用这个词写一句日语</div>' +
    '</div>';
  }

  function sentError(text) {
    var el = $('#sent-error');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'form-msg is-error';
  }

  function renderSentenceQuestion() {
    var st = sentState;
    var container = $('#view-quiz');
    var q = st.questions[st.index];
    var res = st.results[st.index];

    if (res && res.status === 'done') { renderSentenceFeedback(q, res); return; }

    container.innerHTML =
      '<div class="card quiz-question">' +
        sentProgressHtml(st.index + 1, st.questions.length) +
        sentPromptHtml(q) +
        '<textarea id="sent-input" class="sent-input" rows="3" placeholder="在这里写一句日语…" ' +
          'autocomplete="off" spellcheck="false"></textarea>' +
        '<div id="sent-error" class="form-msg"></div>' +
        '<button class="btn btn-primary btn-lg" id="sent-submit" style="width:100%">提交给 AI 批改</button>' +
        '<p class="quiz-note">写好后点按钮，或按 Ctrl / Cmd + Enter 提交。</p>' +
      '</div>';

    var ta = $('#sent-input');
    if (res && res.input) ta.value = res.input;
    if (res && res.status === 'error') sentError(res.error || '提交失败，请重试');

    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitSentence(); }
    });
    $('#sent-submit').addEventListener('click', submitSentence);
    ta.focus();
  }

  function submitSentence() {
    if (!sentState) return;
    var idx = sentState.index;
    var q = sentState.questions[idx];
    var input = $('#sent-input').value.trim();
    if (!input) { sentError('先写一句日语再提交'); $('#sent-input').focus(); return; }

    sentState.results[idx] = { input: input, status: 'pending' };
    var btn = $('#sent-submit');
    var t0 = Date.now();
    btn.disabled = true;
    // 带秒数的等待提示：AI 慢的时候能看出「还在动」，不会以为卡死
    var tick = setInterval(function () {
      btn.textContent = 'AI 正在批改… ' + Math.round((Date.now() - t0) / 1000) + 's';
    }, 400);
    btn.textContent = 'AI 正在批改… 0s';
    sentError('');

    AI.judge(q, input).then(function (r) {
      clearInterval(tick);
      if (!sentState || sentState.index !== idx) return; // 期间已经翻页/退出
      r.msTotal = Date.now() - t0;
      sentState.results[idx] = { input: input, status: 'done', result: r };
      renderSentenceFeedback(q, sentState.results[idx]);
    }).catch(function (err) {
      clearInterval(tick);
      if (!sentState || sentState.index !== idx) return;
      // 失败就留在答题界面，把答案保留着，让用户能重试
      sentState.results[idx] = { input: input, status: 'error', error: (err && err.message) || '批改失败' };
      renderSentenceQuestion();
    });
  }

  /* 「无法判定」时自动展开，让用户直接看到模型到底说了什么 */
  function aiDiagHtml(r) {
    var hasRaw = !!(r.raw || r.thinking || r.message);
    if (!hasRaw) return '';
    var open = (r.verdict === 'unknown' || r.error) ? ' open' : '';
    return '<details class="ai-diag"' + open + '>' +
      '<summary>查看 AI 原始输出 / 思考过程</summary>' +
      (r.message ? '<div class="ai-diag-msg">' + escapeHtml(r.message) + '</div>' : '') +
      (r.thinking ? '<div class="ai-diag-label">模型的思考内容：</div>' +
        '<pre class="sent-raw">' + escapeHtml(r.thinking) + '</pre>' : '') +
      (r.raw ? '<div class="ai-diag-label">模型的原始输出：</div>' +
        '<pre class="sent-raw">' + escapeHtml(r.raw) + '</pre>'
        : '<div class="ai-diag-msg">（模型这次没有输出任何内容）</div>') +
    '</details>';
  }

  /* 底部诊断行：模型 / 用时 / 是否自动重试 / 是否命中缓存 */
  function aiMetaText(r) {
    var parts = ['模型 ' + shortModel(r.model || AI.getModel())];
    if (r.cached) {
      parts.push('本地缓存结果（没再花额度）');
    } else {
      if (typeof r.ms === 'number' && r.ms > 0) parts.push('AI 用时 ' + (r.ms / 1000).toFixed(1) + 's');
      if (typeof r.msTotal === 'number') parts.push('总共 ' + (r.msTotal / 1000).toFixed(1) + 's');
    }
    if (r.attempts > 1) parts.push('自动重试 ' + (r.attempts - 1) + ' 次');
    if (r.error) parts.push('诊断：' + (r.error === 'bad-model-output' ? '回答不是 JSON' : r.error));
    return '🤖 ' + parts.join(' · ');
  }

  /* 判定不对时重新批改：noCache 绕过本地缓存，重新问一次 AI */
  function reJudgeSentence() {
    if (!sentState) return;
    var idx = sentState.index;
    var q = sentState.questions[idx];
    var res = sentState.results[idx];
    var btn = $('#sent-retry');
    if (!res || !res.input || !btn) return;

    var t0 = Date.now();
    btn.disabled = true;
    btn.textContent = '↻ 重新批改…';
    AI.judge(q, res.input, { noCache: true }).then(function (r) {
      if (!sentState || sentState.index !== idx) return;
      r.msTotal = Date.now() - t0;
      sentState.results[idx] = { input: res.input, status: 'done', result: r };
      renderSentenceFeedback(q, sentState.results[idx]);
    }).catch(function (err) {
      if (!sentState || sentState.index !== idx) return;
      btn.disabled = false;
      btn.textContent = '↻ 重新批改';
      alert('重新批改失败：' + ((err && err.message) || '未知错误'));
    });
  }

  function renderSentenceFeedback(q, res) {
    var st = sentState;
    var container = $('#view-quiz');
    var r = res.result || {};
    var verdict = r.verdict || 'unknown';
    var cls = verdict === 'correct' ? 'is-correct'
      : (verdict === 'almost' ? 'is-almost' : (verdict === 'wrong' ? 'is-wrong' : 'is-unknown'));
    var icon = verdict === 'correct' ? '✅' : (verdict === 'almost' ? '⚠️' : (verdict === 'wrong' ? '❌' : '🤖'));
    var isLast = st.index + 1 >= st.questions.length;

    var corrections = (r.corrections || []).map(function (c) {
      return '<div class="sent-fix">' +
        (c.before ? '<span class="fix-before">' + escapeHtml(c.before) + '</span>' : '') +
        (c.after ? '<span class="fix-arrow">→</span><span class="fix-after">' + escapeHtml(c.after) + '</span>' : '') +
        (c.why ? '<span class="fix-why">' + escapeHtml(c.why) + '</span>' : '') +
      '</div>';
    }).join('');

    container.innerHTML =
      '<div class="card quiz-question">' +
        sentProgressHtml(st.index + 1, st.questions.length) +
        sentPromptHtml(q) +
        '<div class="quiz-feedback ' + cls + '">' +
          '<div class="fb-title">' + icon + ' ' + escapeHtml(AI.verdictLabel(verdict)) +
            (typeof r.score === 'number' ? '<span class="sent-score">' + r.score + ' 分</span>' : '') + '</div>' +
          '<div class="fb-word">你的句子：' + escapeHtml(res.input) + '</div>' +
          (r.foundForm
            ? '<div class="sent-found">✓ 用上了目标词的活用形：<b>' + escapeHtml(r.foundForm) +
              '</b>（换形态不算错）</div>'
            : '') +
          (r.usedTarget === false && !r.foundForm
            ? '<div class="sent-warn">⚠️ 好像没有用上目标词「' + escapeHtml(q.kanji || q.kana) + '」</div>' : '') +
          (r.reason ? '<div class="sent-think">🧠 批改思路：' + escapeHtml(r.reason) + '</div>' : '') +
          (corrections ? '<div class="sent-fixes">' + corrections + '</div>' : '') +
          (r.better ? '<div class="fb-extra">更自然的说法：' + escapeHtml(r.better) + '</div>' : '') +
          (r.comment ? '<div class="sent-comment">' + escapeHtml(r.comment) + '</div>' : '') +
          (q.example ? '<div class="fb-extra">参考例句（词库里填的）：' + escapeHtml(q.example) + '</div>' : '') +
          aiDiagHtml(r) +
        '</div>' +
        '<div class="sent-actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" id="sent-retry" ' +
            'title="判定不对就再批改一次：会绕过缓存重新问 AI（换活用形本来就不算错）">↻ 重新批改</button>' +
        '</div>' +
        '<div class="sent-meta">' + escapeHtml(aiMetaText(r)) + '</div>' +
        '<button class="btn btn-primary btn-lg" id="sent-next" style="width:100%">' +
          (isLast ? '查看结果' : '下一题') + '</button>' +
      '</div>';

    $('#sent-retry').addEventListener('click', reJudgeSentence);
    $('#sent-next').addEventListener('click', function () {
      if (st.index + 1 < st.questions.length) {
        st.index++;
        renderSentenceQuestion();
      } else {
        finishSentenceSession();
      }
    });
  }

  function finishSentenceSession() {
    var st = sentState;
    if (!st) return;
    var total = st.questions.length;
    var counts = { correct: 0, almost: 0, wrong: 0, unknown: 0 };

    st.results.forEach(function (r) {
      var v = (r && r.result && r.result.verdict) || 'unknown';
      if (!Object.prototype.hasOwnProperty.call(counts, v)) v = 'unknown';
      counts[v]++;
    });

    // 只有勾了「计入统计」才记录；单独记在 sentAppeared / sentPassed，
    // 不碰读音题/意思题的 appeared/correct（那道正确率和「已掌握」不该被 AI 判定影响）
    var recorded = 0;
    if (AI.getRecord()) {
      var ids = [];
      var pass = [];
      st.questions.forEach(function (q, i) {
        var r = st.results[i];
        if (!r || !r.result) return;
        ids.push(q.wordId);
        pass.push(AI.isPass(r.result.verdict));
      });
      try { recorded = Store.recordSentences(ids, pass); } catch (e) { recorded = 0; }
    }

    lastRun = {
      kind: 'sentence',
      total: total,
      counts: counts,
      questions: st.questions.slice(),
      results: st.results.slice(),
      recorded: recorded,
      record: AI.getRecord()
    };
    sentState = null;
    renderSentenceResult(lastRun);
    updateSidebarStats();
  }

  /* 造句成绩页：由 lastRun 渲染，所以同步/重渲染都不会把这一页顶掉 */
  function renderSentenceResult(run) {
    var total = run.total;
    var counts = run.counts;
    var pct = total ? Math.round((counts.correct + counts.almost * 0.5) / total * 100) : 0;

    var rows = run.questions.map(function (q, i) {
      var r = run.results[i] || {};
      var res = r.result || {};
      var v = res.verdict || 'unknown';
      var cls = v === 'correct' ? 'is-correct' : (v === 'almost' ? 'is-almost' : 'is-wrong');
      var icon = v === 'correct' ? '✅' : (v === 'almost' ? '⚠️' : (v === 'wrong' ? '❌' : '🤖'));
      return '<div class="result-row ' + cls + '">' +
        '<span class="r-icon">' + icon + '</span>' +
        '<span class="r-word">' + escapeHtml(q.kanji || q.kana) + ' <small>' + escapeHtml(q.kana) + '</small></span>' +
        '<span class="r-meaning">' + escapeHtml(r.input || '（未作答）') + '</span>' +
        '<span class="r-detail">' + escapeHtml(AI.verdictLabel(v)) +
          (typeof res.score === 'number' ? ' ' + res.score + '分' : '') + '</span>' +
      '</div>';
    }).join('');

    var container = $('#view-quiz');
    container.innerHTML =
      '<div class="card quiz-result">' +
        '<h2>造句练习完成</h2>' +
        '<div class="result-score">' +
          '<div class="score-number">' + counts.correct + '<span class="score-total"> / ' + total + '</span></div>' +
          '<div class="score-pct">得分率 ' + pct + '%（基本正确算半分）</div>' +
        '</div>' +
        '<div class="sent-summary">✅ 正确 ' + counts.correct +
          '　⚠️ 基本正确 ' + counts.almost +
          '　❌ 需要修改 ' + counts.wrong +
          (counts.unknown ? '　🤖 无法判定 ' + counts.unknown : '') + '</div>' +
        '<div class="result-list">' + rows + '</div>' +
        '<p class="quiz-note">' + (run.record
          ? '已把这 ' + run.recorded + ' 个词的造句结果记入统计（单词库里显示「✍️ 造句 通过 / 次数」）。'
          : '这次没有记录统计（开始前取消勾选了「计入统计」）。') + '</p>' +
        '<div class="result-actions">' +
          '<button class="btn btn-primary" id="sent-again">再来一次</button>' +
          '<button class="btn btn-ghost" id="sent-back">返回单词库</button>' +
        '</div>' +
      '</div>';

    $('#sent-again').addEventListener('click', function () {
      lastRun = null;
      sentState = null;
      renderSentenceStart();
    });
    $('#sent-back').addEventListener('click', function () {
      lastRun = null;
      showView('library');
    });
  }
  function initImportExport() {
    $('#btn-export').addEventListener('click', function () {
      var data = Store.exportData();
      var blob = new Blob([data], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '日语单词备份-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    $('#btn-import').addEventListener('click', function () {
      $('#import-file').click();
    });

    $('#import-file').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var json;
        try {
          json = JSON.parse(reader.result);
        } catch (err) {
          alert('导入失败：文件不是有效的 JSON 备份。');
          return;
        }
        try {
          var res = Store.importData(json);
          var msg = '导入成功：新增 ' + res.added + ' 个单词';
          if (res.updated > 0) msg += '，补充了 ' + res.updated + ' 个已有词条的空字段（例如自他标注）';
          if (res.ignored > 0) msg += '，忽略 ' + res.ignored + ' 条无效或重复条目';
          if (res.newCategories && res.newCategories.length) {
            msg += '。自动新增分类：' + res.newCategories.join('、');
          }
          alert(msg + '。');
          renderLibrary();
          updateSidebarStats();
        } catch (err) {
          alert('导入失败：本地存储不可用或空间不足。');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  /* =========================================================
   * 云同步面板
   * ========================================================= */
  var SYNC_STATUS_CLASS = { idle: '', syncing: 'is-syncing', ok: 'is-ok', error: 'is-error' };

  function initSync() {
    var statusEl = $('#sync-status');
    var keyInput = $('#sync-key');
    var connectBtn = $('#sync-connect');
    var nowBtn = $('#sync-now');

    function renderSyncStatus() {
      var st = Sync.status();
      var text;

      if (!st.key) text = '未设置同步码';
      else if (st.status === 'syncing') text = '同步中…';
      else if (st.status === 'ok') text = '已同步 ' + timeLabel(st.lastSyncAt);
      else if (st.status === 'error') text = st.message || '同步失败';
      else text = st.message || '等待同步';

      statusEl.textContent = text;
      statusEl.className = 'sync-status ' + (SYNC_STATUS_CLASS[st.status] || '');
      // 失败原因常常很长，放 title 里免得挤压侧边栏
      statusEl.title = st.status === 'error' ? (st.message || '') : text;

      if (document.activeElement !== keyInput) keyInput.value = st.key;
      connectBtn.textContent = st.key ? '更换' : '连接';
      nowBtn.hidden = !st.key;
    }

    function connect() {
      var code = keyInput.value.trim();
      var current = Sync.getKey();

      if (!code) { Sync.setKey(''); renderSyncStatus(); return; }

      if (!Sync.isValidKey(code)) {
        alert('同步码只能使用字母、数字、点、下划线、连字符，长度 1–64。');
        keyInput.focus();
        return;
      }
      if (code === current) { Sync.syncNow(); return; }
      // 已有同步码时换成另一个，意味着把本机词库并到另一份数据里，先确认
      if (current && !confirm('切换到同步码「' + code + '」？\n\n本机现有词库会与该同步码下的数据合并。')) return;

      Sync.setKey(code);
      Sync.syncNow();
    }

    Sync.onStatus(renderSyncStatus);

    // 云端合并下来的数据要立刻反映到界面
    Sync.onApplied(function () {
      refreshPosSelects();
      renderCategories();
      renderLibrary();
      updateSidebarStats();
      // 只在「测验开始页」重渲染：答题中不打断，成绩页（lastRun）也不会被顶掉。
      // 这正是以前「结果页几秒后自动跳走」的原因——同步写回会触发这里重渲染。
      var viewQuiz = $('#view-quiz');
      if (!quizState && !sentState && !lastRun && viewQuiz.classList.contains('is-active')) {
        renderQuizView();
      }
    });

    connectBtn.addEventListener('click', connect);
    nowBtn.addEventListener('click', function () { Sync.syncNow(); });
    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });

    Sync.init();
    renderSyncStatus();
  }

  /* =========================================================
   * AI 造句判题面板（侧边栏）
   * ========================================================= */
  function shortModel(id) {
    var s = String(id || '').replace(/^@cf\//, '');
    return s.length > 22 ? s.slice(0, 21) + '…' : s;
  }

  function aiStatusText() {
    if (AI.isLocalFile()) return '本机文件打开：AI 不可用';
    if (!AI.accessKey()) return '先在下面设置同步码';
    if (!aiInfo.checked) return '待检测';
    return aiInfo.ok ? ('可用：' + shortModel(aiInfo.model)) : (aiInfo.message || '不可用');
  }

  function renderAiStatus() {
    var text = aiStatusText();
    var el = $('#ai-status');
    if (el) {
      el.textContent = text;
      el.className = 'sync-status ' + (aiInfo.ok ? 'is-ok' : (aiInfo.checked ? 'is-error' : ''));
      el.title = aiInfo.message || text;
    }
    var startEl = $('#ai-start-status');
    if (startEl) startEl.textContent = text;
  }

  function fillAiModelList(ids) {
    var list = $('#ai-model-list');
    if (!list) return;
    list.innerHTML = ids.map(function (id) {
      var known = AI.MODELS.filter(function (m) { return m.id === id; })[0];
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(known ? known.label : id) + '</option>';
    }).join('');
  }

  function probeAi(silent) {
    var el = $('#ai-status');
    if (el) el.textContent = '检测中…';
    return AI.probe().then(function (info) {
      aiInfo = { checked: true, ok: true, message: '可用', model: info.model || AI.getModel() };
      if (info.models && info.models.length) fillAiModelList(info.models);
      renderAiStatus();
      return info;
    }).catch(function (err) {
      aiInfo = { checked: true, ok: false, message: (err && err.message) || '不可用', model: AI.getModel() };
      renderAiStatus();
      if (!silent) alert('AI 检测失败：' + aiInfo.message);
      return null;
    });
  }

  function initAiPanel() {
    var input = $('#ai-model');
    if (!input) return;
    fillAiModelList(AI.MODELS.map(function (m) { return m.id; }));
    input.value = AI.getModel();
    input.addEventListener('change', function () {
      AI.setModel(this.value);
      this.value = AI.getModel();
      aiInfo.checked = false; // 换了模型要重新检测
      renderAiStatus();
    });
    $('#ai-check').addEventListener('click', function () { probeAi(false); });
    renderAiStatus();
    // 已经填过同步码就静默探一次，让状态栏一进来就是准的
    if (!AI.isLocalFile() && AI.accessKey()) probeAi(true);
  }

  /* =========================================================
   * 初始化
   * ========================================================= */
  function init() {
    initForm();
    initSentenceForm();
    initInputMode();
    initEditModal();
    initEditSentenceModal();
    initImportExport();
    initCategories();
    initSearch();
    refreshPosSelects();
    refreshVtSelects();

    $$('.nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // 已经停在成绩页时再点「测验练习」，等于重新开始：成绩页收起、回到开始页
        if (btn.dataset.view === 'quiz' && lastRun) { lastRun = null; pausedDrill = null; }
        showView(btn.dataset.view);
      });
    });

    $('#library-groups').addEventListener('click', onLibraryClick);

    updateSidebarStats();
    initSync();
    initAiPanel();
    $('#f-kanji').focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

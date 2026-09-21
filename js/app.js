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

  /* ---------- 测验会话状态 ---------- */
  var quizState = null; // { questions, index, results[] }
  var editId = null;    // 当前正在编辑的单词 id
  var libraryPos = null; // 当前查看的分类名，null 表示分类列表模式
  var searchTerm = '';     // 已提交的检索关键词，空串表示未检索（行内不高亮）
  var searchMatches = [];  // 命中条目的 id，按词库顺序
  var searchCursor = -1;   // 最近一次跳转落在 searchMatches 的下标，回车时循环前进

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

  /* =========================================================
   * 视图路由
   * ========================================================= */
  function showView(name) {
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
      var msg = $('#form-msg');

      if (!kana) { setFormMsg('请填写假名', false); return; }
      if (!pos) { setFormMsg('请填写词性', false); return; }
      if (!meaning) { setFormMsg('请填写意思', false); return; }

      try {
        Store.add({ kanji: kanji, kana: kana, pos: pos, meaning: meaning, example: example });
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
      return;
    }
    empty.style.display = 'none';

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

  function renderGroup(pos, list) {
    var mastered = masteredCount(list);
    var sentencesOnly = allSentences(list);
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
      '</div>';
    section.appendChild(header);

    var table = document.createElement('div');
    table.className = 'word-table';
    // 语句没有假名/统计，整行表头都省掉
    if (!sentencesOnly) {
      table.innerHTML =
        '<div class="word-row word-row-head">' +
          '<span class="c-kanji">汉字</span>' +
          '<span class="c-kana">假名</span>' +
          '<span class="c-meaning">意思</span>' +
          '<span class="c-stat">出现</span>' +
          '<span class="c-stat">答对</span>' +
          '<span class="c-stat">正确率</span>' +
          '<span class="c-actions"></span>' +
        '</div>';
    }

    list.forEach(function (w) {
      table.appendChild(renderWordRow(w));
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

    posKeys.forEach(function (pos) {
      var list = words.filter(function (w) { return w.pos === pos; });
      var mastered = masteredCount(list);
      var isOrphan = cats.indexOf(pos) < 0;

      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'cat-card';
      card.dataset.pos = pos;
      card.innerHTML =
        '<div class="cat-card-top">' +
          '<span class="cat-card-name">' + escapeHtml(pos) + '</span>' +
          (isOrphan ? '<span class="group-orphan">未登记</span>' : '') +
        '</div>' +
        '<div class="cat-card-meta">' +
          '<span>' + list.length + (allSentences(list) ? ' 条语句' : ' 个单词') + '</span>' +
          (mastered ? '<span class="cat-card-mastered">已掌握 ' + mastered + '</span>' : '') +
        '</div>' +
        '<span class="cat-card-arrow">›</span>';
      grid.appendChild(card);
    });

    return grid;
  }

  function renderDetail(pos, list) {
    var wrap = document.createElement('div');
    var bar = document.createElement('div');
    bar.className = 'detail-bar';
    bar.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" id="lib-back">← 返回分类列表</button>';
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

  function renderWordRow(w) {
    var row = document.createElement('div');
    row.dataset.id = w.id; // 检索定位用（id 已限安全字符，可直接进选择器）

    var actionsHtml =
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
      '<span class="c-meaning">' + highlightTerm(w.meaning) + '</span>' +
      '<span class="c-stat">' + w.stats.appeared + '</span>' +
      '<span class="c-stat">' + w.stats.correct + '</span>' +
      '<span class="c-stat rate">' + rate + '</span>' +
      '<span class="c-actions">' + actionsHtml + '</span>' +
      (w.example ? '<span class="c-example">' + highlightTerm(w.example) + '</span>' : '');
    return row;
  }

  function onLibraryClick(e) {
    // 分类卡片 → 进入该分类
    var card = e.target.closest('.cat-card');
    if (card) {
      libraryPos = card.dataset.pos;
      renderLibrary();
      return;
    }
    // 返回按钮 → 回到分类列表
    if (e.target.closest('#lib-back')) {
      libraryPos = null;
      renderLibrary();
      return;
    }
    // 编辑 / 删除
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.dataset.id;
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
   *   匹配范围：汉字 / 假名 / 意思 / 例句（语句则匹配句子正文与翻译）。
   * ========================================================= */
  function matchesTerm(w, term) {
    var t = term.toLowerCase();
    return [w.kanji, w.kana, w.meaning, w.example].some(function (f) {
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
          example: $('#e-example').value
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
    if (quizState && quizState.index < quizState.questions.length) {
      renderQuestion();
    } else {
      renderQuizStart();
    }
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

    var n = Math.min(Quiz.QUIZ_SIZE, words.length);
    var mastered = words.filter(function (w) { return Quiz.isMastered(w); }).length;

    container.innerHTML =
      '<div class="card quiz-start">' +
        '<h2>🎯 开始练习</h2>' +
        '<p class="quiz-desc">每次练习 <strong>' + n + '</strong> 个单词，先看汉字写假名，再选正确意思：</p>' +
        '<ul class="quiz-rules">' +
          '<li>① 看汉字写假名（纯假名词跳过此题）</li>' +
          '<li>② 从同词性单词抽出的意思中选出正确的一个（最多 4 个选项）</li>' +
        '</ul>' +
        '<p class="quiz-note">两问都答对才计 1 分；任意一问答错不计分。已掌握（出现 &gt; 5 次且正确率 &gt; 80%）的单词会降低出现概率。</p>' +
        '<div class="quiz-start-meta">' +
          '<span>词库共 <strong>' + words.length + '</strong> 个单词</span>' +
          '<span>已掌握 <strong>' + mastered + '</strong> 个</span>' +
        '</div>' +
        '<button class="btn btn-primary btn-lg" id="quiz-start-btn">开始练习</button>' +
      '</div>';

    $('#quiz-start-btn').addEventListener('click', startQuiz);
  }

  function startQuiz() {
    var words = Store.all();
    var questions = Quiz.makeSession(words);
    if (!questions.length) { renderQuizStart(); return; }
    quizState = {
      questions: questions,
      index: 0,
      results: new Array(questions.length).fill(null)
    };
    renderQuestion();
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

  function renderAnswer(q, idx) {
    var container = $('#view-quiz');
    var total = quizState.questions.length;
    var no = idx + 1;
    var rp = q.readPart;
    var meaningNo = rp ? '②' : '①';
    var meaningLabel = meaningNo + (rp ? ' 选择正确的中文意思' : ' 选择这个词正确的中文意思');

    var optionsHtml = q.meaningOptions.map(function (o, i) {
      return '<button type="button" class="meaning-option" data-id="' + escapeHtml(o.id) + '">' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span>' + escapeHtml(o.meaning) + '</span>' +
      '</button>';
    }).join('');

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
        '<div class="quiz-progress">' +
          '<span>第 ' + no + ' / ' + total + ' 题</span>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + (no / total * 100) + '%"></div></div>' +
        '</div>' +
        '<div class="quiz-word-meta"><span class="pos-badge">' + escapeHtml(q.pos) + '</span></div>' +
        readHtml +
        '<div class="quiz-part">' +
          '<div class="part-label">' + meaningLabel + '</div>' +
          '<div class="meaning-options">' + optionsHtml + '</div>' +
        '</div>' +
        '<div id="quiz-feedback" class="quiz-feedback" hidden></div>' +
        '<button class="btn btn-primary btn-lg" id="quiz-confirm" style="width:100%">确认答案</button>' +
      '</div>';

    // 选项选中高亮
    $$('.meaning-option', container).forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.meaning-option', container).forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
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
  }

  function confirmAnswer(q) {
    var container = $('#view-quiz');
    var readInput = $('#read-input');
    var selected = $('.meaning-option.selected', container);

    if (readInput && !readInput.value.trim()) { readInput.focus(); flashRequire('请先输入假名'); return; }
    if (!selected) { flashRequire('请先选择一个意思'); return; }

    var readCorrect = true;
    var readValue = '';
    if (readInput) {
      readValue = readInput.value.trim();
      readCorrect = Quiz.checkRead(q, readValue);
    }
    var meaningCorrect = selected.dataset.id === q.wordId;

    quizState.results[quizState.index] = {
      readInput: readValue,
      meaningId: selected.dataset.id,
      readCorrect: readCorrect,
      meaningCorrect: meaningCorrect,
      allCorrect: readCorrect && meaningCorrect
    };

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
    container.innerHTML =
      '<div class="card quiz-question">' +
        '<div class="quiz-progress">' +
          '<span>第 ' + no + ' / ' + total + ' 题</span>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + (no / total * 100) + '%"></div></div>' +
        '</div>' +
        '<div class="quiz-word-meta"><span class="pos-badge">' + escapeHtml(q.pos) + '</span></div>' +
        readHtml +
        '<div class="quiz-part">' +
          '<div class="part-label">' + meaningLabel + '</div>' +
          '<div class="meaning-options">' + optionsHtml + '</div>' +
        '</div>' +
        '<div class="quiz-feedback ' + (ok ? 'is-correct' : 'is-wrong') + '">' +
          '<div class="fb-title">' + (ok ? '✅ 回答正确！' : '❌ 回答错误') + '</div>' +
          '<div class="fb-word">' + escapeHtml(q.kanji || q.kana) + ' 「' + escapeHtml(q.kana) + '」 — ' + escapeHtml(q.meaning) + '</div>' +
          (q.example ? '<div class="fb-example">' + escapeHtml(q.example) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-primary btn-lg" id="quiz-next" style="width:100%">' +
          (isLast ? '查看结果' : '下一题') + '</button>' +
      '</div>';

    $('#quiz-next').addEventListener('click', function () {
      quizState.index++;
      if (quizState.index < total) {
        renderQuestion();
      } else {
        finishQuiz();
      }
    });
  }

  function finishQuiz() {
    var st = quizState;
    var total = st.questions.length;
    var score = st.results.filter(function (r) { return r && r.allCorrect; }).length;

    // 记录出现次数与答对次数（走 Store.recordResults，以便刷新 updatedAt 供同步使用）
    var ids = [];
    var flags = [];
    st.results.forEach(function (r, i) {
      if (!r) return;
      ids.push(st.questions[i].wordId);
      flags.push(r.allCorrect);
    });
    try { Store.recordResults(ids, flags); } catch (e) { /* 忽略，不影响展示 */ }

    var rows = st.questions.map(function (q, i) {
      var r = st.results[i];
      return '<div class="result-row ' + (r.allCorrect ? 'is-correct' : 'is-wrong') + '">' +
        '<span class="r-icon">' + (r.allCorrect ? '✅' : '❌') + '</span>' +
        '<span class="r-word">' + escapeHtml(q.kanji || q.kana) + ' <small>' + escapeHtml(q.kana) + '</small></span>' +
        '<span class="r-meaning">' + escapeHtml(q.meaning) + '</span>' +
        '<span class="r-detail">' + (q.readPart ? ('读音' + (r.readCorrect ? '✓' : '✗') + ' ') : '') + '意思' + (r.meaningCorrect ? '✓' : '✗') + '</span>' +
      '</div>';
    }).join('');

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
        '<div class="result-actions">' +
          '<button class="btn btn-primary" id="quiz-again">再来一次</button>' +
          '<button class="btn btn-ghost" id="quiz-back">返回单词库</button>' +
        '</div>' +
      '</div>';

    $('#quiz-again').addEventListener('click', function () {
      quizState = null;
      renderQuizStart();
    });
    $('#quiz-back').addEventListener('click', function () { showView('library'); });

    quizState = null;
    updateSidebarStats();
  }

  /* =========================================================
   * 导入 / 导出
   * ========================================================= */
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
      // 测验进行中就不打断；同步来的数据会在交卷时自然生效
      if (!quizState && $('#view-quiz').classList.contains('is-active')) renderQuizView();
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

    $$('.nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { showView(btn.dataset.view); });
    });

    $('#library-groups').addEventListener('click', onLibraryClick);

    updateSidebarStats();
    initSync();
    $('#f-kanji').focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

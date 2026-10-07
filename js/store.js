/* =========================================================
 * store.js —— 本地数据存储层
 * 负责单词的增删改查、持久化（localStorage）与导入/导出。
 * 数据结构：
 *   Word {
 *     id: string,          // 唯一标识（仅允许安全字符，防注入）
 *     type: string,        // 'word'（单词，默认）| 'sentence'（语句）
 *     kanji: string,       // 汉字（可为空，表示纯假名词）；type='sentence' 时存句子正文
 *     kana: string,        // 假名（读音，单词必填；语句为空）
 *     pos: string,         // 词性（单词必填，用于分类与干扰项抽取）；语句固定为「语句」
 *     meaning: string,     // 意思（单词必填）；语句存中文翻译（可为空）
 *     example: string,     // 例句（可为空）
 *     verbType: string,    // 自他属性：'自动词' | '他动词' | '自他动词'（可为空，仅动词有意义）
 *     createdAt: number,   // 创建时间戳
 *     updatedAt: number,   // 最后修改时间戳（多端同步时用来判断谁更新）
 *     stats: {
 *       appeared: number, correct: number,         // 读音题 + 意思题（correct <= appeared）
 *       sentAppeared: number, sentPassed: number   // AI 造句题（sentPassed <= sentAppeared）
 *     }
 *   }
 *
 * 语句（type='sentence'）是「只输入句子」的轻量条目：不参与测验、不记统计，
 * 只作为独立的「语句」分类展示，因此 kana 为空、meaning 可为空。
 *
 * 持久化采用「先写入 localStorage 成功后再提交到内存」的原子方式，
 * 保证存储失败时内存与持久化状态一致（不会静默丢失）。
 *
 * 多端同步支持：变更后通过 onChange 通知同步模块；删除会写「墓碑」
 * （DEL_KEY），使删除能传播到其它设备而不被云端旧数据复活。
 * ========================================================= */
window.Store = (function () {
  'use strict';

  var KEY = 'jpStudy.words.v1';
  var CAT_KEY = 'jpStudy.cats.v1';
  var DEL_KEY = 'jpStudy.deleted.v1';
  var SENTENCE_POS = '语句';  // 语句专用分类（保留名，普通单词不应占用）
  // 自他属性：只有动词类词条才需要填，留空表示未填写（名词/形容词/语句都不用）
  var VERB_TYPES = ['自动词', '他动词', '自他动词'];
  var DEFAULT_CATS = ['一类动词', '二类动词', '三类动词', '一类形容词', '二类形容词', '名词', SENTENCE_POS];
  var words = [];
  var cats = [];
  var deleted = {};   // id -> 删除时间戳（墓碑）
  var changeCbs = []; // 变更监听（同步模块用）

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 转非负整数；max 给定时向上钳制 */
  function toInt(v, max) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 0) n = 0;
    if (max !== undefined && n > max) n = max;
    return n;
  }

  /* 内容指纹，用于导入去重。带上 type，避免同文的单词与语句被判成重复 */
  function contentKey(w) {
    return [w.type || 'word', w.kanji, w.kana, w.pos, w.meaning, w.verbType || ''].join('');
  }

  /* 自他属性（自动词/他动词/自他动词）：只认预设值，其余（含旧数据缺字段）视为未填写 */
  function normalizeVerbType(v) {
    var s = String(v == null ? '' : v).trim();
    return VERB_TYPES.indexOf(s) >= 0 ? s : '';
  }

  /* 归一化单个条目；非法（非对象 / 全空）返回 null */
  function normalizeWord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    // 只认 'sentence'，其余（含旧数据缺字段）一律当作普通单词
    var type = item.type === 'sentence' ? 'sentence' : 'word';
    var kanji = String(item.kanji == null ? '' : item.kanji).trim();
    var kana = String(item.kana == null ? '' : item.kana).trim();
    var pos = String(item.pos == null ? '' : item.pos).trim();
    var meaning = String(item.meaning == null ? '' : item.meaning).trim();
    var example = String(item.example == null ? '' : item.example).trim();
    var verbType = normalizeVerbType(item.verbType);
    if (type === 'sentence') verbType = ''; // 语句没有自他属性，外来数据里带了也丢掉
    if (!kana && !kanji && !pos && !meaning && !example && !verbType) return null;

    // id 仅接受安全字符，否则重新生成（从源头阻断 HTML 注入）
    var id = (typeof item.id === 'string' && item.id && /^[A-Za-z0-9._-]+$/.test(item.id))
      ? item.id : uid();

    var appeared = toInt(item.stats && item.stats.appeared);
    var correct = toInt(item.stats && item.stats.correct, appeared); // 钳制 correct <= appeared
    // AI 造句题单独计数：判定是「模糊」的，不能混进读音/意思题的正确率里
    var sentAppeared = toInt(item.stats && item.stats.sentAppeared);
    var sentPassed = toInt(item.stats && item.stats.sentPassed, sentAppeared);

    // createdAt 缺省取当前时间；updatedAt 缺省回落到 createdAt。
    // 关键：旧数据缺 updatedAt 时不能赋「当前时间」，否则每次加载都会让本地
    // 时间戳凭空变新、永远赢过云端，同步就失效了。
    var createdAt = toInt(item.createdAt) || Date.now();
    var updatedAt = toInt(item.updatedAt) || createdAt;

    return {
      id: id,
      type: type,
      kanji: kanji,
      kana: kana,
      pos: pos,
      meaning: meaning,
      example: example,
      verbType: verbType,
      createdAt: createdAt,
      updatedAt: updatedAt,
      stats: {
        appeared: appeared, correct: correct,
        sentAppeared: sentAppeared, sentPassed: sentPassed
      }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      words = Array.isArray(parsed)
        ? parsed.map(normalizeWord).filter(function (w) { return w; })
        : [];
    } catch (e) {
      // 数据损坏或不可读时清空，避免整个应用无法启动
      words = [];
    }
    return words;
  }

  /* 写入 localStorage；arr 缺省时序列化当前内存数据。写入失败会抛出。 */
  function persistWords(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr || words));
  }

  /* 公开的 save：持久化并通知同步模块（测验改完成统计后由 app.js 调用） */
  function save(arr) {
    persistWords(arr);
    emitChange();
  }

  /* ---------- 变更通知（同步模块据此做防抖自动上传） ---------- */
  function emitChange() {
    changeCbs.forEach(function (cb) {
      try { cb(); } catch (e) { /* 单个回调出错不影响其它回调 */ }
    });
  }

  function onChange(cb) {
    if (typeof cb === 'function') changeCbs.push(cb);
  }

  /* ---------- 墓碑：记录删除，让删除能同步到其它设备 ---------- */
  function loadDeleted() {
    try {
      var raw = localStorage.getItem(DEL_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      deleted = {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(function (id) {
          if (/^[A-Za-z0-9._-]+$/.test(id)) {
            deleted[id] = toInt(parsed[id]) || Date.now();
          }
        });
      }
    } catch (e) {
      deleted = {};
    }
    return deleted;
  }

  /* 墓碑写入失败不应阻断删除本身，故吞掉异常 */
  function saveDeleted(next) {
    deleted = next;
    try {
      localStorage.setItem(DEL_KEY, JSON.stringify(next));
    } catch (e) { /* 忽略：本地删除仍然生效，只是暂时无法同步出去 */ }
  }

  function deletedMap() {
    var out = {};
    Object.keys(deleted).forEach(function (k) { out[k] = deleted[k]; });
    return out;
  }

  /* ============ 分类（词性）管理 ============ */

  function loadCats() {
    try {
      var raw = localStorage.getItem(CAT_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        var seen = {};
        cats = parsed
          .filter(function (c) { return typeof c === 'string' && c.trim(); })
          .map(function (c) { return c.trim(); })
          .filter(function (c) { if (seen[c]) return false; seen[c] = true; return true; });
      } else {
        cats = [];
      }
    } catch (e) {
      cats = [];
    }
    // 首次使用或数据损坏时用默认分类
    if (!cats.length) cats = DEFAULT_CATS.slice();
    return cats;
  }

  /**
   * 同时持久化单词与分类。任一写入失败则回滚两者，
   * 避免出现「分类改了但单词没跟上」的错位状态。
   * silent=true 时不触发变更通知（同步模块写回合并结果时用，避免自激循环）。
   */
  function saveBoth(nextWords, nextCats, silent) {
    var prevWordsRaw = JSON.stringify(words);
    var prevCatsRaw = JSON.stringify(cats);
    try {
      localStorage.setItem(KEY, JSON.stringify(nextWords));
      localStorage.setItem(CAT_KEY, JSON.stringify(nextCats));
    } catch (e) {
      try {
        localStorage.setItem(KEY, prevWordsRaw);
        localStorage.setItem(CAT_KEY, prevCatsRaw);
      } catch (e2) { /* 回滚也失败，保持内存不变 */ }
      throw e;
    }
    words = nextWords;
    cats = nextCats;
    if (!silent) emitChange();
  }

  function categories() { return cats; }

  function catCount(name) {
    return words.filter(function (w) { return w.pos === name; }).length;
  }

  function addCategory(name) {
    name = String(name == null ? '' : name).trim();
    if (!name) throw new Error('分类名不能为空');
    if (name.length > 20) throw new Error('分类名过长（最多 20 字）');
    if (cats.indexOf(name) >= 0) throw new Error('该分类已存在');
    var next = cats.concat([name]);
    localStorage.setItem(CAT_KEY, JSON.stringify(next)); // 失败会抛出，内存不变
    cats = next;
    emitChange();
    return name;
  }

  /** 重命名分类，并同步更新该分类下的所有单词 */
  function renameCategory(oldName, newName) {
    newName = String(newName == null ? '' : newName).trim();
    if (!newName) throw new Error('分类名不能为空');
    if (newName.length > 20) throw new Error('分类名过长（最多 20 字）');
    if (cats.indexOf(oldName) < 0) throw new Error('分类不存在');
    if (oldName === newName) return true;
    if (cats.indexOf(newName) >= 0) throw new Error('已存在同名分类');

    var now = Date.now();
    var nextCats = cats.map(function (c) { return c === oldName ? newName : c; });
    var nextWords = words.map(function (w) {
      if (w.pos !== oldName) return w;
      return {
        id: w.id, type: w.type || 'word',
        kanji: w.kanji, kana: w.kana, pos: newName,
        meaning: w.meaning, example: w.example, verbType: w.verbType || '',
        createdAt: w.createdAt, updatedAt: now, stats: w.stats
      };
    });
    saveBoth(nextWords, nextCats);
    return true;
  }

  function deleteCategory(name) {
    if (cats.indexOf(name) < 0) throw new Error('分类不存在');
    if (cats.length <= 1) throw new Error('至少要保留一个分类');
    var n = catCount(name);
    if (n > 0) throw new Error('该分类下还有 ' + n + ' 个单词，请先修改或删除这些单词');
    var next = cats.filter(function (c) { return c !== name; });
    localStorage.setItem(CAT_KEY, JSON.stringify(next));
    cats = next;
    emitChange();
    return true;
  }

  function all() { return words; }

  function get(id) {
    for (var i = 0; i < words.length; i++) {
      if (words[i].id === id) return words[i];
    }
    return null;
  }

  function add(word) {
    var w = normalizeWord({
      kanji: word.kanji, kana: word.kana, pos: word.pos,
      meaning: word.meaning, example: word.example, verbType: word.verbType
    });
    if (!w || !w.kana || !w.pos || !w.meaning) {
      throw new Error('缺少必填字段（假名/词性/意思）');
    }
    var next = words.concat([w]);
    persistWords(next); // 先持久化
    words = next;       // 成功后再提交内存
    emitChange();       // 内存已就绪才通知，同步模块才能读到新数据
    return w;
  }

  /**
   * 新增一条语句（「只输入句子」的轻量条目）。
   * 正文存在 kanji 字段，中文翻译存在 meaning 字段（可空），词性固定为「语句」。
   * 需要时把「语句」一并登记进分类表，保证它一定能作为分类出现在单词库里。
   */
  function addSentence(text, meaning) {
    text = String(text == null ? '' : text).trim();
    if (!text) throw new Error('句子不能为空');
    var w = normalizeWord({
      type: 'sentence',
      kanji: text,
      kana: '',
      pos: SENTENCE_POS,
      meaning: String(meaning == null ? '' : meaning).trim()
    });
    if (!w) throw new Error('句子不能为空');

    var next = words.concat([w]);
    if (cats.indexOf(SENTENCE_POS) < 0) {
      saveBoth(next, cats.concat([SENTENCE_POS])); // 单词 + 分类一起原子写入
    } else {
      persistWords(next);
      words = next;
      emitChange();
    }
    return w;
  }

  function update(id, patch) {
    var w = get(id);
    if (!w) return false;
    var now = Date.now();
    var next = words.map(function (x) {
      if (x.id !== id) return x;
      return {
        id: x.id,
        type: x.type || 'word', // 逐字段重建时必须带上，否则语句会退化成普通单词
        kanji: patch.kanji !== undefined ? String(patch.kanji).trim() : x.kanji,
        kana: patch.kana !== undefined ? String(patch.kana).trim() : x.kana,
        pos: patch.pos !== undefined ? String(patch.pos).trim() : x.pos,
        meaning: patch.meaning !== undefined ? String(patch.meaning).trim() : x.meaning,
        example: patch.example !== undefined ? String(patch.example).trim() : (x.example || ''),
        verbType: patch.verbType !== undefined ? normalizeVerbType(patch.verbType) : (x.verbType || ''),
        createdAt: x.createdAt,
        updatedAt: now,
        stats: x.stats
      };
    });
    persistWords(next);
    words = next;
    emitChange();
    return true;
  }

  function remove(id) {
    var next = words.filter(function (w) { return w.id !== id; });
    if (next.length === words.length) return false;
    persistWords(next);
    words = next;

    // 留一个墓碑：否则同步时云端那条旧记录会被当成「本地没有」而原样拉回来
    var nextDel = deletedMap();
    nextDel[id] = Date.now();
    saveDeleted(nextDel);

    emitChange();
    return true;
  }

  /**
   * 批量记录一次测验结果：出现次数 +1，答对时答对次数 +1。
   *
   * 这里必须刷新 updatedAt。若沿用旧时间戳，同步遇到云端同时间的记录会走
   * 「指纹裁决」，而指纹是字符串比较——appeared 从 9 变 10 时 "10" < "9"，
   * 新统计反而会输给旧值，白丢一次作答记录。
   *
   * ids/correctFlags 等长；返回实际更新的单词数。
   */
  function recordResults(ids, correctFlags) {
    var now = Date.now();
    var flags = {};
    for (var i = 0; i < ids.length; i++) flags[ids[i]] = !!correctFlags[i];

    var updated = 0;
    var next = words.map(function (w) {
      if (!Object.prototype.hasOwnProperty.call(flags, w.id)) return w;
      updated++;
      return {
        id: w.id, type: w.type || 'word',
        kanji: w.kanji, kana: w.kana, pos: w.pos,
        meaning: w.meaning, example: w.example, verbType: w.verbType || '',
        createdAt: w.createdAt, updatedAt: now,
        stats: {
          appeared: w.stats.appeared + 1,
          correct: w.stats.correct + (flags[w.id] ? 1 : 0),
          sentAppeared: toInt(w.stats.sentAppeared),
          sentPassed: toInt(w.stats.sentPassed)
        }
      };
    });

    if (!updated) return 0;
    persistWords(next);
    words = next;
    emitChange();
    return updated;
  }

  /**
   * 批量记录一次 AI 造句练习：造句出现次数 +1，判定为「正确」时通过次数 +1。
   *
   * 刻意与 recordResults 分开计数：AI 判定是模糊的，混进 appeared/correct 会让
   * 「正确率」和「已掌握」算法失真（掌握度只该由读音题和四选一决定）。
   */
  function recordSentences(ids, passFlags) {
    var now = Date.now();
    var flags = {};
    for (var i = 0; i < ids.length; i++) flags[ids[i]] = !!passFlags[i];

    var updated = 0;
    var next = words.map(function (w) {
      if (!Object.prototype.hasOwnProperty.call(flags, w.id)) return w;
      updated++;
      return {
        id: w.id, type: w.type || 'word',
        kanji: w.kanji, kana: w.kana, pos: w.pos,
        meaning: w.meaning, example: w.example, verbType: w.verbType || '',
        createdAt: w.createdAt, updatedAt: now,
        stats: {
          appeared: toInt(w.stats.appeared),
          correct: toInt(w.stats.correct),
          sentAppeared: toInt(w.stats.sentAppeared) + 1,
          sentPassed: toInt(w.stats.sentPassed) + (flags[w.id] ? 1 : 0)
        }
      };
    });

    if (!updated) return 0;
    persistWords(next);
    words = next;
    emitChange();
    return updated;
  }

  function exportData() {
    return JSON.stringify(words, null, 2);
  }

  /**
   * 导入 JSON 备份。采用「合并」策略：
   *  - 相同 id 的跳过；相同内容（汉字+假名+词性+意思）的也跳过；
   *  - 缺少必填字段（假名/词性/意思）或非法的条目被忽略并计数。
   * 返回 { added, ignored }。
   */
  function importData(json) {
    if (!Array.isArray(json)) throw new Error('bad-format');

    var existingIds = {};
    var existingContent = {};
    words.forEach(function (w) {
      existingIds[w.id] = true;
      existingContent[contentKey(w)] = true;
    });

    var toAdd = [];
    var ignored = 0;

    json.forEach(function (item) {
      var w = normalizeWord(item);
      if (!w) { ignored++; return; }
      // 语句只要句子正文齐全即可（无假名/翻译）；单词仍要求假名/词性/意思齐全。
      // 语句一律归到「语句」分类，避免外来的 pos 把它散落到别的分类里。
      if (w.type === 'sentence') {
        if (!w.kanji) { ignored++; return; }
        w.pos = SENTENCE_POS;
      } else if (!w.kana || !w.pos || !w.meaning) {
        ignored++;
        return;
      }
      if (existingIds[w.id]) { ignored++; return; }  // 相同 id，跳过
      var ck = contentKey(w);
      if (existingContent[ck]) { ignored++; return; } // 相同内容，跳过（防重复导入）
      existingIds[w.id] = true;
      existingContent[ck] = true;
      toAdd.push(w);
    });

    var newCats = [];
    if (toAdd.length) {
      // 导入的条目一律标成「刚更新」。备份里的旧时间戳会让它们在同步时
      // 输给云端旧版本，导致刚导入的内容推不上去。
      var now = Date.now();
      toAdd.forEach(function (w) { w.updatedAt = now; });

      var next = words.concat(toAdd);
      // 导入数据里出现的新词性自动登记到分类表，避免产生「未登记分类」
      toAdd.forEach(function (w) {
        if (cats.indexOf(w.pos) < 0 && newCats.indexOf(w.pos) < 0) newCats.push(w.pos);
      });
      if (newCats.length) {
        saveBoth(next, cats.concat(newCats));
      } else {
        persistWords(next);
        words = next;
        emitChange();
      }
    }
    return { added: toAdd.length, ignored: ignored, newCategories: newCats };
  }

  /**
   * 用合并结果整体替换本地数据（同步模块专用）。
   * silent 写回：不触发 onChange，避免「同步 → 通知 → 再同步」的自激循环。
   */
  function replaceAll(nextWords, nextCats, nextDeleted) {
    var w = (nextWords || []).map(normalizeWord).filter(function (x) { return x; });
    var c = (nextCats && nextCats.length) ? nextCats.slice() : cats.slice();
    saveBoth(w, c, true);
    if (nextDeleted) saveDeleted(nextDeleted);
  }

  load();
  loadCats();
  loadDeleted();

  return {
    all: all,
    get: get,
    add: add,
    addSentence: addSentence,
    SENTENCE_POS: SENTENCE_POS,
    VERB_TYPES: VERB_TYPES,
    update: update,
    remove: remove,
    recordResults: recordResults,
    recordSentences: recordSentences,
    exportData: exportData,
    importData: importData,
    save: save,
    /* 分类 */
    categories: categories,
    catCount: catCount,
    addCategory: addCategory,
    renameCategory: renameCategory,
    deleteCategory: deleteCategory,
    /* 多端同步 */
    onChange: onChange,
    replaceAll: replaceAll,
    deletedMap: deletedMap
  };
})();

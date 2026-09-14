/* =========================================================
 * store.js —— 本地数据存储层
 * 负责单词的增删改查、持久化（localStorage）与导入/导出。
 * 数据结构：
 *   Word {
 *     id: string,          // 唯一标识（仅允许安全字符，防注入）
 *     kanji: string,       // 汉字（可为空，表示纯假名词）
 *     kana: string,        // 假名（读音，必填）
 *     pos: string,         // 词性（必填，用于分类与干扰项抽取）
 *     meaning: string,     // 意思（必填）
 *     example: string,     // 例句（可为空）
 *     createdAt: number,   // 创建时间戳
 *     stats: { appeared: number, correct: number }  // correct <= appeared
 *   }
 *
 * 持久化采用「先写入 localStorage 成功后再提交到内存」的原子方式，
 * 保证存储失败时内存与持久化状态一致（不会静默丢失）。
 * ========================================================= */
window.Store = (function () {
  'use strict';

  var KEY = 'jpStudy.words.v1';
  var CAT_KEY = 'jpStudy.cats.v1';
  var DEFAULT_CATS = ['一类动词', '二类动词', '三类动词', '一类形容词', '二类形容词', '名词'];
  var words = [];
  var cats = [];

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

  /* 内容指纹，用于导入去重 */
  function contentKey(w) {
    return [w.kanji, w.kana, w.pos, w.meaning].join('');
  }

  /* 归一化单个条目；非法（非对象 / 全空）返回 null */
  function normalizeWord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var kanji = String(item.kanji == null ? '' : item.kanji).trim();
    var kana = String(item.kana == null ? '' : item.kana).trim();
    var pos = String(item.pos == null ? '' : item.pos).trim();
    var meaning = String(item.meaning == null ? '' : item.meaning).trim();
    var example = String(item.example == null ? '' : item.example).trim();
    if (!kana && !kanji && !pos && !meaning && !example) return null;

    // id 仅接受安全字符，否则重新生成（从源头阻断 HTML 注入）
    var id = (typeof item.id === 'string' && item.id && /^[A-Za-z0-9._-]+$/.test(item.id))
      ? item.id : uid();

    var appeared = toInt(item.stats && item.stats.appeared);
    var correct = toInt(item.stats && item.stats.correct, appeared); // 钳制 correct <= appeared

    return {
      id: id,
      kanji: kanji,
      kana: kana,
      pos: pos,
      meaning: meaning,
      example: example,
      createdAt: item.createdAt || Date.now(),
      stats: { appeared: appeared, correct: correct }
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
  function save(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr || words));
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
   */
  function saveBoth(nextWords, nextCats) {
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

    var nextCats = cats.map(function (c) { return c === oldName ? newName : c; });
    var nextWords = words.map(function (w) {
      if (w.pos !== oldName) return w;
      return {
        id: w.id, kanji: w.kanji, kana: w.kana, pos: newName,
        meaning: w.meaning, createdAt: w.createdAt, stats: w.stats
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
      meaning: word.meaning, example: word.example
    });
    if (!w || !w.kana || !w.pos || !w.meaning) {
      throw new Error('缺少必填字段（假名/词性/意思）');
    }
    var next = words.concat([w]);
    save(next);       // 先持久化
    words = next;     // 成功后再提交内存
    return w;
  }

  function update(id, patch) {
    var w = get(id);
    if (!w) return false;
    var next = words.map(function (x) {
      if (x.id !== id) return x;
      return {
        id: x.id,
        kanji: patch.kanji !== undefined ? String(patch.kanji).trim() : x.kanji,
        kana: patch.kana !== undefined ? String(patch.kana).trim() : x.kana,
        pos: patch.pos !== undefined ? String(patch.pos).trim() : x.pos,
        meaning: patch.meaning !== undefined ? String(patch.meaning).trim() : x.meaning,
        example: patch.example !== undefined ? String(patch.example).trim() : (x.example || ''),
        createdAt: x.createdAt,
        stats: x.stats
      };
    });
    save(next);
    words = next;
    return true;
  }

  function remove(id) {
    var next = words.filter(function (w) { return w.id !== id; });
    if (next.length === words.length) return false;
    save(next);
    words = next;
    return true;
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
      if (!w.kana || !w.pos || !w.meaning) { ignored++; return; }
      if (existingIds[w.id]) { ignored++; return; }  // 相同 id，跳过
      var ck = contentKey(w);
      if (existingContent[ck]) { ignored++; return; } // 相同内容，跳过（防重复导入）
      existingIds[w.id] = true;
      existingContent[ck] = true;
      toAdd.push(w);
    });

    var newCats = [];
    if (toAdd.length) {
      var next = words.concat(toAdd);
      // 导入数据里出现的新词性自动登记到分类表，避免产生「未登记分类」
      toAdd.forEach(function (w) {
        if (cats.indexOf(w.pos) < 0 && newCats.indexOf(w.pos) < 0) newCats.push(w.pos);
      });
      if (newCats.length) {
        saveBoth(next, cats.concat(newCats));
      } else {
        save(next);
        words = next;
      }
    }
    return { added: toAdd.length, ignored: ignored, newCategories: newCats };
  }

  load();
  loadCats();

  return {
    all: all,
    get: get,
    add: add,
    update: update,
    remove: remove,
    exportData: exportData,
    importData: importData,
    save: save,
    /* 分类 */
    categories: categories,
    catCount: catCount,
    addCategory: addCategory,
    renameCategory: renameCategory,
    deleteCategory: deleteCategory
  };
})();

/* =========================================================
 * quiz.js —— 测验核心逻辑
 *  - 按「已掌握」权重随机抽取 N 个单词（无放回）
 *  - 记住最近出过的词，避免下一次练习立刻又抽到同一批（否则小分类里体感
 *    「随机性不足」——其实是连抽了几次差不多的词）
 *  - 每个单词生成：看汉字写假名（读音题，纯假名词跳过）+ 意思四选一
 *  - 例句随题目带出，但只在答完后的反馈里展示（答题时展示会剧透意思题）
 *  - 判分与假名归一化（平假名/片假名视为等价）
 *
 * 分类连做（makeDrillCycle）：同一个分类按顺序、倒序或乱序一轮一轮出题，
 * 不再限制 10 题，由界面上的「停止做题」结束。
 *
 * 造句题（makeSentenceSession）：只负责出题，判分交给 AI（functions/api/ai.js）。
 * 判定结果单独记在 stats.sentAppeared / stats.sentPassed 里，不参与上面的掌握度算法。
 *
 * 掌握规则：出现次数 > 5 且 正确率 > 80% 时，降低出现概率。
 * ========================================================= */
window.Quiz = (function () {
  'use strict';

  var QUIZ_SIZE = 10;              // 每次练习的单词数
  var MASTER_APPEARED = 5;         // 出题次数阈值（严格大于）
  var MASTER_RATE = 0.8;           // 正确率阈值（严格大于）
  var MASTER_WEIGHT = 0.2;         // 已掌握单词的抽取权重（降低出现概率）
  var NORMAL_WEIGHT = 1.0;
  /* 「自他判断」题的固定选项（顺序固定，免得靠位置猜答案） */
  var VERB_TYPE_OPTIONS = ['自动词', '他动词', '自他动词'];
  var SENTENCE_SIZE = 5;           // 一次 AI 造句练习的题数（每句都要手打，比选择题少一些）
  /* 最近出过的词（最新的在前）：默认记住两轮，抽题时先避开它们 */
  var RECENT_KEY = 'jpStudy.quiz.recent';
  var RECENT_MAX = 20;

  /* ---------- 掌握判定 ---------- */
  function correctRate(w) {
    if (!w.stats.appeared) return 0;
    return w.stats.correct / w.stats.appeared;
  }

  function isMastered(w) {
    return w.stats.appeared > MASTER_APPEARED && correctRate(w) > MASTER_RATE;
  }

  function weightOf(w) {
    return isMastered(w) ? MASTER_WEIGHT : NORMAL_WEIGHT;
  }

  /* ---------- 随机工具 ---------- */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 加权抽取（无放回） ---------- */
  function pickWeighted(pool, n) {
    var remaining = pool.slice();
    var picked = [];
    while (picked.length < n && remaining.length > 0) {
      var total = 0;
      remaining.forEach(function (w) { total += weightOf(w); });
      var r = Math.random() * total;
      var idx = 0;
      for (var i = 0; i < remaining.length; i++) {
        r -= weightOf(remaining[i]);
        if (r <= 0) { idx = i; break; }
      }
      picked.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
    return picked;
  }

  /* ---------- 最近出过的词（跨练习记忆） ---------- */
  function readRecent() {
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string' && x; });
    } catch (e) {
      return [];
    }
  }

  function writeRecent(ids) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
    } catch (e) { /* 本地存储不可用时只是少一层去重，不影响出题 */ }
  }

  /* 把本次抽到的词记到最前面（去重，最多留 RECENT_MAX 个） */
  function noteAsked(ids) {
    var seen = {};
    var out = [];
    ids.concat(readRecent()).forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    writeRecent(out);
    return out;
  }

  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* 忽略 */ }
  }

  /**
   * 随机抽 n 个词，优先避开「最近出过的」。
   * 分类太小、剩下的新词不够 n 个时，按「最久没做」的顺序补足，
   * 这样小分类也不会出现「刚做完又原样来一遍」。
   */
  function pickSession(pool, n) {
    var recent = readRecent();
    var recentSet = {};
    recent.forEach(function (id) { recentSet[id] = true; });

    var fresh = pool.filter(function (w) { return !recentSet[w.id]; });
    var picked;

    if (fresh.length >= n) {
      picked = pickWeighted(fresh, n);
    } else {
      picked = pickWeighted(fresh, fresh.length);
      // recent 里越靠前越新；从最久没做过的开始补，保证「新词优先、旧词后补」
      var old = pool
        .filter(function (w) { return recentSet[w.id]; })
        .sort(function (a, b) { return recent.indexOf(b.id) - recent.indexOf(a.id); });
      picked = picked.concat(old.slice(0, n - picked.length));
    }

    noteAsked(picked.map(function (w) { return w.id; }));
    return picked;
  }

  /* ---------- 意思干扰项抽取（同词性优先，去重） ---------- */
  function pickDistractors(w, allWords) {
    var correctMeaning = String(w.meaning).trim();
    // 语句不参与测验，也不能当干扰项：整句当作「意思」选项没有意义
    var samePos = shuffle(allWords.filter(function (x) {
      return x.id !== w.id && x.pos === w.pos && x.type !== 'sentence';
    }));
    var others = shuffle(allWords.filter(function (x) {
      return x.id !== w.id && x.pos !== w.pos && x.type !== 'sentence';
    }));

    var used = {};
    used[correctMeaning] = true;
    var distractors = [];

    function tryAdd(x) {
      if (distractors.length >= 3) return;
      var m = String(x.meaning).trim();
      if (used[m]) return;
      used[m] = true;
      distractors.push(x);
    }

    samePos.forEach(tryAdd);
    // 同词性干扰项不足 3 个时（小词库/意思大量重复），用其它词性的意思兜底，
    // 以保证选项数量；这是有意的降级，仅在某个词性分组词数不足时触发。
    if (distractors.length < 3) others.forEach(tryAdd);
    return distractors;
  }

  /* 判断字符串是否含汉字（CJK 表意文字），用于决定是否考读音 */
  function hasKanji(s) {
    return /[㐀-䶿一-鿿豈-﫿]/.test(String(s || ''));
  }

  /* ---------- 生成单个单词的题目 ---------- */
  function buildQuestion(w, allWords, withVerbType) {
    // 只保留「看汉字写假名」：有汉字才考读音；纯假名词（无汉字）跳过读音题，得分由意思题决定
    var readPart = hasKanji(w.kanji)
      ? { mode: 'read', prompt: w.kanji, target: w.kana, label: '请写出假名（读音）' }
      : null;

    var distractors = pickDistractors(w, allWords);
    var options = shuffle([{ id: w.id, meaning: w.meaning }]
      .concat(distractors.map(function (x) { return { id: x.id, meaning: x.meaning }; })));

    // 自他判断题：只有「开始页勾了这个选项」且「这个词填了自他」才出。
    // 名词、形容词、以及没标注自他的动词都不会出这一问。
    var verbPart = (withVerbType && w.verbType)
      ? { label: '判断这个动词的自他性', answer: w.verbType, options: VERB_TYPE_OPTIONS.slice() }
      : null;

    return {
      wordId: w.id,
      kanji: w.kanji,
      kana: w.kana,
      pos: w.pos,
      meaning: w.meaning,
      example: w.example || '',
      readPart: readPart,
      meaningOptions: options,
      verbPart: verbPart
    };
  }

  /* ---------- 生成一次练习的题目集 ---------- */
  function makeSession(allWords, opts) {
    opts = opts || {};
    // 语句（type='sentence'）不参与测验：既没有读音题，翻译也不适合当四选一
    var pool = (allWords || []).filter(function (w) { return w.type !== 'sentence'; });
    if (pool.length === 0) return [];
    var n = Math.min(QUIZ_SIZE, pool.length);
    var selected = pickSession(pool, n);
    // 干扰项默认从同一个池里抽；限定分类/收藏夹只剩一两个词时，
    // 调用方可以传 distractors 用整个词库的意思凑选项，免得只有一两个选项
    var distractorPool = opts.distractors || pool;
    return selected.map(function (w) { return buildQuestion(w, distractorPool, !!opts.withVerbType); });
  }

  /**
   * 分类连做：给某个分类生成「一轮」题目。
   *  - shuffle=false：按词库顺序（Store.all 的顺序，也就是录入/导入顺序）
   *  - reverse=true：倒序，把词库顺序反过来（从新到旧；shuffle 优先，两个都传时按乱序）
   *  - shuffle=true：这一轮打乱顺序；lastId 用来避免和上一轮最后一题重复
   *  - opts.distractors：意思选项的取词范围（默认就用这个分类里的词）
   */
  function makeDrillCycle(pool, opts) {
    opts = opts || {};
    var words = (pool || []).filter(function (w) { return w && w.type !== 'sentence'; });
    if (opts.shuffle) {
      words = shuffle(words);
      if (opts.lastId && words.length > 1 && words[0].id === opts.lastId) {
        var j = 1 + Math.floor(Math.random() * (words.length - 1));
        var t = words[0]; words[0] = words[j]; words[j] = t;
      }
    } else {
      words = words.slice();
      if (opts.reverse) words.reverse();   // 倒序：单词库顺序反过来（新→旧）
    }
    var distractorPool = opts.distractors || words;
    return words.map(function (w) { return buildQuestion(w, distractorPool, !!opts.withVerbType); });
  }

  /* ---------- 造句题：只出题，判分由 AI 负责 ---------- */
  function buildSentenceQuestion(w) {
    return {
      kind: 'sentence',
      wordId: w.id,
      kanji: w.kanji,
      kana: w.kana,
      pos: w.pos,
      verbType: w.verbType || '',
      meaning: w.meaning,
      // 参考例句只在批改完之后展示，答题时给出来等于送答案
      example: w.example || ''
    };
  }

  /* 抽取一次造句练习的题目集（沿用「已掌握」加权：没掌握的更容易被抽到） */
  function makeSentenceSession(allWords, size) {
    var pool = (allWords || []).filter(function (w) { return w.type !== 'sentence'; });
    if (pool.length === 0) return [];
    var n = Math.min(size || SENTENCE_SIZE, pool.length);
    return pickWeighted(pool, n).map(buildSentenceQuestion);
  }

  /* ---------- 假名归一化 ---------- */
  // 片假名 -> 平假名（利用 Unicode 固定偏移）
  function toHiragana(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c >= 0x30A1 && c <= 0x30F6) {
        out += String.fromCodePoint(c - 0x60);
      } else {
        out += str[i];
      }
    }
    return out;
  }

  function normalizeKana(s) {
    return toHiragana(String(s || '').trim()).replace(/[\s　]/g, '');
  }

  /* ---------- 判分 ---------- */
  function checkRead(q, input) {
    return normalizeKana(input) === normalizeKana(q.readPart.target);
  }

  function checkMeaning(q, selectedId) {
    return selectedId === q.wordId;
  }

  return {
    QUIZ_SIZE: QUIZ_SIZE,
    SENTENCE_SIZE: SENTENCE_SIZE,
    RECENT_MAX: RECENT_MAX,
    makeSession: makeSession,
    makeDrillCycle: makeDrillCycle,
    makeSentenceSession: makeSentenceSession,
    isMastered: isMastered,
    correctRate: correctRate,
    checkRead: checkRead,
    checkMeaning: checkMeaning,
    normalizeKana: normalizeKana,
    readRecent: readRecent,
    clearRecent: clearRecent
  };
})();

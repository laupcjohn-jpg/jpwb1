/* =========================================================
 * quiz.js —— 测验核心逻辑
 *  - 按「已掌握」权重随机抽取 N 个单词（无放回）
 *  - 每个单词生成：看汉字写假名（读音题，纯假名词跳过）+ 意思四选一
 *  - 例句随题目带出，但只在答完后的反馈里展示（答题时展示会剧透意思题）
 *  - 判分与假名归一化（平假名/片假名视为等价）
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
  var SENTENCE_SIZE = 5;           // 一次 AI 造句练习的题数（每句都要手打，比选择题少一些）

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
  function buildQuestion(w, allWords) {
    // 只保留「看汉字写假名」：有汉字才考读音；纯假名词（无汉字）跳过读音题，得分由意思题决定
    var readPart = hasKanji(w.kanji)
      ? { mode: 'read', prompt: w.kanji, target: w.kana, label: '请写出假名（读音）' }
      : null;

    var distractors = pickDistractors(w, allWords);
    var options = shuffle([{ id: w.id, meaning: w.meaning }]
      .concat(distractors.map(function (x) { return { id: x.id, meaning: x.meaning }; })));

    return {
      wordId: w.id,
      kanji: w.kanji,
      kana: w.kana,
      pos: w.pos,
      meaning: w.meaning,
      example: w.example || '',
      readPart: readPart,
      meaningOptions: options
    };
  }

  /* ---------- 生成一次练习的题目集 ---------- */
  function makeSession(allWords) {
    // 语句（type='sentence'）不参与测验：既没有读音题，翻译也不适合当四选一
    var pool = (allWords || []).filter(function (w) { return w.type !== 'sentence'; });
    if (pool.length === 0) return [];
    var n = Math.min(QUIZ_SIZE, pool.length);
    var selected = pickWeighted(pool, n);
    return selected.map(function (w) { return buildQuestion(w, pool); });
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
    makeSession: makeSession,
    makeSentenceSession: makeSentenceSession,
    isMastered: isMastered,
    correctRate: correctRate,
    checkRead: checkRead,
    checkMeaning: checkMeaning,
    normalizeKana: normalizeKana
  };
})();

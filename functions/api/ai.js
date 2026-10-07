/* =========================================================
 * Cloudflare Pages Function —— AI 造句判题代理
 *
 * 路由：POST /api/ai   判一个句子；GET /api/ai  查配置（不消耗额度）
 *
 * 为什么要多这一层：AI 的凭据只放在服务端环境变量里，浏览器永远拿不到。
 * 页面就算公开挂在公网上，也不会泄露密钥，也不用把 key 存进 localStorage。
 *
 * 鉴权（按环境变量二选一）：
 *   1) 设置了 AI_ACCESS_CODE —— 请求头 x-jp-key 必须与它完全相同；
 *   2) 没设置 —— 要求 x-jp-key 是「已经在用的同步码」（D1 的 docs 表里有这个 key）。
 *      也就是说：只有知道同步码的人能用，不需要额外配置。
 *
 * 调模型（按绑定二选一）：
 *   1) 绑定了 Workers AI（变量名必须是 AI）—— 走 env.AI.run()；
 *   2) 或者设置 CF_ACCOUNT_ID + CF_API_TOKEN —— 走 REST API。
 *   AI_MODEL 可以覆盖默认模型（服务端优先于浏览器传来的 model）。
 *
 * 环境变量一览：AI（绑定）| CF_ACCOUNT_ID + CF_API_TOKEN | AI_MODEL | AI_ACCESS_CODE
 * ========================================================= */

var KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
var DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash';
var MAX_SENTENCE = 400;   // 学生句子最长字符数
var MAX_FIELD = 120;      // 词条字段最长字符数
var MAX_TOKENS = 900;

/* 前端下拉里给的候选（免费计划可用、多语言/日语表现较好的几个） */
var MODEL_CANDIDATES = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct'
];

var SYSTEM_PROMPT = [
  '你是一位认真、简洁的日语老师，负责批改中国学生的日语造句。',
  '批改标准：',
  '1. 助词、时态、活用（词形变化）、自他动词的用法是否正确；',
  '2. 是否真的用上了指定单词（允许变形，汉字/假名写法差异不算错）；',
  '3. 意思是否与指定词义相符，句子是否自然；',
  '4. 只要语法正确、意思通顺就算对，不要因为「和参考答案不一样」就判错；',
  '5. 只指出真正的错误，不要吹毛求疵。',
  '输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字、不要解释。',
  'JSON 结构：{"verdict":"correct|almost|wrong","score":0到100的整数,"usedTarget":true或false,' +
  '"corrections":[{"before":"学生原句里出错的片段","after":"改正后的片段","why":"中文说明"}],' +
  '"better":"更自然的一句日语","comment":"一句中文点评"}'
].join('\n');

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/* 截断 + 去掉换行（词条字段来自浏览器，压成一行可以让提示词结构不被破坏） */
function oneLine(v, max) {
  var s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function clip(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/* 有些模型把 JSON 包在 ```json 里，或者前后带解释文字，这里尽量救回来 */
function parseJudge(text) {
  var raw = String(text == null ? '' : text);
  var s = raw.trim();
  s = s.replace(/^```[A-Za-z]*\s*/, '').replace(/```\s*$/, '').trim();
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  var obj = null;
  try { obj = JSON.parse(s); } catch (e) { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      verdict: 'unknown', score: null, usedTarget: null, corrections: [],
      better: '', comment: '', parseError: true, raw: clip(raw, 1200)
    };
  }

  var verdict = String(obj.verdict == null ? '' : obj.verdict).trim().toLowerCase();
  if (verdict === 'ok' || verdict === 'pass' || verdict === 'true') verdict = 'correct';
  if (verdict === 'partial' || verdict === 'partly') verdict = 'almost';
  if (verdict === 'incorrect' || verdict === 'fail') verdict = 'wrong';

  var score = Number(obj.score);
  if (!isFinite(score)) score = null;
  else score = Math.max(0, Math.min(100, Math.round(score)));

  if (['correct', 'almost', 'wrong'].indexOf(verdict) < 0) {
    if (score === null) verdict = 'unknown';
    else verdict = score >= 85 ? 'correct' : (score >= 60 ? 'almost' : 'wrong');
  }
  if (score === null && verdict === 'correct') score = 90;
  if (score === null && verdict === 'almost') score = 70;
  if (score === null && verdict === 'wrong') score = 40;

  var used = obj.usedTarget;
  if (typeof used === 'string') used = (used.toLowerCase() === 'true');
  if (typeof used !== 'boolean') used = null;

  var corrections = [];
  if (Array.isArray(obj.corrections)) {
    obj.corrections.slice(0, 8).forEach(function (c) {
      if (!c || typeof c !== 'object') {
        var t = clip(c, 200);
        if (t) corrections.push({ before: t, after: '', why: '' });
        return;
      }
      var before = clip(c.before, 120);
      var after = clip(c.after, 120);
      var why = clip(c.why, 200);
      if (before || after || why) corrections.push({ before: before, after: after, why: why });
    });
  }

  return {
    verdict: verdict,
    score: score,
    usedTarget: used,
    corrections: corrections,
    better: clip(obj.better, 300),
    comment: clip(obj.comment, 500),
    parseError: false
  };
}

/* 模型返回文本的字段名各家不同，统一取出来 */
function extractText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out.response === 'string') return out.response;                 // Workers AI 文本模型
  if (out.result && typeof out.result.response === 'string') return out.result.response; // REST
  if (Array.isArray(out.choices) && out.choices[0] && out.choices[0].message) {
    return String(out.choices[0].message.content || '');                     // OpenAI 兼容
  }
  try { return JSON.stringify(out); } catch (e) { return ''; }
}

/* 鉴权：AI_ACCESS_CODE 优先；否则要求「已存在的同步码」 */
async function authorize(env, key) {
  if (!key || !KEY_RE.test(key)) {
    return { error: json({ error: 'unauthorized', message: '缺少访问码（x-jp-key）' }, 401) };
  }
  if (env.AI_ACCESS_CODE) {
    if (key !== env.AI_ACCESS_CODE) {
      return { error: json({ error: 'unauthorized', message: '访问码不正确' }, 401) };
    }
    return { mode: 'access-code' };
  }
  if (env.DB) {
    try {
      var row = await env.DB.prepare('SELECT 1 AS ok FROM docs WHERE key = ?').bind(key).first();
      if (row) return { mode: 'sync-key' };
      return {
        error: json({
          error: 'unauthorized',
          message: '这个同步码在云端还没有数据：请先在页面里连接同步码并同步一次'
        }, 401)
      };
    } catch (e) {
      return {
        error: json({
          error: 'db-not-ready',
          message: '数据库还没建表：请先在页面里做一次云同步（会自动建表）'
        }, 503)
      };
    }
  }
  return {
    error: json({
      error: 'ai-not-configured',
      message: '服务端未配置 AI：需要给 Pages 绑定 Workers AI（变量名 AI），或设置 AI_ACCESS_CODE'
    }, 503)
  };
}

/* 调模型：优先 Workers AI 绑定，其次 REST API */
async function runModel(env, model, messages) {
  var payload = { messages: messages, max_tokens: MAX_TOKENS, temperature: 0.2 };

  if (env.AI && typeof env.AI.run === 'function') {
    var out = await env.AI.run(model, payload);
    return { text: extractText(out) };
  }

  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    var res = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID + '/ai/run/' + model,
      {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + env.CF_API_TOKEN,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || (data && data.success === false)) {
      var msg = (data && data.errors && data.errors[0] && data.errors[0].message) ||
        ('模型调用失败（HTTP ' + res.status + '）');
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return { text: extractText(data && data.result) };
  }

  var e2 = new Error('服务端未配置模型通道：需要绑定 Workers AI（变量名 AI），或设置 CF_ACCOUNT_ID + CF_API_TOKEN');
  e2.status = 503;
  throw e2;
}

/* GET：给前端做「可用性探测」，不消耗额度 */
export async function onRequestGet(context) {
  var env = context.env || {};
  var auth = await authorize(env, context.request.headers.get('x-jp-key'));
  if (auth.error) return auth.error;
  return json({
    ok: true,
    auth: auth.mode,
    ready: !!(env.AI || (env.CF_ACCOUNT_ID && env.CF_API_TOKEN)),
    model: env.AI_MODEL || DEFAULT_MODEL,
    models: MODEL_CANDIDATES,
    limits: { maxSentence: MAX_SENTENCE }
  });
}

/* POST：判一个句子 */
export async function onRequestPost(context) {
  var env = context.env || {};

  var auth = await authorize(env, context.request.headers.get('x-jp-key'));
  if (auth.error) return auth.error;

  var body = null;
  try { body = await context.request.json(); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'bad-json', message: '请求体不是合法 JSON' }, 400);
  }

  var sentence = oneLine(body.sentence, MAX_SENTENCE);
  if (!sentence) return json({ error: 'empty-sentence', message: '请先写一个句子' }, 400);

  var w = body.word && typeof body.word === 'object' ? body.word : {};
  var word = {
    kanji: oneLine(w.kanji, MAX_FIELD),
    kana: oneLine(w.kana, MAX_FIELD),
    pos: oneLine(w.pos, 40),
    verbType: oneLine(w.verbType, 20),
    meaning: oneLine(w.meaning, MAX_FIELD),
    example: oneLine(w.example, 200)
  };
  if (!word.kana && !word.kanji) {
    return json({ error: 'bad-word', message: '缺少目标词信息' }, 400);
  }

  var model = oneLine(env.AI_MODEL, 120) || oneLine(body.model, 120) || DEFAULT_MODEL;

  var label = word.kanji ? (word.kanji + '（' + word.kana + '）') : word.kana;
  var bits = [];
  if (word.pos) bits.push('词性：' + word.pos);
  if (word.verbType) bits.push('自他：' + word.verbType);
  if (word.meaning) bits.push('意思：' + word.meaning);
  var userPrompt = [
    '【题目】用日语单词 ' + label + ' 造一个句子。' + (bits.length ? '（' + bits.join('，') + '）' : ''),
    '【学生的答案】' + sentence,
    '请批改并按要求只输出 JSON。'
  ].join('\n');

  var messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  try {
    var out = await runModel(env, model, messages);
    var judged = parseJudge(out.text);
    var payload = {
      ok: true,
      model: model,
      verdict: judged.verdict,
      score: judged.score,
      usedTarget: judged.usedTarget,
      corrections: judged.corrections,
      better: judged.better,
      comment: judged.comment
    };
    if (judged.parseError) {
      payload.error = 'bad-model-output';
      payload.message = '模型没有按 JSON 格式回答，下面是它的原文';
      payload.raw = judged.raw;
    }
    return json(payload);
  } catch (e) {
    var status = (e && e.status) || 502;
    var text = (e && e.message) || 'AI 调用失败';
    var hint = '';
    if (/plan|paid|upgrade|403|5035/i.test(text)) {
      hint = '这个模型可能只对付费计划开放，换一个模型试试（例如 GLM-4.7-Flash / Gemma 4）';
    } else if (/capacity|3040|429|rate/i.test(text)) {
      hint = '免费额度用完了或触发限流，过一会儿再试，或者换一个模型';
    }
    return json({
      error: 'model-error',
      message: text,
      hint: hint,
      model: model
    }, (status === 429 || status === 503) ? status : 502);
  }
}

/* 其它方法一律拒绝 */
export async function onRequest() {
  return json({ error: 'method-not-allowed' }, 405);
}

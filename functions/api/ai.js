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
 *
 * ============ 稳定性设计（都是实测踩过的坑）============
 *   - 默认模型换成实测 1.8 秒的 llama-3.3-70b；原来的 glm-4.7-flash 实测 24～77 秒，
 *     而且它的思考过程会吃光输出额度、可见内容变成空字符串（前端表现为「无法判定」）。
 *   - max_tokens 从 900 压到 450：判题只需要一小段 JSON，输出越短越快。
 *   - 对带思考模式的模型（qwen3 / qwq / glm-4.7 / glm-5）显式关掉 thinking
 *     （chat_template_kwargs.enable_thinking=false）；模型不认这个参数就自动去掉重试。
 *   - 模型返回空内容或不是 JSON 时，自动用「只输出 JSON」的短提示再问一次。
 *   - 解析器对中文判定词（正确 / 基本正确 / 需要修改）、"78分" 这类写法都能吃下。
 *   - 响应里始终带回原始输出 raw 和模型思考内容 thinking（如果模型给了），
 *     前端可以展开给用户看「AI 到底说了什么」，出问题也不用猜。
 * ========================================================= */

var KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
var DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
var MAX_SENTENCE = 400;   // 学生句子最长字符数
var MAX_FIELD = 120;      // 词条字段最长字符数
var MAX_TOKENS = 450;     // 判题输出很短，压小一点响应更快
var MAX_CORRECTIONS = 3;

/* 实测数据（2026-10，同一个「自他动词用错」的句子，见 README）：
 *   llama-3.3-70b-instruct-fp8-fast   1.8s  ✅ 判得最准（默认）
 *   mistral-small-3.1-24b-instruct    2.0s  ✅
 *   qwen3-30b-a3b-fp8                 2.5s  ✅（有时用日语回答）
 *   llama-3.1-8b-instruct-fp8         3.7s  ⚠️ 会看错病因
 *   llama-3.2-3b-instruct             1.0s  ⚠️ 最快但质量一般
 *   gemma-4-26b-a4b-it               13.7s  ✅
 *   glm-4.7-flash                    24~77s ❌ 经常空回答
 */
var MODEL_CANDIDATES = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-4.7-flash'
];

/* 带「思考模式」的模型：不关掉的话，思考内容可能把 max_tokens 吃光、可见输出为空 */
var THINKING_MODEL_RE = /qwen3|qwq|glm-4\.7|glm-5/i;

var SYSTEM_PROMPT = [
  '你是日语老师，批改中国学生的日语造句。只用中文说明，日语句子才用日语。',
  '检查：① 助词、时态、活用（词形）是否正确；② 自他动词用法是否正确；',
  '③ 是否用上指定单词（变形、汉字/假名写法差异不算错）；④ 意思是否对、句子是否自然。',
  '语法正确、意思通顺就算对，不要因为和参考答案不同判错；只指出真正的错误，最多 3 条。',
  '只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。格式：',
  '{"verdict":"correct|almost|wrong","score":0到100的整数,"usedTarget":true或false,' +
  '"reason":"一句话中文，说明你检查了什么、为什么这么判",' +
  '"corrections":[{"before":"学生原句里出错的片段","after":"改正后的片段","why":"中文说明"}],' +
  '"better":"更自然的一句日语","comment":"给学生的一句中文提醒"}'
].join('\n');

var RETRY_SYSTEM_PROMPT = [
  '你是日语批改程序。只输出一行 JSON，不要 markdown、不要解释、不要多余文字。',
  '格式：{"verdict":"correct|almost|wrong","score":0-100,"usedTarget":true|false,' +
  '"reason":"中文","corrections":[{"before":"","after":"","why":""}],' +
  '"better":"日语","comment":"中文"}'
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

/* 判定词归一化：中文、英文、"正确/基本正确/需要修改" 都认 */
var VERDICT_EXACT = {
  correct: 'correct', ok: 'correct', pass: 'correct', passed: 'correct', true: 'correct', yes: 'correct',
  almost: 'almost', partial: 'almost', partly: 'almost',
  wrong: 'wrong', incorrect: 'wrong', fail: 'wrong', failed: 'wrong', false: 'wrong', no: 'wrong'
};
var VERDICT_RULES = [
  ['基本正确', 'almost'], ['大体正确', 'almost'], ['部分正确', 'almost'], ['有点问题', 'almost'], ['小错', 'almost'],
  ['完全正确', 'correct'], ['正确', 'correct'], ['没问题', 'correct'], ['很好', 'correct'], ['对的', 'correct'],
  ['需要修改', 'wrong'], ['不对', 'wrong'], ['有误', 'wrong'], ['错误', 'wrong'], ['错的', 'wrong']
];

function normVerdict(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (VERDICT_EXACT[s]) return VERDICT_EXACT[s];
  for (var i = 0; i < VERDICT_RULES.length; i++) {
    if (s.indexOf(VERDICT_RULES[i][0]) >= 0) return VERDICT_RULES[i][1];
  }
  return '';
}

/* 模型返回 JSON 的字段名偶尔不一样，这里都认 */
function pick(obj, names) {
  for (var i = 0; i < names.length; i++) {
    var v = obj[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
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
      reason: '', better: '', comment: '', parseError: true, raw: clip(raw, 1200)
    };
  }

  var verdict = normVerdict(pick(obj, ['verdict', 'judgement', 'judgment', 'result', '判定']));

  var score = Number(pick(obj, ['score', 'points', '得分', '分数']));
  if (!isFinite(score) || score <= 0 && String(pick(obj, ['score', 'points', '得分', '分数'])) === '') score = null;
  if (score !== null) score = Math.max(0, Math.min(100, Math.round(score)));
  if (score === null) {
    // 模型把分数写在文字里（"78分" / "78 / 100"）也能捞出来
    var m = /(\d{1,3})\s*(?:分|\/100|points?)/i.exec(raw);
    if (m) score = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  }

  if (!verdict) {
    if (score === null) verdict = normVerdict(raw);
    if (!verdict && score !== null) verdict = score >= 85 ? 'correct' : (score >= 60 ? 'almost' : 'wrong');
    if (!verdict) verdict = 'unknown';
  }
  if (score === null && verdict === 'correct') score = 90;
  if (score === null && verdict === 'almost') score = 70;
  if (score === null && verdict === 'wrong') score = 40;

  var used = pick(obj, ['usedTarget', 'used_target', 'used', 'targetUsed', '用上目标词']);
  if (typeof used === 'string') {
    var u = used.trim().toLowerCase();
    if (/^(true|yes|是|用了|用上了|有)/.test(u)) used = true;
    else if (/^(false|no|否|没用|没有|未)/.test(u)) used = false;
    else used = null;
  }
  if (typeof used !== 'boolean') used = null;

  var corrections = [];
  var rawCorr = pick(obj, ['corrections', 'fixes', '修改', 'correction']);
  if (typeof rawCorr === 'string') {
    rawCorr = rawCorr.split(/\n+/).filter(function (x) { return x.trim(); }).map(function (x) {
      return { before: x, after: '', why: '' };
    });
  }
  if (Array.isArray(rawCorr)) {
    rawCorr.slice(0, MAX_CORRECTIONS).forEach(function (c) {
      if (!c || typeof c !== 'object') {
        var t = clip(c, 200);
        if (t) corrections.push({ before: t, after: '', why: '' });
        return;
      }
      var before = clip(pick(c, ['before', 'from', 'wrong', '原句', '错误']), 120);
      var after = clip(pick(c, ['after', 'to', 'right', 'correct', '改正']), 120);
      var why = clip(pick(c, ['why', 'reason', 'explain', '说明', '原因']), 200);
      if (before || after || why) corrections.push({ before: before, after: after, why: why });
    });
  }

  return {
    verdict: verdict,
    score: score,
    usedTarget: used,
    reason: clip(pick(obj, ['reason', 'analysis', 'explanation', '思路', '分析']), 300),
    corrections: corrections,
    better: clip(pick(obj, ['better', 'improved', 'suggestion', 'natural', '更好的说法']), 300),
    comment: clip(pick(obj, ['comment', 'feedback', 'advice', 'note', '点评', '建议']), 300),
    parseError: false
  };
}

/* 模型返回文本的字段名各家不同，统一取出来 */
function extractText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out.response === 'string') return out.response;                               // Workers AI 文本模型
  if (out.result && typeof out.result.response === 'string') return out.result.response;   // REST
  if (Array.isArray(out.choices) && out.choices[0] && out.choices[0].message) {            // OpenAI 兼容
    var m = out.choices[0].message;
    if (typeof m.content === 'string' && m.content) return m.content;
    if (Array.isArray(m.content)) {  // 有的模型把 content 拆成数组
      return m.content.map(function (p) { return (p && p.text) || ''; }).join('');
    }
    return '';
  }
  try { return JSON.stringify(out); } catch (e) { return ''; }
}

/* 模型如果把「思考过程」单独放在字段里（reasoning_content 等），也取出来给用户看 */
function extractThinking(out) {
  if (!out || typeof out !== 'object') return '';
  var cands = [];
  if (Array.isArray(out.choices) && out.choices[0] && out.choices[0].message) {
    var m = out.choices[0].message;
    cands.push(m.reasoning_content, m.reasoning, m.thinking);
  }
  if (out.result && typeof out.result === 'object') cands.push(out.result.reasoning_content, out.result.reasoning);
  cands.push(out.reasoning_content, out.reasoning, out.thinking);
  for (var i = 0; i < cands.length; i++) {
    if (typeof cands[i] === 'string' && cands[i].trim()) return cands[i].trim();
  }
  return '';
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

/* 真正的一次模型调用：优先 Workers AI 绑定，其次 REST API */
async function callModel(env, model, payload) {
  if (env.AI && typeof env.AI.run === 'function') {
    var out = await env.AI.run(model, payload);
    return { text: extractText(out), thinking: clip(extractThinking(out), 1500), raw: out };
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
    var r = data && data.result;
    return { text: extractText(r), thinking: clip(extractThinking(r), 1500), raw: r };
  }

  var e2 = new Error('服务端未配置模型通道：需要绑定 Workers AI（变量名 AI），或设置 CF_ACCOUNT_ID + CF_API_TOKEN');
  e2.status = 503;
  throw e2;
}

function isParamError(e) {
  var m = String((e && e.message) || '');
  return /chat_template|unknown (field|argument|parameter)|invalid|unexpected|unrecognized|400/i.test(m);
}

/* 调模型 + 处理「思考模式」参数：带思考的模型关掉 thinking，参数不被接受就自动去掉重试 */
async function runModel(env, model, messages, opts) {
  opts = opts || {};
  var payload = {
    messages: messages,
    max_tokens: opts.maxTokens || MAX_TOKENS,
    temperature: opts.temperature === undefined ? 0.2 : opts.temperature
  };
  var wantNoThink = THINKING_MODEL_RE.test(String(model || ''));
  if (wantNoThink) payload.chat_template_kwargs = { enable_thinking: false };

  try {
    return await callModel(env, model, payload);
  } catch (e) {
    if (wantNoThink && isParamError(e)) {
      delete payload.chat_template_kwargs;
      try {
        return await callModel(env, model, payload);
      } catch (e2) {
        throw e; // 报原始错误，信息更有用
      }
    }
    throw e;
  }
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
    limits: { maxSentence: MAX_SENTENCE, maxTokens: MAX_TOKENS }
  });
}

/* POST：判一个句子 */
export async function onRequestPost(context) {
  var env = context.env || {};
  var startedAt = Date.now();

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
    '请批改，只输出 JSON。'
  ].join('\n');

  try {
    var out = await runModel(env, model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]);
    var judged = parseJudge(out.text);
    var attempts = 1;
    var rawText = out.text;
    var thinking = out.thinking || '';

    // 空回答 / 不是 JSON / 给不出明确判定 → 用更硬的提示再问一次
    // （实测 glm-4.7 这类思考型模型第一次经常是空回答或含糊回答）
    if (!String(out.text || '').trim() || judged.parseError || judged.verdict === 'unknown') {
      attempts = 2;
      var second = await runModel(env, model, [
        { role: 'system', content: RETRY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ], { maxTokens: 300, temperature: 0 });
      var judged2 = parseJudge(second.text);
      var takeSecond = judged2.verdict !== 'unknown' ||
        (judged.verdict === 'unknown' && String(second.text || '').trim().length > 0);
      if (takeSecond) {
        judged = judged2;
        rawText = second.text;
        if (second.thinking) thinking = second.thinking;
      }
    }

    var payload = {
      ok: true,
      model: model,
      verdict: judged.verdict,
      score: judged.score,
      usedTarget: judged.usedTarget,
      reason: judged.reason,
      corrections: judged.corrections,
      better: judged.better,
      comment: judged.comment,
      // 始终带回原文与诊断信息，前端可以展开给用户看
      raw: clip(rawText, 1200),
      thinking: thinking || '',
      attempts: attempts,
      ms: Date.now() - startedAt
    };
    if (judged.verdict === 'unknown') {
      payload.error = judged.parseError ? 'bad-model-output' : 'unknown-verdict';
      payload.message = judged.parseError
        ? '模型没有按 JSON 格式回答（已自动重试一次），下面是它的原文'
        : '模型这次没有给出明确判定（已自动重试一次），下面是它的原文';
    }
    return json(payload);
  } catch (e) {
    var status = (e && e.status) || 502;
    var text = (e && e.message) || 'AI 调用失败';
    var hint = '';
    if (/plan|paid|upgrade|403|5035/i.test(text)) {
      hint = '这个模型可能只对付费计划开放，换一个模型试试（例如 llama-3.3-70b / mistral-small）';
    } else if (/capacity|3040|429|rate/i.test(text)) {
      hint = '免费额度用完了或触发限流，过一会儿再试，或者换一个模型';
    }
    return json({
      error: 'model-error',
      message: text,
      hint: hint,
      model: model,
      ms: Date.now() - startedAt
    }, (status === 429 || status === 503) ? status : 502);
  }
}

/* 其它方法一律拒绝 */
export async function onRequest() {
  return json({ error: 'method-not-allowed' }, 405);
}

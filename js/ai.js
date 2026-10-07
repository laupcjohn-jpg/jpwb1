/* =========================================================
 * ai.js —— AI 造句判题（前端）
 *
 * 真正的模型调用在服务端（functions/api/ai.js），这里只负责：
 *   - 记住用户选的模型 / 是否把判定计入统计
 *   - 带上同步码当访问凭证，POST /api/ai
 *   - 把各种失败翻译成中文提示，并把超时、断网、未部署区分开
 *
 * 安全：浏览器里没有、也不需要任何 AI 密钥；密钥只在 Cloudflare 环境变量里。
 * ========================================================= */
window.AI = (function () {
  'use strict';

  var LS_MODEL = 'jpStudy.ai.model';
  var LS_RECORD = 'jpStudy.ai.record';
  var DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash';
  var TIMEOUT_MS = 45000;

  /* 免费计划可用、多语言（含日语）表现较好的候选；也能手填别的模型 ID */
  var MODELS = [
    { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7-Flash（推荐：多语言强、快）' },
    { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B（Google，多语言）' },
    { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B（中文/日语好）' },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B（稳）' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B' }
  ];

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
  }

  function getModel() {
    return lsGet(LS_MODEL) || DEFAULT_MODEL;
  }
  function setModel(id) {
    id = String(id == null ? '' : id).trim();
    lsSet(LS_MODEL, id || null);
    return getModel();
  }

  /* 是否把 AI 判定计入统计：默认记（用户可随时取消勾选） */
  function getRecord() {
    var v = lsGet(LS_RECORD);
    return v === null ? true : v === '1';
  }
  function setRecord(on) {
    lsSet(LS_RECORD, on ? '1' : '0');
    return getRecord();
  }

  /* 本机双击打开的页面没有后端，AI 用不了——提前说清楚，别让用户以为是 bug */
  function isLocalFile() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  function accessKey() {
    return (window.Sync && typeof Sync.getKey === 'function' && Sync.getKey()) || '';
  }

  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /* 服务器/网络的错误 → 中文提示 + 可操作的下一步 */
  function describe(res, data) {
    if (res.status === 401) {
      return '访问被拒绝：' + ((data && data.message) || '请确认侧边栏的同步码和部署上的一致');
    }
    if (res.status === 503) {
      return (data && data.message) || '服务端还没配置 AI（需要在 Cloudflare 里绑定 Workers AI）';
    }
    if (res.status === 429) {
      return 'AI 免费额度用完或触发限流了，过一会儿再试，或在侧边栏换一个模型';
    }
    var base = (data && data.message) || ('AI 调用失败（HTTP ' + res.status + '）');
    if (data && data.hint) base += '。' + data.hint;
    return base;
  }

  function request(path, opts) {
    var key = accessKey();
    opts = opts || {};
    if (isLocalFile()) {
      return Promise.reject(makeError('not-deployed',
        '这个页面是用「文件」打开的，AI 判题需要部署到 Cloudflare Pages 之后才能用'));
    }
    if (!key) {
      return Promise.reject(makeError('no-key',
        '请先在侧边栏填一个同步码并连接（AI 用它当访问凭证，不需要另外申请密钥）'));
    }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    return fetch(path, {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: Object.assign({ 'x-jp-key': key }, opts.headers || {}),
      body: opts.body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          // 宿主返回 HTML 404（例如静态托管没有 Functions）时，JSON 解析会失败
          if (!data && (res.status === 404 || res.status === 405)) {
            throw makeError('not-deployed',
              '这个站点没有 AI 后端（找不到 /api/ai）。部署到 Cloudflare Pages 并绑定 Workers AI 后才能用');
          }
          throw makeError('http-' + res.status, describe(res, data));
        }
        if (!data) {
          throw makeError('bad-response', 'AI 后端返回了无法解析的内容');
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.code) throw err;
      if (err && err.name === 'AbortError') {
        throw makeError('timeout', 'AI 响应超时了（' + Math.round(TIMEOUT_MS / 1000) + ' 秒），稍后再试');
      }
      throw makeError('network', '连不上 AI 后端：' + ((err && err.message) || '网络错误'));
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  /* 探测：后端在不在、用什么方式鉴权、默认模型是哪个（不消耗额度） */
  function probe() {
    return request('/api/ai', { method: 'GET' }).then(function (d) {
      // 后端在、但没绑定模型通道时也算不可用：提前说清楚，别等真去批改才报错
      if (d.ready === false) {
        throw makeError('no-channel',
          '服务端还没配置模型通道：需要在 Cloudflare 上给 Pages 绑定 Workers AI（变量名 AI），' +
          '或设置 CF_ACCOUNT_ID + CF_API_TOKEN');
      }
      return {
        ok: true,
        auth: d.auth,
        ready: true,
        model: d.model || getModel(),
        models: Array.isArray(d.models) && d.models.length ? d.models : MODELS.map(function (m) { return m.id; })
      };
    });
  }

  /**
   * 判一个句子。
   * word: { kanji, kana, pos, verbType, meaning }
   * 返回 { verdict:'correct'|'almost'|'wrong'|'unknown', score, corrections[], better, comment, raw? }
   */
  function judge(word, sentence) {
    sentence = String(sentence == null ? '' : sentence).trim();
    if (!sentence) {
      return Promise.reject(makeError('empty', '先写一个句子再提交'));
    }
    var w = word || {};
    return request('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: getModel(),
        sentence: sentence,
        word: {
          kanji: w.kanji || '',
          kana: w.kana || '',
          pos: w.pos || '',
          verbType: w.verbType || '',
          meaning: w.meaning || '',
          example: w.example || ''
        }
      })
    });
  }

  /* 判定结果 → 中文标签 / 是否算通过 */
  function verdictLabel(verdict) {
    if (verdict === 'correct') return '正确';
    if (verdict === 'almost') return '基本正确';
    if (verdict === 'wrong') return '需要修改';
    return '无法判定';
  }

  function isPass(verdict) {
    return verdict === 'correct';
  }

  return {
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    getModel: getModel,
    setModel: setModel,
    getRecord: getRecord,
    setRecord: setRecord,
    isLocalFile: isLocalFile,
    accessKey: accessKey,
    probe: probe,
    judge: judge,
    verdictLabel: verdictLabel,
    isPass: isPass
  };
})();

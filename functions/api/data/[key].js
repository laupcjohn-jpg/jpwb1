/* =========================================================
 * Cloudflare Pages Function —— 多端数据同步后端
 *
 * 路由：/api/data/:key        （key 就是用户的「同步码」）
 *   GET  → 读取该同步码对应的数据文档
 *   PUT  → 写入（乐观并发：baseUpdatedAt 与库里不一致时返回 409）
 *
 * 存储：D1 表 docs(key TEXT PRIMARY KEY, payload TEXT, updated_at INTEGER)
 * 绑定：需要在 Pages 项目里绑定一个 D1 数据库，变量名必须是 DB。
 *
 * 说明：不同同步码 = 不同用户，数据彼此隔离；同一个码 = 同一份数据。
 * 这里不做账号体系，同步码本身即为凭据，请提醒用户选足够私密的码。
 * ========================================================= */

var KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
var MAX_PAYLOAD = 4 * 1024 * 1024; // 4MB，防御超大请求体

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/* 建表只需在每个 isolate 里做一次，用模块级 Promise 缓存，避免每次请求都打一次 D1 */
var tableReady = null;
function ensureTable(env) {
  if (!tableReady) {
    tableReady = env.DB
      .prepare(
        'CREATE TABLE IF NOT EXISTS docs (' +
        '  key TEXT PRIMARY KEY,' +
        '  payload TEXT NOT NULL,' +
        '  updated_at INTEGER NOT NULL' +
        ')'
      )
      .run()
      .catch(function (e) {
        tableReady = null; // 失败则下次重试
        throw e;
      });
  }
  return tableReady;
}

/* 统一的入口校验：同步码格式 + D1 绑定是否存在 */
function preflight(context) {
  var key = context.params.key;
  if (!key || !KEY_RE.test(key)) {
    return { error: json({ error: 'invalid-key' }, 400) };
  }
  if (!context.env || !context.env.DB) {
    return { error: json({ error: 'db-not-bound' }, 503) };
  }
  return { key: key };
}

export async function onRequestGet(context) {
  var pre = preflight(context);
  if (pre.error) return pre.error;

  await ensureTable(context.env);
  var row = await context.env.DB
    .prepare('SELECT payload, updated_at FROM docs WHERE key = ?')
    .bind(pre.key)
    .first();

  if (!row) return json({ found: false, updatedAt: 0 }, 404);

  var payload;
  try {
    payload = JSON.parse(row.payload);
  } catch (e) {
    return json({ error: 'corrupt-document' }, 500);
  }
  return json({ found: true, payload: payload, updatedAt: row.updated_at });
}

export async function onRequestPut(context) {
  var pre = preflight(context);
  if (pre.error) return pre.error;

  var body;
  try {
    body = await context.request.json();
  } catch (e) {
    return json({ error: 'bad-json' }, 400);
  }

  var payload = body && body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'bad-payload' }, 400);
  }

  var text = JSON.stringify(payload);
  if (text.length > MAX_PAYLOAD) return json({ error: 'payload-too-large' }, 413);

  await ensureTable(context.env);

  var cur = await context.env.DB
    .prepare('SELECT payload, updated_at FROM docs WHERE key = ?')
    .bind(pre.key)
    .first();

  var base = Number(body.baseUpdatedAt) || 0;

  // 乐观并发：客户端基于的版本已被别人改过 → 把最新数据回给它，让它重新合并
  if (cur && base !== cur.updated_at) {
    var current;
    try {
      current = JSON.parse(cur.payload);
    } catch (e) {
      current = null;
    }
    return json(
      { conflict: true, payload: current, updatedAt: cur.updated_at },
      409
    );
  }

  var now = Date.now();
  await context.env.DB
    .prepare(
      'INSERT INTO docs (key, payload, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
    )
    .bind(pre.key, text, now)
    .run();

  return json({ ok: true, updatedAt: now });
}

/* 其余方法一律拒绝 */
export async function onRequest(context) {
  return json({ error: 'method-not-allowed' }, 405);
}

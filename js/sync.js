/* =========================================================
 * sync.js —— 多端数据同步
 *
 * 思路：localStorage 仍是主存储（离线可用），云端只是「同一个同步码共享的副本」。
 * 每次变更后防抖 2 秒，执行一次「拉取 → 合并 → 上传」：
 *   - 单词按 id 合并，同一 id 取 updatedAt 更大的一方（后改的赢）
 *   - 删除用「墓碑」传播，避免已删除的词被云端旧数据复活
 *   - 分类取并集
 * 网络失败时保留本地数据，只把状态置为失败，绝不因为同步而清空本地。
 *
 * 后端：/api/data/<同步码>（Cloudflare Pages Function + D1）
 * ========================================================= */
window.Sync = (function () {
  'use strict';

  var KEY_STORE = 'jpStudy.syncKey';
  var DEBOUNCE_MS = 2000;   // 变更后多久自动同步
  var RETRY_MS = 200;       // 同步中又发生变更时，处理完立刻补一次

  var state = { key: '', status: 'idle', message: '', lastSyncAt: 0 };
  var listeners = [];
  var appliedCbs = [];
  var timer = null;
  var syncing = false;
  var pending = false;
  var started = false;

  /* ---------- 同步码 ---------- */
  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }

  function setKey(code) {
    code = String(code == null ? '' : code).trim();
    try {
      if (code) localStorage.setItem(KEY_STORE, code);
      else localStorage.removeItem(KEY_STORE);
    } catch (e) { /* 存不下也不影响本次会话使用 */ }
    state.key = code;
    state.status = 'idle';
    state.message = code ? '等待同步' : '未设置同步码';
    emitState();
    return code;
  }

  function isValidKey(code) {
    return /^[A-Za-z0-9._-]{1,64}$/.test(String(code == null ? '' : code));
  }

  /* ---------- 状态订阅 ---------- */
  function onStatus(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  function onApplied(cb) {
    if (typeof cb === 'function') appliedCbs.push(cb);
  }

  function emitState() {
    listeners.forEach(function (cb) {
      try { cb(state.status, state.message, state.lastSyncAt); } catch (e) {}
    });
  }

  function emitApplied() {
    appliedCbs.forEach(function (cb) {
      try { cb(); } catch (e) {}
    });
  }

  function setStatus(status, message) {
    state.status = status;
    state.message = message || '';
    if (status === 'ok') state.lastSyncAt = Date.now();
    emitState();
  }

  /* ---------- 网络 ---------- */
  function apiUrl(key) {
    return '/api/data/' + encodeURIComponent(key);
  }

  /* 把 HTTP 状态映射成给用户看的话，方便排查（尤其是 D1 还没绑定时） */
  function describeStatus(code) {
    if (code === 503) return '服务端未绑定数据库（请在 Cloudflare 绑定 D1）';
    if (code === 400) return '同步码格式不合法';
    if (code === 413) return '数据太大，无法上传';
    if (code === 500) return '服务端数据异常';
    return '同步失败（HTTP ' + code + '）';
  }

  function pull(key) {
    return fetch(apiUrl(key), { method: 'GET', cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return null;            // 云端还没有数据，属正常
      if (!r.ok) throw new Error(describeStatus(r.status));
      return r.json().then(function (d) {
        if (!d || !d.found) return null;
        return { payload: d.payload, updatedAt: d.updatedAt };
      });
    });
  }

  function push(key, payload, baseUpdatedAt) {
    return fetch(apiUrl(key), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ payload: payload, baseUpdatedAt: baseUpdatedAt })
    }).then(function (r) {
      if (r.status === 409) {
        return r.json().then(function (c) {
          return { conflict: true, payload: c.payload, updatedAt: c.updatedAt };
        });
      }
      if (!r.ok) throw new Error(describeStatus(r.status));
      return r.json();
    });
  }

  /* ---------- 合并 ---------- */

  /**
   * 内容指纹：仅在 updatedAt 相同时用来定胜负。
   * 只要两端对同一份数据算出相同字符串即可，用途只是「确定性」。
   */
  function fingerprint(w) {
    var s = w.stats || {};
    return [
      w.kanji, w.kana, w.pos, w.meaning, w.example,
      s.appeared || 0, s.correct || 0, w.createdAt || 0
    ].join('');
  }

  /**
   * 把本地数据与云端文档合并成一份新文档。
   * remote 为 null 时表示云端还没有数据，直接采用本地。
   */
  function mergeWithRemote(remote) {
    var localWords = Store.all().slice();
    var localCats = Store.categories().slice();
    var localDeleted = Store.deletedMap();

    var remoteWords = (remote && remote.payload && remote.payload.words) || [];
    var remoteCats = (remote && remote.payload && remote.payload.cats) || [];
    var remoteDeleted = (remote && remote.payload && remote.payload.deleted) || {};

    // 1) 墓碑取并集：同一 id 保留最晚的删除时间
    var del = {};
    Object.keys(localDeleted).forEach(function (id) {
      del[id] = Math.max(del[id] || 0, localDeleted[id] || 0);
    });
    Object.keys(remoteDeleted).forEach(function (id) {
      del[id] = Math.max(del[id] || 0, remoteDeleted[id] || 0);
    });

    // 2) 单词按 id 合并，updatedAt 大者胜
    var byId = {};
    function keep(w) {
      if (!w || !w.id) return;
      var prev = byId[w.id];
      if (!prev) { byId[w.id] = w; return; }

      var a = w.updatedAt || 0;
      var b = prev.updatedAt || 0;
      if (a > b) { byId[w.id] = w; return; }

      // 时间戳打平时不能各留各的（那样两台设备永远收敛不到一起），
      // 用内容指纹裁决：两端算出的结果一致，保证最终收敛到同一个值。
      if (a === b && fingerprint(w) > fingerprint(prev)) byId[w.id] = w;
    }
    localWords.forEach(keep);
    remoteWords.forEach(keep);

    // 3) 墓碑优先：删除时间不早于该词最后修改时间 → 这个词就该是删掉的
    var picked = [];
    Object.keys(byId).forEach(function (id) {
      var w = byId[id];
      if (del[id] && del[id] >= (w.updatedAt || 0)) return; // 保持删除
      picked.push(w);
    });
    picked.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

    // 4) 分类取并集：本地顺序在前，云端新增的追加在后
    var cats = [];
    localCats.concat(remoteCats).forEach(function (c) {
      if (typeof c === 'string' && c.trim() && cats.indexOf(c.trim()) < 0) {
        cats.push(c.trim());
      }
    });
    if (!cats.length) cats = localCats;

    return { words: picked, cats: cats, deleted: del, updatedAt: Date.now() };
  }

  /* ---------- 同步主流程 ---------- */
  function runSync() {
    timer = null;

    var key = state.key || getKey();
    if (!key) { setStatus('idle', '未设置同步码'); return Promise.resolve(false); }

    if (syncing) { pending = true; return Promise.resolve(false); }
    syncing = true;
    setStatus('syncing', '同步中…');

    return pull(key)
      .then(function (remote) {
        var merged = mergeWithRemote(remote);
        Store.replaceAll(merged.words, merged.cats, merged.deleted);
        return push(key, merged, remote ? remote.updatedAt : 0);
      })
      .then(function (res) {
        if (!res.conflict) return null;
        // 上传期间别人改了云端：拿最新数据再合并一次重推
        var reMerged = mergeWithRemote({ payload: res.payload, updatedAt: res.updatedAt });
        Store.replaceAll(reMerged.words, reMerged.cats, reMerged.deleted);
        return push(key, reMerged, res.updatedAt).then(function (res2) {
          if (res2.conflict) throw new Error('有其它设备正在同步，请稍后重试');
          return null;
        });
      })
      .then(function () {
        setStatus('ok', '已同步');
        emitApplied();
        return true;
      })
      .catch(function (e) {
        // 同步失败只影响「云端副本」，本地数据完好无损
        var msg = (e && e.message) ? e.message : '网络不可用，稍后重试';
        setStatus('error', msg);
        return false;
      })
      .then(function (result) {
        syncing = false;
        if (pending) { pending = false; schedule(RETRY_MS); }
        return result;
      });
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { runSync(); }, delay === undefined ? DEBOUNCE_MS : delay);
  }

  /* ---------- 对外的同步入口 ---------- */
  function syncNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    return runSync();
  }

  /**
   * 启动：读取已保存的同步码；有变更就自动排队上传；打开页面先同步一次。
   * 由 app.js 在 DOM 就绪后调用。
   */
  function init() {
    if (started) return;
    started = true;

    state.key = getKey();
    state.status = 'idle';
    state.message = state.key ? '等待同步' : '未设置同步码';

    Store.onChange(function () {
      if (state.key) schedule();
    });

    if (state.key) syncNow();
    emitState();
  }

  return {
    init: init,
    getKey: getKey,
    setKey: setKey,
    isValidKey: isValidKey,
    syncNow: syncNow,
    onStatus: onStatus,
    onApplied: onApplied,
    status: function () { return state; }
  };
})();

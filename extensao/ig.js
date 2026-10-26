// Fala com o Instagram usando a sessão já aberta no navegador.
//
// Importante: os cookies de login do Instagram são SameSite, então um fetch feito
// da página da extensão (origem chrome-extension://) chega DESLOGADO. Por isso
// executamos cada fetch DENTRO de uma aba do instagram.com (mesma origem), via
// chrome.scripting. Aí os cookies de primeira parte são enviados normalmente.
"use strict";

const IG = "https://www.instagram.com";

class IgError extends Error {
  constructor(kind, detail) {
    super(kind + (detail ? " " + detail : ""));
    this.kind = kind; // auth | rate | checkpoint | http | notfound | private | network | notab
    this.detail = detail || "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getCookie(name) {
  return new Promise((resolve) =>
    chrome.cookies.get({ url: IG + "/", name }, (c) => resolve(c && c.value ? c.value : null))
  );
}

async function myUserId() {
  return await getCookie("ds_user_id");
}

// Função injetada na aba do instagram.com. Precisa ser autossuficiente (roda noutro contexto).
function pageFetch(path, method) {
  var csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
  var headers = {
    "x-ig-app-id": "936619743392459",
    "x-csrftoken": csrf,
    "x-requested-with": "XMLHttpRequest",
  };
  var opts = { method: method, credentials: "include", headers: headers };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    opts.body = "";
  }
  return fetch("https://www.instagram.com" + path, opts)
    .then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) {}
        return { status: r.status, json: j, snippet: t ? t.slice(0, 80) : "" };
      });
    })
    .catch(function (e) { return { status: 0, json: null, neterr: true, err: String((e && e.message) || e) }; });
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

let igTab = null;

async function igTabId() {
  // reaproveita uma aba aberta do instagram.com; senão abre uma em segundo plano
  const tabs = await chrome.tabs.query({ url: ["https://www.instagram.com/*", "https://*.instagram.com/*"] });
  if (tabs.length) return tabs[0].id;
  if (igTab) {
    try { await chrome.tabs.get(igTab); return igTab; } catch (e) { igTab = null; }
  }
  const tab = await chrome.tabs.create({ url: IG + "/", active: false });
  igTab = tab.id;
  await waitTabComplete(tab.id);
  await sleep(1500);
  return tab.id;
}

async function igFetch(path, method = "GET") {
  let tabId;
  try {
    tabId = await igTabId();
  } catch (e) {
    throw new IgError("notab", String((e && e.message) || e));
  }
  let out;
  try {
    // world MAIN: roda como código da própria página do Instagram (cookies + CSP de 1ª parte)
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: pageFetch, args: [path, method],
    });
    out = results && results[0] && results[0].result;
  } catch (e) {
    throw new IgError("network", "exec: " + String((e && e.message) || e));
  }
  if (!out) throw new IgError("network", "sem retorno da aba");
  if (out.neterr) throw new IgError("network", out.err || "fetch falhou");
  const { status, json } = out;
  if (status === 401 || status === 403) throw new IgError("auth", "HTTP " + status);
  if (status === 429) throw new IgError("rate");
  if (status === 404) throw new IgError("notfound");
  if (json && json.message && String(json.message).toLowerCase().includes("checkpoint")) throw new IgError("checkpoint");
  if (json && json.message === "Please wait a few minutes before you try again.") throw new IgError("rate");
  if (status < 200 || status >= 300) {
    if (!json) throw new IgError("auth", "HTTP " + status + " " + (out.snippet || ""));
    throw new IgError("http", String(status));
  }
  return json;
}

// Confirma que há sessão (cookie de login presente).
async function whoAmI() {
  const id = await myUserId();
  if (!id) throw new IgError("auth");
  return { id: String(id), username: "", pic: "" };
}

async function profileByUsername(username) {
  let j;
  try {
    j = await igFetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  } catch (e) {
    if (e.kind === "notfound") throw new IgError("notfound");
    throw e;
  }
  const u = j && j.data && j.data.user;
  if (!u) throw new IgError("notfound");
  return {
    id: String(u.id),
    username: u.username,
    full_name: u.full_name || "",
    pic: u.profile_pic_url || "",
    is_private: !!u.is_private,
    followed_by_viewer: !!u.followed_by_viewer,
    followers: (u.edge_followed_by && u.edge_followed_by.count) || 0,
    following: (u.edge_follow && u.edge_follow.count) || 0,
  };
}

function shortUser(u) {
  return {
    pk: String(u.pk),
    username: u.username,
    full_name: u.full_name || "",
    pic: u.profile_pic_url || "",
  };
}

async function fullList(userId, kind, onProgress, shouldStop) {
  const out = {};
  let maxId = "";
  for (let guard = 0; guard < 5000; guard++) {
    if (shouldStop && shouldStop()) break;
    const q =
      `/api/v1/friendships/${userId}/${kind}/?count=200` +
      (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
    const j = await igFetch(q);
    for (const u of (j && j.users) || []) out[String(u.pk)] = u;
    if (onProgress) onProgress(Object.keys(out).length);
    if (!j || !j.next_max_id) break;
    maxId = j.next_max_id;
    await sleep(700 + Math.random() * 1100);
  }
  return out;
}

async function unfollow(userId) {
  const j = await igFetch(`/api/v1/friendships/destroy/${userId}/`, "POST");
  if (j && j.status === "ok") return true;
  if (j && j.friendship_status && j.friendship_status.following === false) return true;
  return false;
}

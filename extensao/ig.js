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
  // reaproveita uma aba aberta e carregada do instagram.com (as que o Chrome pôs para
  // dormir não aceitam scripts); senão abre uma em segundo plano
  const tabs = await chrome.tabs.query({
    url: ["https://www.instagram.com/*", "https://*.instagram.com/*"], discarded: false, status: "complete",
  });
  if (tabs.length) return (tabs.find((t) => t.active) || tabs[0]).id;
  if (igTab) {
    try { await chrome.tabs.get(igTab); return igTab; } catch (e) { igTab = null; }
  }
  const tab = await chrome.tabs.create({ url: IG + "/", active: false });
  igTab = tab.id;
  await waitTabComplete(tab.id);
  await sleep(1500);
  return tab.id;
}

// Executa `func(...args)` dentro de uma aba do instagram.com e devolve o resultado.
async function inIgTab(func, args) {
  let tabId;
  try {
    tabId = await igTabId();
  } catch (e) {
    throw new IgError("notab", String((e && e.message) || e));
  }
  try {
    // world MAIN: roda como código da própria página do Instagram (cookies + CSP de 1ª parte)
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func, args,
      injectImmediately: true, // não espera o "document_idle", que pode travar no Instagram
    });
    return results && results[0] && results[0].result;
  } catch (e) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    throw new IgError("network", "exec: " + String((e && e.message) || e) +
      ` [aba ${tabId} ${t ? t.status + " " + t.url : "?"}]`);
  }
}

async function igFetch(path, method = "GET") {
  const out = await inIgTab(pageFetch, [path, method]);
  if (!out) throw new IgError("network", "sem retorno da aba");
  if (out.neterr) throw new IgError("network", out.err || "fetch falhou");
  const { status, json } = out;
  if (status === 401 || status === 403) throw new IgError("auth", "HTTP " + status);
  if (status === 429) throw new IgError("rate");
  if (status === 404) throw new IgError("notfound");
  if (json && json.message && String(json.message).toLowerCase().includes("checkpoint")) throw new IgError("checkpoint");
  if (json && json.message === "Please wait a few minutes before you try again.") throw new IgError("rate");
  if (json && json.message && String(json.message).toLowerCase().includes("not authorized")) throw new IgError("private");
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

// Injetada na aba do instagram.com: lê a página pública do perfil e tira dela só o
// id e os totais aproximados (da descrição "686M seguidores, 241 seguindo, ...").
function pageProfile(username) {
  return fetch("https://www.instagram.com/" + encodeURIComponent(username) + "/", { credentials: "include" })
    .then(function (r) {
      return r.text().then(function (t) {
        var id = (t.match(/"profile_id":"(\d+)"/) || t.match(/"profilePage_(\d+)"/) || [])[1] || null;
        var m = t.match(/content="([^"]+?) (?:Followers|seguidores), ([^"]+?) (?:Following|seguindo)/i);
        return { status: r.status, id: id, followers: m ? m[1] : "", following: m ? m[2] : "" };
      });
    })
    .catch(function (e) { return { status: 0, err: String((e && e.message) || e) }; });
}

// "686M", "1,2 mil", "12.345", "3.4K", "2 mi" → número aproximado
function parseCount(s) {
  const m = String(s || "").trim().toLowerCase().match(/^([\d.,]+)\s*(mil|mi|k|m|b)?/);
  if (!m) return 0;
  const mult = { mil: 1e3, k: 1e3, mi: 1e6, m: 1e6, b: 1e9 }[m[2]] || 1;
  // com multiplicador, "," ou "." é decimal; sem, são separadores de milhar
  const num = mult > 1 ? parseFloat(m[1].replace(",", ".")) : parseInt(m[1].replace(/[.,]/g, ""), 10);
  return Math.round((num || 0) * mult);
}

// Plano B quando web_profile_info está limitado (429) mas o resto da API funciona.
async function profileFromPage(username) {
  const out = await inIgTab(pageProfile, [username]);
  if (!out || out.status === 0) throw new IgError("network", (out && out.err) || "sem retorno da aba");
  if (out.status === 404 || !out.id) throw new IgError("notfound");
  return {
    id: String(out.id), username, full_name: "", pic: "",
    // a página não diz com segurança se é privado; a própria lista avisa ("private")
    is_private: false, followed_by_viewer: false,
    followers: parseCount(out.followers), following: parseCount(out.following),
  };
}

async function profileByUsername(username) {
  let j;
  try {
    j = await igFetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  } catch (e) {
    if (e.kind === "notfound") throw new IgError("notfound");
    if (e.kind === "rate") return profileFromPage(username);
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

// Contas que eu sigo e que seguem `userId` — o próprio Instagram calcula ("Seguido por ...").
// Bem mais leve que baixar a lista inteira de seguidores de um perfil grande.
async function mutualFollowers(userId, onProgress, shouldStop) {
  const out = {};
  let maxId = "";
  for (let guard = 0; guard < 500; guard++) {
    if (shouldStop && shouldStop()) break;
    const j = await igFetch(`/api/v1/friendships/${userId}/mutual_followers/` +
      (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""));
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

// Recarga automática — só para desenvolvimento.
//
// Só liga se existir dev.json na pasta da extensão (ele NÃO vai no .zip público).
// Quando algum arquivo listado em dev.json muda no disco, a extensão se recarrega
// sozinha (chrome.runtime.reload), reabre a página do app e recarrega as abas de teste
// (instagram.com/#limpalixo-dev), sem ninguém precisar ir em chrome://extensions.
// Roda no service worker (importScripts) e na página do app (<script>).
"use strict";

const DEV_HASH = "#limpalixo-dev";

// Lê um arquivo da pasta da extensão (sem opção de cache: em chrome-extension:// ela
// pode fazer o fetch falhar, e o arquivo já vem do disco).
async function devRead(file) {
  const r = await fetch(chrome.runtime.getURL(file));
  if (!r.ok) throw new Error(file + " HTTP " + r.status);
  return r.text();
}

async function devConfig() {
  try {
    return JSON.parse(await devRead("dev.json"));
  } catch (e) {
    return null;
  }
}

// Impressão digital dos arquivos observados.
async function devFingerprint(files) {
  const parts = await Promise.all(files.map(async (f) => {
    try {
      return f + "\n" + (await devRead(f));
    } catch (e) {
      return f + "\n(ausente)";
    }
  }));
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n\0")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const devGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
const devSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

// Chamado quando a extensão (re)carrega: grava a versão atual como base.
async function devStart() {
  const cfg = await devConfig();
  if (!cfg) {
    chrome.alarms.clear("dev-reload");
    return;
  }
  await devSet({ devFp: await devFingerprint(cfg.watch), devLoadedAt: Date.now() });
  chrome.alarms.create("dev-reload", { periodInMinutes: 0.5 });

  const { devReopen } = await devGet(["devReopen"]);
  if (!devReopen) return;
  await devSet({ devReopen: null });
  const appUrl = chrome.runtime.getURL("app.html");
  if (devReopen.app && !(await chrome.tabs.query({ url: appUrl })).length) {
    chrome.tabs.create({ url: appUrl, active: false });
  }
  for (const id of devReopen.tabs || []) chrome.tabs.reload(id).catch(() => {});
}

// Aba de teste carregada: injeta a ponte e garante a página do app aberta (em segundo
// plano). Usa injectImmediately porque esperar o "document_idle" pode travar no Instagram.
async function devOnTab(tabId, info, tab) {
  // qualquer atualização serve (o "complete" pode nunca chegar); a ponte só se instala uma vez
  if (!tab.url || !tab.url.startsWith("https://www.instagram.com/")) return;
  if (!tab.url.includes(DEV_HASH) || !(await devConfig())) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ["dev-bridge.js"], injectImmediately: true })
    .catch(() => {});
  const appUrl = chrome.runtime.getURL("app.html");
  if (!(await chrome.tabs.query({ url: appUrl })).length) chrome.tabs.create({ url: appUrl, active: false });
}

// Compara o disco com a versão carregada; se mudou, recarrega.
async function devCheck() {
  const cfg = await devConfig();
  if (!cfg) return;
  const { devFp, devBusyAt } = await devGet(["devFp", "devBusyAt"]);
  const fp = await devFingerprint(cfg.watch);
  if (!devFp) { await devSet({ devFp: fp, devLoadedAt: Date.now() }); return; }
  if (fp === devFp) return;
  // não interrompe uma comparação ou um "deixar de seguir" em andamento
  if (devBusyAt && Date.now() - devBusyAt < 15000) return;
  const appTabs = await chrome.tabs.query({ url: chrome.runtime.getURL("app.html") });
  const igTabs = (await chrome.tabs.query({ url: "https://www.instagram.com/*" }))
    .filter((t) => t.url && t.url.includes(DEV_HASH));
  await devSet({ devReopen: { app: appTabs.length > 0, tabs: igTabs.map((t) => t.id) } });
  chrome.runtime.reload();
}

// Na página do app: confere a cada 2 s, avisa quando está ocupado e mostra a versão.
if (typeof document !== "undefined") {
  devConfig().then(async (cfg) => {
    if (!cfg) return;
    const { devFp, devLoadedAt } = await devGet(["devFp", "devLoadedAt"]);
    const tag = document.createElement("div");
    tag.id = "devTag";
    tag.textContent = `dev · ${devFp || "?"} · carregada ${new Date(devLoadedAt || Date.now()).toLocaleTimeString("pt-BR")}`;
    tag.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9;padding:2px 8px;border-radius:6px;background:#222;color:#fff;font:12px/1.6 monospace;opacity:.8";
    document.body.appendChild(tag);
    setInterval(() => {
      if (typeof window.devBusy === "function" && window.devBusy()) devSet({ devBusyAt: Date.now() });
      devCheck();
    }, 2000);

    // Ponte com as abas de teste (ver dev-bridge.js): manda o que está na tela e
    // aceita cliques/preenchimentos, para dar para testar por JavaScript.
    setInterval(async () => {
      const status = { tag: tag.textContent, at: Date.now(), text: document.body.innerText.slice(0, 6000) };
      for (const t of await chrome.tabs.query({ url: "https://www.instagram.com/*" })) {
        if (t.url && t.url.includes(DEV_HASH)) chrome.tabs.sendMessage(t.id, { limpalixoDev: status }).catch(() => {});
      }
    }, 1000);
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      const cmd = msg && msg.limpalixoCmd;
      if (!cmd) return;
      const el = document.querySelector(cmd.sel);
      if (!el) { reply("não achei " + cmd.sel); return; }
      if (cmd.op === "click") el.click();
      if (cmd.op === "fill") { el.value = cmd.value; el.dispatchEvent(new Event("input", { bubbles: true })); }
      reply("ok");
    });
  });
}

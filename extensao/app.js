"use strict";
// Mostra qualquer erro inesperado na própria tela (diagnóstico).
function fatal(msg) {
  try {
    let d = document.getElementById("fatal");
    if (!d) {
      d = document.createElement("pre");
      d.id = "fatal";
      d.style.cssText = "margin:16px;padding:12px;background:#fbe3e0;color:#7f1414;white-space:pre-wrap;border-radius:8px;font:13px/1.45 monospace";
      (document.body || document.documentElement).appendChild(d);
    }
    d.textContent = "Detalhe técnico: " + msg;
  } catch (e) {}
}
window.addEventListener("error", (ev) => fatal(ev.message));
window.addEventListener("unhandledrejection", (ev) => fatal((ev.reason && (ev.reason.message || ev.reason.kind)) || String(ev.reason)));

const $ = (id) => document.getElementById(id);

const DELAY_MIN = 20, DELAY_MAX = 45, DAILY_LIMIT = 150, MAX_TARGET = 50000, WARN_TARGET = 6000;

const fmt = (n) => n.toLocaleString("pt-BR");
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
// `sleep` vem de ig.js (carregado antes); não redeclarar aqui.
const announce = (m) => { $("announce").textContent = ""; setTimeout(() => ($("announce").textContent = m), 50); };
function minutes(sec) {
  if (sec < 90) return "cerca de 1 minuto";
  const m = Math.round(sec / 60);
  return m < 60 ? `cerca de ${m} minutos` : `cerca de ${Math.floor(m / 60)} h ${m % 60} min`;
}

const state = { me: null, users: [], running: false, stopCompare: false, stopUnfollow: false };

// ---------- limite diário (no próprio navegador) ----------
function today() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // ~Brasília
  return d.toISOString().slice(0, 10);
}
function usageGet() {
  return new Promise((res) => chrome.storage.local.get(["usage"], (o) => {
    const u = o.usage || {};
    res(u.date === today() ? u.count : 0);
  }));
}
function usageAdd(n) {
  return new Promise((res) => chrome.storage.local.get(["usage"], (o) => {
    const u = o.usage || {};
    const count = (u.date === today() ? u.count : 0) + n;
    chrome.storage.local.set({ usage: { date: today(), count } }, () => res(count));
  }));
}

// ---------- conexão ----------
async function checkConnection() {
  try {
    state.me = await whoAmI();
    showConnected(true);
    if (state.me.username) {
      $("meBox").innerHTML = "";
      if (state.me.pic) {
        const img = document.createElement("img");
        img.className = "av"; img.src = state.me.pic; img.alt = "";
        $("meBox").append(img);
      }
      $("meBox").append(document.createTextNode("@" + state.me.username));
    } else {
      $("meBox").textContent = "Conectado";
    }
  } catch (e) {
    showConnected(false);
    $("offErr").textContent = e.kind === "checkpoint"
      ? "O Instagram pediu uma verificação. Abra o app do Instagram, confirme que é você e tente de novo."
      : "";
  }
}
function showConnected(on) {
  $("offView").classList.toggle("hidden", on);
  $("onView").classList.toggle("hidden", !on);
  $("meBox").classList.toggle("hidden", !on);
  if (!on) { $("bar").classList.add("hidden"); }
}
$("recheck").addEventListener("click", checkConnection);

// ---------- mensagens de erro ----------
function igMessage(e) {
  const d = e && e.detail ? ` (${e.detail})` : "";
  switch (e && e.kind) {
    case "auth": return "Sua sessão do Instagram expirou. Abra o instagram.com, entre de novo e clique em “Verificar de novo”." + d;
    case "rate": return "O Instagram limitou as ações por um tempo. Espere algumas horas antes de continuar.";
    case "checkpoint": return "O Instagram pediu uma verificação. Abra o app do Instagram, confirme que é você e tente de novo.";
    case "notfound": return "Não encontramos esse perfil. Confira o @.";
    case "private": return "Esse perfil é privado e você não segue, então a lista não aparece.";
    case "notab": return "Abra uma aba do instagram.com e tente de novo." + d;
    case "network": return "Falha ao falar com o Instagram." + d;
    default: return "Algo deu errado ao falar com o Instagram." + d;
  }
}

// ---------- comparação ----------
$("cmpStop").addEventListener("click", () => { state.stopCompare = true; });

$("cmpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("cmpErr").textContent = "";
  let target = $("target").value.trim().replace(/^@/, "");
  if (target.includes("instagram.com/")) target = target.split("instagram.com/")[1].split(/[/?]/)[0];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(target)) {
    $("target").setAttribute("aria-invalid", "true");
    $("cmpErr").textContent = "Digite um @ válido.";
    $("target").focus();
    return;
  }
  $("target").removeAttribute("aria-invalid");
  const mode = document.querySelector("input[name=mode]:checked").value;

  state.stopCompare = false;
  $("cmpBtn").disabled = true;
  $("cmpStop").classList.remove("hidden");
  $("resCard").classList.add("hidden");
  $("bar").classList.add("hidden");
  try {
    $("cmpMsg").textContent = `Buscando @${target}…`;
    const prof = await profileByUsername(target);
    if (prof.is_private && prof.id !== state.me.id && !prof.followed_by_viewer) {
      throw { kind: "private" };
    }
    const total = mode === "followers" ? prof.followers : prof.following;
    if (total > MAX_TARGET) throw { kind: "msg", msg: `Esse perfil tem ${fmt(total)} contas nessa lista; o limite é ${fmt(MAX_TARGET)}. Tente a outra opção ou um perfil menor.` };
    if (total > WARN_TARGET) {
      const ok = await confirmDialog("Lista grande",
        `<p>@${target} tem ${fmt(total)} contas nessa lista. Baixar tudo pode levar bastante tempo e fazer o Instagram limitar sua conta.</p><p>Quer continuar?</p>`, "Continuar");
      if (!ok) throw { kind: "cancel" };
    }

    $("cmpMsg").textContent = "Carregando quem você segue…";
    const mine = await fullList(state.me.id, "following",
      (n) => ($("cmpMsg").textContent = `Carregando quem você segue… ${fmt(n)}`),
      () => state.stopCompare);

    const label = mode === "followers" ? "seguidores" : "contas seguidas";
    const theirs = await fullList(prof.id, mode,
      (n) => ($("cmpMsg").textContent = `Carregando ${label} de @${target}… ${fmt(n)}`),
      () => state.stopCompare);

    if (state.stopCompare) { $("cmpMsg").textContent = "Busca interrompida."; return; }

    const common = [];
    for (const pk of Object.keys(mine)) {
      if (theirs[pk] && pk !== prof.id) common.push(shortUser(mine[pk]));
    }
    common.sort((a, b) => a.username.localeCompare(b.username));
    render({ target: prof, mode, myFollowing: Object.keys(mine).length, theirCount: Object.keys(theirs).length, users: common });
    $("cmpMsg").textContent = "";
  } catch (e) {
    if (e.kind === "cancel") $("cmpMsg").textContent = "";
    else { $("cmpErr").textContent = e.kind === "msg" ? e.msg : igMessage(e); $("cmpMsg").textContent = ""; }
  } finally {
    $("cmpBtn").disabled = false;
    $("cmpStop").classList.add("hidden");
  }
});

function render(res) {
  state.users = res.users;
  const t = "@" + res.target.username;
  $("resCard").classList.remove("hidden");
  $("bar").classList.remove("hidden");
  $("resTitle").textContent = res.users.length
    ? `${plural(res.users.length, "conta em comum", "contas em comum")} com ${t}`
    : `Nenhuma conta em comum com ${t}`;
  $("resSub").textContent = `Você segue ${fmt(res.myFollowing)}. ${t} tem ${fmt(res.theirCount)} ${res.mode === "followers" ? "seguidores" : "contas seguidas"} carregadas.`;
  $("emptyMsg").classList.toggle("hidden", res.users.length > 0);
  $("filter").value = "";
  const list = $("list");
  list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const u of res.users) {
    const li = document.createElement("li");
    li.dataset.pk = u.pk;
    li.dataset.q = (u.username + " " + u.full_name).toLowerCase();
    const label = document.createElement("label");
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", value: u.pk });
    const img = Object.assign(document.createElement("img"), { className: "av", alt: "", loading: "lazy" });
    if (u.pic) img.src = u.pic;
    const names = document.createElement("span"); names.className = "names";
    const un = Object.assign(document.createElement("span"), { className: "uname", textContent: "@" + u.username });
    const fn = Object.assign(document.createElement("span"), { className: "fullname", textContent: u.full_name });
    const tag = Object.assign(document.createElement("span"), { className: "tag" });
    names.append(un, fn, tag);
    label.append(cb, img, names);
    const a = Object.assign(document.createElement("a"), {
      className: "open", href: "https://www.instagram.com/" + encodeURIComponent(u.username) + "/",
      target: "_blank", rel: "noopener noreferrer", textContent: "Ver perfil",
    });
    li.append(label, a);
    frag.append(li);
  }
  list.append(frag);
  $("all").checked = false;
  $("resTitle").focus();
  updateBar();
}

const visibleBoxes = () => [...$("list").querySelectorAll("li:not(.hidden):not(.gone) input")];
const selected = () => [...$("list").querySelectorAll("li:not(.gone) input:checked")].map((b) => b.value);

$("list").addEventListener("change", updateBar);
$("all").addEventListener("change", () => { visibleBoxes().forEach((b) => (b.checked = $("all").checked)); updateBar(); });
$("filter").addEventListener("input", () => {
  const q = $("filter").value.trim().toLowerCase().replace(/^@/, "");
  let shown = 0;
  $("list").querySelectorAll("li").forEach((li) => { const hit = li.dataset.q.includes(q); li.classList.toggle("hidden", !hit); shown += hit; });
  $("countMsg").textContent = q ? plural(shown, "conta exibida", "contas exibidas") : "";
  syncAll();
});
function syncAll() {
  const boxes = visibleBoxes();
  const n = boxes.filter((b) => b.checked).length;
  $("all").checked = boxes.length > 0 && n === boxes.length;
  $("all").indeterminate = n > 0 && n < boxes.length;
}
async function updateBar() {
  syncAll();
  if (state.running) return;
  const n = selected().length;
  const rem = DAILY_LIMIT - (await usageGet());
  $("unfBtn").disabled = n === 0;
  $("unfBtn").textContent = n ? `Deixar de seguir ${plural(n, "conta", "contas")}` : "Deixar de seguir";
  let msg = n ? `${plural(n, "selecionada", "selecionadas")}.` : "Marque as contas que você quer deixar de seguir.";
  msg += ` Hoje você ainda pode deixar de seguir ${fmt(Math.max(0, rem))}.`;
  $("barMsg").textContent = msg;
}

// ---------- confirmação ----------
function confirmDialog(title, bodyHtml, okLabel) {
  const dlg = $("confirmDlg");
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = bodyHtml;
  $("dlgOk").textContent = okLabel;
  const opener = document.activeElement;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); if (opener && opener.focus) opener.focus(); resolve(v); };
    $("dlgOk").onclick = () => done(true);
    $("dlgCancel").onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
  });
}

// ---------- unfollow ----------
$("unfBtn").addEventListener("click", async () => {
  let pks = selected();
  if (!pks.length) return;
  const rem = DAILY_LIMIT - (await usageGet());
  if (rem <= 0) { $("barMsg").textContent = "Você já atingiu o limite de hoje. Volte amanhã."; announce($("barMsg").textContent); return; }
  if (pks.length > rem) {
    const ok = await confirmDialog("Passou do limite de hoje",
      `<p>Hoje você ainda pode deixar de seguir ${fmt(rem)} contas. Vamos processar as primeiras ${fmt(rem)} e você continua amanhã.</p>`, "Continuar com " + fmt(rem));
    if (!ok) return;
    pks = pks.slice(0, rem);
  }
  const avg = (DELAY_MIN + DELAY_MAX) / 2 + 3;
  const ok = await confirmDialog(`Deixar de seguir ${plural(pks.length, "conta", "contas")}?`,
    `<p>Isso leva ${minutes(pks.length * avg)}, porque fazemos uma pausa entre cada conta para proteger seu perfil.</p>` +
    "<p><strong>Não feche esta aba enquanto estiver rodando.</strong> Você pode parar quando quiser.</p>" +
    "<p>Não dá para desfazer por aqui. Para voltar a seguir, use o Instagram.</p>", "Sim, deixar de seguir");
  if (!ok) return;
  runUnfollow(pks);
});

$("stopBtn").addEventListener("click", () => { state.stopUnfollow = true; $("barMsg").textContent = "Parando…"; });

function markRow(pk, cls, text) {
  const li = $("list").querySelector(`li[data-pk="${CSS.escape(pk)}"]`);
  if (!li || li.classList.contains(cls)) return;
  li.classList.add(cls);
  const cb = li.querySelector("input");
  const tag = li.querySelector(".tag");
  tag.textContent = text;
  tag.classList.add(cls === "gone" ? "ok" : "fail");
  if (cls === "gone") { cb.checked = false; cb.disabled = true; }
}

async function runUnfollow(pks) {
  state.running = true;
  state.stopUnfollow = false;
  $("prog").classList.remove("hidden");
  $("stopBtn").classList.remove("hidden");
  $("unfBtn").classList.add("hidden");
  $("prog").max = pks.length; $("prog").value = 0;
  let done = 0, failed = 0, stoppedMsg = "";

  for (let i = 0; i < pks.length; i++) {
    if (state.stopUnfollow) break;
    const avg = (DELAY_MIN + DELAY_MAX) / 2 + 3;
    $("barMsg").textContent = `${fmt(i)} de ${fmt(pks.length)} — falta ${minutes((pks.length - i) * avg)}.`;
    try {
      const okk = await unfollow(pks[i]);
      if (okk) { markRow(pks[i], "gone", "Deixou de seguir"); done++; await usageAdd(1); }
      else { markRow(pks[i], "fail", "Não foi possível"); failed++; }
    } catch (e) {
      markRow(pks[i], "fail", "Não foi possível"); failed++;
      if (e.kind === "rate" || e.kind === "checkpoint" || e.kind === "auth") { stoppedMsg = igMessage(e); break; }
    }
    $("prog").value = i + 1;
    if (i < pks.length - 1 && !state.stopUnfollow) {
      const wait = (DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000;
      const end = Date.now() + wait;
      while (Date.now() < end && !state.stopUnfollow) await sleep(500);
    }
  }

  state.running = false;
  $("prog").classList.add("hidden");
  $("stopBtn").classList.add("hidden");
  $("unfBtn").classList.remove("hidden");
  let msg = state.stopUnfollow ? "Interrompido. " : "Pronto! ";
  msg += `Você deixou de seguir ${plural(done, "conta", "contas")}.`;
  if (failed) msg += ` ${plural(failed, "não pôde", "não puderam")} ser processadas.`;
  if (stoppedMsg) msg += " " + stoppedMsg;
  $("barMsg").textContent = msg;
  announce(msg);
  updateBar();
}

window.addEventListener("beforeunload", (e) => {
  if (state.running) { e.preventDefault(); e.returnValue = ""; }
});

// usado pela recarga automática de desenvolvimento para não interromper nada em andamento
window.devBusy = () => state.running || $("cmpBtn").disabled;

// ---------- início ----------
checkConnection();

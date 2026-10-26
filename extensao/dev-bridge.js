// Só em desenvolvimento (injetado por dev-reload.js quando existe dev.json) na aba
// https://www.instagram.com/#limpalixo-dev. Ponte para testar o app por JavaScript
// a partir dessa aba comum:
//  - o que está na tela do app aparece em document.documentElement.dataset.limpalixo (JSON);
//  - window.postMessage({ limpalixoCmd: { op: "click" | "fill", sel, value } }, "*")
//    clica ou preenche um elemento na tela do app.
if (!window.__limpalixoBridge) {
  window.__limpalixoBridge = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.limpalixoDev) document.documentElement.dataset.limpalixo = JSON.stringify(msg.limpalixoDev);
  });
  window.addEventListener("message", (ev) => {
    if (!ev.data || !ev.data.limpalixoCmd) return;
    const sent = (r) => (document.documentElement.dataset.limpalixoSent = JSON.stringify({ cmd: ev.data.limpalixoCmd, r }));
    chrome.runtime.sendMessage({ limpalixoCmd: ev.data.limpalixoCmd }).then(sent, (e) => sent("erro: " + e.message));
  });
}

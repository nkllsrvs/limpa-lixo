importScripts("dev-reload.js");
chrome.runtime.onInstalled.addListener(devStart);
chrome.runtime.onStartup.addListener(devStart);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "dev-reload") devCheck(); });
chrome.tabs.onUpdated.addListener(devOnTab);

// Clicar no ícone abre (ou foca) a página do Limpa Lixo.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

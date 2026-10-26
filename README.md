# Limpa Lixo

Extensão para Chrome/Edge que mostra quais contas que você segue também estão na lista (seguidores ou seguidos) de outro perfil do Instagram, e deixa de seguir as que você escolher. **Tudo roda no seu navegador** — sem senha e sem servidor.

- **Site / download:** https://nkllsrvs.github.io/limpa-lixo/
- **Código da extensão:** pasta [`extensao/`](extensao/)

## Instalar
1. Baixe o `limpa-lixo.zip` no site e descompacte (surge a pasta `limpa-lixo`).
2. Em `chrome://extensions` (ou `edge://extensions`), ligue o **Modo do desenvolvedor**.
3. **Carregar sem compactação** → escolha a pasta.

## Desenvolvimento
Crie `extensao/dev.json` (fora do git e do .zip) com a lista de arquivos a observar, por exemplo `{"watch": ["manifest.json", "background.js", "dev-reload.js", "dev-bridge.js", "app.html", "app.css", "app.js", "ig.js"]}`, e carregue a pasta `extensao/` sem compactação. Com isso:
- a extensão se recarrega sozinha (em até ~30 s) quando algum desses arquivos muda;
- em `https://www.instagram.com/#limpalixo-dev` o texto da tela do app aparece em `document.documentElement.dataset.limpalixo`, e `window.postMessage({limpalixoCmd: {op: "click" | "fill", sel, value}}, "*")` clica ou preenche elementos dela.

Sem `dev.json`, nada disso liga.

## Avisos
Projeto independente, sem ligação com o Instagram ou a Meta. Automatizar ações vai contra os Termos do Instagram; use por sua conta e risco, só com a sua própria conta. Deixar de seguir não dá para desfazer pela extensão.

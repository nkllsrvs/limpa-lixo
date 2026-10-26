'use strict';
// Aviso discreto para quem abre no celular (a extensao e so para computador).
(function () {
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    var note = document.getElementById('mobileNote');
    if (note) note.hidden = false;
  }
})();

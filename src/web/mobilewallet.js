/**
 * One answer to "there is no wallet in this browser", for every page.
 *
 * ⛔ On a phone, `window.ethereum` being absent is the NORMAL case, not an
 * error. Mobile Safari and mobile Chrome have no injected provider at all:
 * MetaMask on iOS/Android is a separate app with its own browser, and a dapp is
 * reached by opening it INSIDE that app. So a page that answers "no wallet
 * detected" tells a user with the wallet installed, one tap away, that the site
 * is broken - and it does that to every mobile visitor while working perfectly
 * on every desktop, which is why it survives testing.
 *
 * connect.html learned this on 5 Sep 2026 and fixed it in place. Five other
 * pages - swap, settle, bridgedmoli, pool, broker - each carried their own
 * one-line guard and each still dead-ended. Copying the fix five more times
 * would leave six copies to drift; this file is the fix once, loaded as a
 * classic script so both the plain-script pages and the module page can use it.
 *
 * Served at /molibra/mobilewallet.js from this node, like every other script
 * here: a page that moves money must not fetch its own logic from a third party
 * who can change it without telling anyone.
 */
(function () {
  'use strict';

  var PT = /^pt/i.test(document.documentElement.lang || navigator.language || '');
  var BUTTON_ID = 'molibra-open-in-wallet';

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  // MetaMask's deep link reopens THIS exact page inside the wallet's browser,
  // where a provider does exist. Path and query are carried so the user lands
  // where they were, not on the front page.
  function deepLink() {
    return 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search;
  }

  function message() {
    if (isMobile()) {
      return PT
        ? 'No celular, a carteira vive no próprio app. Toque em "Abrir esta página na '
          + 'MetaMask" acima - ela reabre esta mesma página dentro da carteira, onde a conexão '
          + 'pode acontecer. Com outra carteira, abra o navegador dela e vá para ' + location.host + '.'
        : 'On a phone, a wallet lives in its own app. Tap "Open this page in MetaMask" above - it '
          + 'reopens this exact page inside the wallet, where the connection can happen. If you '
          + 'use another wallet, open its in-app browser and go to ' + location.host + '.';
    }
    return PT
      ? 'Nenhuma carteira neste navegador. Instale a MetaMask, ou abra esta página num navegador '
        + 'com extensão de carteira.'
      : 'No wallet detected in this browser. Install MetaMask, or open this page in a browser '
        + 'that has a wallet extension.';
  }

  /**
   * Put the deep link on the page. Idempotent: pages call the guard on every
   * button press, and a stack of identical buttons is its own kind of broken.
   * Desktop gets nothing - there is nothing to deep-link into.
   */
  function mount(host) {
    if (!isMobile()) return null;
    var existing = document.getElementById(BUTTON_ID);
    if (existing) return existing;
    var a = document.createElement('a');
    a.id = BUTTON_ID;
    a.href = deepLink();
    a.textContent = PT ? 'Abrir esta página na MetaMask' : 'Open this page in MetaMask';
    a.style.cssText = 'display:inline-block;background:#FFD100;color:#0a0a0a;padding:13px 20px;'
      + 'border-radius:3px;text-decoration:none;font-weight:650;letter-spacing:.14em;'
      + 'text-transform:uppercase;font-size:12px;margin-top:12px';
    var target = host || document.querySelector('.log, .panel, main, body');
    target.appendChild(document.createElement('br'));
    target.appendChild(a);
    return a;
  }

  /**
   * The provider, or a thrown error that actually tells the user what to do.
   * Pages that display rather than throw call mount() + message() instead.
   */
  function require_(host) {
    if (window.ethereum) return window.ethereum;
    mount(host);
    throw new Error(message());
  }

  window.molibraWallet = {
    require: require_,
    message: message,
    mount: mount,
    isMobile: isMobile,
    deepLink: deepLink,
  };
})();

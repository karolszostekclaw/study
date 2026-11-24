/* Loaded by feed.html and desk.html. Connects a screen to the hub in the top-level page,
   stands in for the claude.ai runtime (db, sample, user), and starts the screen once the
   private content has loaded from the repo. */
(() => {
'use strict';
let hub = null;
try { hub = window.parent !== window && window.parent.Hub ? window.parent.Hub : null; } catch (e) { hub = null; }
if (!hub) { location.replace('./'); return; }           // opened directly: go to the app
document.documentElement.classList.add('embedded');

window.claude = { use: name => hub.use(name) };

function message(title, body, err) {
  const box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:28px;background:#fbfaf7;z-index:99;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#1d1c1a;text-align:center');
  box.innerHTML = `<div style="max-width:340px"><h2 style="font-size:1.15rem;margin:0 0 8px">${title}</h2><p style="margin:0 0 16px;color:#5b5852">${body}</p>
    <button type="button" style="font:inherit;padding:10px 18px;border-radius:10px;border:1px solid #1d1c1a;background:#1d1c1a;color:#fff">Open Settings</button>
    ${err ? `<p style="margin-top:14px;font-size:.8rem;color:#8a857c">${String(err).replace(/</g, '&lt;')}</p>` : ''}</div>`;
  box.querySelector('button').addEventListener('click', () => window.parent.App && window.parent.App.go('settings'));
  document.body.append(box);
}

const ready = hub.getContent();
window.Bridge = {
  hub, content: null, ready,
  start(fn) {
    ready.then(c => {
      Bridge.content = c;
      try { fn(); } catch (e) { console.error(e); message('Something broke', 'This screen hit an error while starting.', e && e.message); }
    }).catch(e => {
      const noToken = !hub.settings.ghToken;
      message(noToken ? 'Connect your study repo' : 'Could not load your cards and problems',
        noToken ? 'Your cards and problems live in your private GitHub repo. Add a GitHub token in Settings to load them.'
                : 'Check the GitHub token and repo name in Settings, and that you are online the first time.', noToken ? '' : (e && e.message));
    });
  }
};
})();

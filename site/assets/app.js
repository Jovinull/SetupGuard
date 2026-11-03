// SetupGuard site: scenario tabs and copy buttons. No dependencies, no network.
(function () {
  'use strict';

  // Tabs, following the WAI-ARIA tabs pattern (automatic activation).
  // Without JavaScript every panel stays visible; this only adds the switching.
  document.querySelectorAll('[data-demo]').forEach(function (demo) {
    var tabs = Array.prototype.slice.call(demo.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (tab) {
      return document.getElementById(tab.getAttribute('aria-controls'));
    });

    function select(index, focus) {
      tabs.forEach(function (tab, i) {
        var active = i === index;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
      });
      if (focus) tabs[index].focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        select(i, false);
      });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next !== null) {
          event.preventDefault();
          select(next, true);
        }
      });
    });

    select(0, false);
  });

  // Copy buttons: Clipboard API, with a selection-based fallback for
  // browsers or contexts where it is unavailable.
  var status = document.getElementById('copy-status');

  function announce(text) {
    if (!status) return;
    status.textContent = '';
    window.setTimeout(function () {
      status.textContent = text;
    }, 30);
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    var source = document.getElementById(button.getAttribute('data-copy'));
    if (!source) return;

    function done(ok) {
      button.textContent = ok ? 'Copied' : 'Select manually';
      button.setAttribute('data-state', ok ? 'done' : 'error');
      announce(ok ? 'Copied to the clipboard' : 'Copy failed; select the text manually');
      window.setTimeout(function () {
        button.textContent = 'Copy';
        button.removeAttribute('data-state');
      }, 2000);
    }

    button.addEventListener('click', function () {
      var text = source.textContent;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(fallbackCopy(text));
          },
        );
      } else {
        done(fallbackCopy(text));
      }
    });
  });
})();

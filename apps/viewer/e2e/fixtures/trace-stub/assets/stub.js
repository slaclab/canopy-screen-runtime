// Trace stub for the viewer's browser tests: speaks the same postMessage
// protocol as react-trace's embed bridge (src/embed/bridge.ts, stateOut.ts)
// and polls the Mole archiver list the way Trace does, so a spec can see
// whether the stub is polling by reading the server's per-probe counter.
//
//   probe id      from the page's own `pv=PROBE:<id>` or `x=PROBE:<id>` (the
//                 correlation page's X; any value, comma lists included);
//                 none or an invalid id -> 'default'
//   polling       GET ../mole/v1/archivers?probe=<id> (resolved against the
//                 injected <base>), once on load and every 1 s, only while
//                 visible
//   visibility    {type:'canopy:trace-visibility', visible:boolean} from the
//                 parent; default visible. Mirrored on body[data-visible].
//   ready         {type:'canopy:trace-ready'} to the parent once the listener
//                 is installed
//   __postQuery   window.__postQuery(q) posts {type:'canopy:trace-query', query:q}
//   hostbar       true when the page's own search carries hostbar=1 (the
//                 viewer frames a tool with &hostbar=1 while host-embedded)
//   tool actions  window.__postToolActions(report) posts {type:
//                 'canopy:tool-actions', version:1, ...report} (report holds
//                 state?, actions[], links{docs?, bug?}; `version` and `type`
//                 in it win, so a spec can post a malformed report too)
//   tool invoke   {type:'canopy:tool-invoke', id} from the parent: the id is
//                 appended to __traceStub.invoked (and the message to
//                 received[], like every accepted message)
//   save view     window.__postSaveView() posts {type:'canopy:save-view'}
//   quick open    primary+K (Meta or Ctrl) pressed in this page posts
//                 {type:'canopy:quick-open'}, as react-trace's embed bridge
//                 does; window.__postQuickOpen() posts it on request
//   __traceStub   { probe, visible, polls, hostbar, received[], invoked[] } for
//                 specs to inspect
//
// Only messages from window.parent on this page's own origin are accepted.

(function () {
  'use strict';

  var POLL_MS = 1000;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;

  function probeFrom(search) {
    var params = new URLSearchParams(search);
    var values = params.getAll('pv').concat(params.getAll('x'));
    for (var i = 0; i < values.length; i++) {
      var parts = values[i].split(',');
      for (var j = 0; j < parts.length; j++) {
        var pv = parts[j].trim();
        if (pv.indexOf('PROBE:') === 0) {
          var id = pv.slice('PROBE:'.length);
          return ID.test(id) ? id : 'default';
        }
      }
    }
    return 'default';
  }

  var state = {
    probe: probeFrom(window.location.search),
    visible: true,
    polls: 0,
    hostbar: new URLSearchParams(window.location.search).get('hostbar') === '1',
    received: [],
    invoked: [],
  };
  window.__traceStub = state;

  var molesUrl = new URL(
    '../mole/v1/archivers?probe=' + encodeURIComponent(state.probe),
    document.baseURI
  ).toString();

  document.getElementById('probe').textContent = state.probe;

  function render() {
    document.body.dataset.visible = state.visible ? 'true' : 'false';
    document.getElementById('polls').textContent = String(state.polls);
  }

  function poll() {
    if (!state.visible) return;
    state.polls += 1;
    render();
    fetch(molesUrl, { cache: 'no-store' }).catch(function () {
      /* a failed poll is the server's concern; the counter is what specs read */
    });
  }

  function post(message) {
    window.parent.postMessage(message, window.location.origin);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    var data = event.data;
    if (typeof data !== 'object' || data === null) return;
    state.received.push(data);
    if (data.type === 'canopy:trace-visibility' && typeof data.visible === 'boolean') {
      var wasVisible = state.visible;
      state.visible = data.visible;
      render();
      if (state.visible && !wasVisible) poll();
    } else if (data.type === 'canopy:tool-invoke' && typeof data.id === 'string') {
      state.invoked.push(data.id);
    }
  });

  window.addEventListener('keydown', function (event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key !== 'k' && event.key !== 'K') return;
    event.preventDefault();
    post({ type: 'canopy:quick-open' });
  });

  window.__postQuery = function (query) {
    post({ type: 'canopy:trace-query', query: query });
  };

  window.__postToolActions = function (report) {
    var message = { type: 'canopy:tool-actions', version: 1 };
    for (var key in report) {
      if (Object.prototype.hasOwnProperty.call(report, key)) message[key] = report[key];
    }
    post(message);
  };

  window.__postSaveView = function () {
    post({ type: 'canopy:save-view' });
  };

  window.__postQuickOpen = function () {
    post({ type: 'canopy:quick-open' });
  };

  render();
  post({ type: 'canopy:trace-ready' });
  poll();
  window.setInterval(poll, POLL_MS);
})();

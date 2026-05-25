// Cliente de analytics de Expansiel (Analytics Hub) para sitio estatico.
// Aditivo: no rompe el sitio. Dispara un pageview al cargar y expone
// window.expansielTrack(eventType, payload) para eventos custom.
(function () {
  var ANALYTICS_URL = "https://alksowkwsnjeesmnosvg.supabase.co/rest/v1/events";
  var ANALYTICS_KEY = "sb_publishable_uR65ixdIedeOR8Zo-PKNsA_nBJF8W3F";
  var SITE_ID = "resuelve-propiedades";

  function getSessionId() {
    try {
      var KEY = "ex_sid";
      var sid = localStorage.getItem(KEY);
      if (!sid) {
        sid =
          window.crypto && crypto.randomUUID
            ? crypto.randomUUID()
            : String(Date.now()) + Math.random().toString(16).slice(2);
        localStorage.setItem(KEY, sid);
      }
      return sid;
    } catch (e) {
      return "no-storage";
    }
  }

  function track(eventType, payload) {
    try {
      fetch(ANALYTICS_URL, {
        method: "POST",
        headers: {
          apikey: ANALYTICS_KEY,
          Authorization: "Bearer " + ANALYTICS_KEY,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          site_id: SITE_ID,
          event_type: eventType,
          session_id: getSessionId(),
          payload: payload || {},
          url: location.href,
          referrer: document.referrer || null,
          user_agent: navigator.userAgent,
        }),
        keepalive: true,
      });
    } catch (e) {
      /* Analytics nunca debe romper el sitio. */
    }
  }

  window.expansielTrack = track;
  track("pageview");
})();

// Cliente de analytics de Expansiel (Analytics Hub) para sitio estatico.
// Auto-trackea pageview + whatsapp_click + form_submit + tel_click + mailto_click.
// Captura pais (GeoJS, cacheado por sesion). Expone window.expansielTrack(type, payload).
(function () {
  var ANALYTICS_URL = "https://alksowkwsnjeesmnosvg.supabase.co/rest/v1/events";
  var ANALYTICS_KEY = "sb_publishable_uR65ixdIedeOR8Zo-PKNsA_nBJF8W3F";
  var SITE_ID = "resuelve-propiedades";

  function sid() {
    try {
      var k = "ex_sid", v = localStorage.getItem(k);
      if (!v) {
        v = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) { return "no-storage"; }
  }

  function readGeo() {
    try { var c = localStorage.getItem("ex_geo"); if (c) return JSON.parse(c); } catch (e) {}
    return { country: null, city: null, region: null };
  }

  function ensureGeo() {
    try { if (localStorage.getItem("ex_geo")) return; } catch (e) { return; }
    fetch("https://get.geojs.io/v1/ip/geo.json")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        try {
          localStorage.setItem("ex_geo", JSON.stringify({
            country: j.country_code || j.country || null,
            city: j.city || null,
            region: j.region || null
          }));
        } catch (e) {}
      })
      .catch(function () {});
  }

  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } }

  function track(eventType, payload) {
    try {
      var geo = readGeo();
      var p = payload || {};
      p.tz = tz(); p.lang = navigator.language; p.city = geo.city; p.region = geo.region;
      fetch(ANALYTICS_URL, {
        method: "POST",
        headers: {
          apikey: ANALYTICS_KEY,
          Authorization: "Bearer " + ANALYTICS_KEY,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          site_id: SITE_ID,
          event_type: eventType,
          session_id: sid(),
          payload: p,
          url: location.href,
          referrer: document.referrer || null,
          user_agent: navigator.userAgent,
          country: geo.country
        }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  window.expansielTrack = track;
  ensureGeo();

  document.addEventListener("click", function (e) {
    try {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      var text = (a.textContent || "").trim().slice(0, 80);
      if (/wa\.me|whatsapp\.com|api\.whatsapp/i.test(href)) track("whatsapp_click", { href: href, text: text });
      else if (/^tel:/i.test(href)) track("tel_click", { href: href, text: text });
      else if (/^mailto:/i.test(href)) track("mailto_click", { href: href, text: text });
    } catch (e) {}
  }, true);

  document.addEventListener("submit", function (e) {
    try {
      var form = e.target;
      if (!form || form.tagName !== "FORM") return;
      var names = [], values = {}, hasEmail = false, hasPhone = false;
      var SKIP = ["password", "hidden", "file", "submit", "button", "reset"];
      for (var i = 0; i < form.elements.length; i++) {
        var f = form.elements[i];
        var n = (f.name || f.id || "").toString();
        var type = (f.type || "").toString().toLowerCase();
        if (n) names.push(n);
        if (type === "email" || /mail/i.test(n)) hasEmail = true;
        if (type === "tel" || /phone|tel|celular|fono|whats/i.test(n)) hasPhone = true;
        if (n && f.value && SKIP.indexOf(type) === -1) {
          if ((type === "checkbox" || type === "radio") && !f.checked) continue;
          values[n] = String(f.value).slice(0, 500);
        }
      }
      var payload = {
        form_id: form.id || null,
        form_name: form.getAttribute("name") || null,
        action: form.getAttribute("action") || null,
        field_count: names.length,
        fields: names.slice(0, 30),
        has_email: hasEmail,
        has_phone: hasPhone
      };
      if (hasEmail || hasPhone) payload.values = values;
      track("form_submit", payload);
    } catch (e) {}
  }, true);

  track("pageview");
})();

// Point the download links at the newest GitHub release (pre-releases included).
// The links in the page already point at a fixed release, so nothing breaks if this fails.
(function () {
  var api = 'https://api.github.com/repos/Labs9119/RazorCAD/releases?per_page=10';
  fetch(api, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (releases) {
      var rel = releases.filter(function (r) { return !r.draft; })[0];
      if (!rel) return;
      var setup = rel.assets.filter(function (a) { return /setup.*\.exe$/i.test(a.name); })[0];
      var manual = rel.assets.filter(function (a) { return /manual.*\.pdf$/i.test(a.name); })[0];
      var version = rel.tag_name.replace(/^v/, '');
      if (setup) {
        document.querySelectorAll('[data-asset="setup"]').forEach(function (a) { a.href = setup.browser_download_url; });
        document.querySelectorAll('[data-size]').forEach(function (el) { el.textContent = Math.round(setup.size / 1048576) + ' MB'; });
      }
      if (manual) document.querySelectorAll('[data-asset="manual"]').forEach(function (a) { a.href = manual.browser_download_url; });
      document.querySelectorAll('[data-version]').forEach(function (el) { el.textContent = 'Version ' + version; });
      document.querySelectorAll('[data-rev]').forEach(function (el) { el.textContent = version; });
    })
    .catch(function () { /* keep the fixed links */ });
})();

// Draw the balloons and leaders on the first screenshot once it scrolls into view.
(function () {
  var svg = document.querySelector('.balloons');
  if (!svg || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var io = new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    requestAnimationFrame(function () { svg.classList.add('play'); });
  }, { threshold: 0.35 });
  io.observe(svg);
})();

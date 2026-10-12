// Runs before styles/rendering; allowed by the production self-only CSP.
(() => {
  let theme = 'light';
  try {
    if (localStorage.getItem('codex-cloud-theme') === 'dark') theme = 'dark';
  } catch {
    // Storage may be disabled; a theme can still be used for this page.
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#141414' : '#f5f5f5');
})();

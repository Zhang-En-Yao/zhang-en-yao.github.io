// Classic script in <head>: applies the theme before first paint to avoid a flash.
(function () {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const storage = {
    get() { try { return localStorage.getItem('theme'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem('theme', v); } catch (e) { /* storage blocked */ } },
  };

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#13110e' : '#faf8f5';
  }

  apply(storage.get() || (system.matches ? 'dark' : 'light'));

  // Follow the system until the visitor picks a theme themselves.
  system.addEventListener('change', (e) => {
    if (!storage.get()) apply(e.matches ? 'dark' : 'light');
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);
      storage.set(next);
    });
  });
})();

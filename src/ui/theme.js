export const COLOR_THEMES = {
  green: {
    h: 158,
    s: '100%',
    baseL: 60,
  },
  violet: {
    h: 271,
    s: '91%',
    baseL: 62,
  },
  amber: {
    h: 43,
    s: '96%',
    baseL: 58,
  },
  cyan: {
    h: 189,
    s: '85%',
    baseL: 52,
  },
  rose: {
    h: 350,
    s: '95%',
    baseL: 65,
  },
  gradient: {},
};

const THEME_PROPS = [
  '--accent-h',
  '--accent-s',
  '--accent-l',
];

function clearInlineTheme(root) {
  THEME_PROPS.forEach((prop) => {
    root.style.removeProperty(prop);
  });
}

export function applyColorTheme(themeKey) {
  const root = document.documentElement;
  if (themeKey === 'gradient') {
    clearInlineTheme(root);
    root.setAttribute('data-theme-color', 'gradient');
    return;
  }

  const theme = COLOR_THEMES[themeKey] || COLOR_THEMES.green;
  const isDarkMode = root.getAttribute('data-theme') !== 'light';
  root.removeAttribute('data-theme-color');
  root.style.setProperty('--accent-h', String(theme.h));
  root.style.setProperty('--accent-s', theme.s);
  root.style.setProperty('--accent-l', `${isDarkMode ? theme.baseL : theme.baseL - 20}%`);
}

function setActiveSwatch(activeKey, swatches) {
  swatches.forEach((button) => {
    const isActive = button.dataset.color === activeKey;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

export function initColorThemes() {
  const root = document.documentElement;
  const swatches = Array.from(document.querySelectorAll('#colorSwatches .swatch'));
  if (!swatches.length) return;

  let activeTheme = localStorage.getItem('motiondiff-color-theme') || 'green';
  applyColorTheme(activeTheme);
  setActiveSwatch(activeTheme, swatches);

  const themeObserver = new MutationObserver(() => {
    applyColorTheme(activeTheme);
  });
  themeObserver.observe(root, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  swatches.forEach((button) => {
    button.addEventListener('click', () => {
      activeTheme = button.dataset.color || 'green';
      applyColorTheme(activeTheme);
      localStorage.setItem('motiondiff-color-theme', activeTheme);
      setActiveSwatch(activeTheme, swatches);
    });
  });
}

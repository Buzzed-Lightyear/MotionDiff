export const COLOR_THEMES = {
  green: {
    accent: '#00ffaa',
    accentDim: '#00b87a',
    aurora1: 'rgba(0, 120, 80, 0.55)',
    aurora2: 'rgba(0, 60, 120, 0.45)',
    aurora3: 'rgba(0, 100, 60, 0.45)',
    conic1: 'rgba(0, 255, 170, 0.06)',
    conic2: 'rgba(0, 80, 200, 0.05)',
    conic3: 'rgba(0, 200, 120, 0.05)',
  },
  violet: {
    accent: '#c084fc',
    accentDim: '#9333ea',
    aurora1: 'rgba(100, 0, 180, 0.6)',
    aurora2: 'rgba(60, 0, 120, 0.5)',
    aurora3: 'rgba(30, 0, 80, 0.4)',
    conic1: 'rgba(192, 132, 252, 0.07)',
    conic2: 'rgba(80, 0, 200, 0.06)',
    conic3: 'rgba(150, 50, 255, 0.05)',
  },
  amber: {
    accent: '#fbbf24',
    accentDim: '#d97706',
    aurora1: 'rgba(120, 60, 0, 0.55)',
    aurora2: 'rgba(100, 30, 0, 0.45)',
    aurora3: 'rgba(80, 50, 0, 0.4)',
    conic1: 'rgba(251, 191, 36, 0.07)',
    conic2: 'rgba(200, 80, 0, 0.06)',
    conic3: 'rgba(180, 120, 0, 0.05)',
  },
  cyan: {
    accent: '#22d3ee',
    accentDim: '#0891b2',
    aurora1: 'rgba(0, 80, 120, 0.55)',
    aurora2: 'rgba(0, 60, 100, 0.5)',
    aurora3: 'rgba(0, 100, 80, 0.4)',
    conic1: 'rgba(34, 211, 238, 0.07)',
    conic2: 'rgba(0, 100, 180, 0.06)',
    conic3: 'rgba(0, 180, 160, 0.05)',
  },
  rose: {
    accent: '#fb7185',
    accentDim: '#e11d48',
    aurora1: 'rgba(120, 0, 40, 0.55)',
    aurora2: 'rgba(100, 0, 60, 0.5)',
    aurora3: 'rgba(80, 0, 30, 0.4)',
    conic1: 'rgba(251, 113, 133, 0.07)',
    conic2: 'rgba(200, 0, 80, 0.06)',
    conic3: 'rgba(180, 50, 100, 0.05)',
  },
  gradient: {},
};

const THEME_PROPS = [
  '--accent',
  '--accent-dim',
  '--aurora1',
  '--aurora2',
  '--aurora3',
  '--conic1',
  '--conic2',
  '--conic3',
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
  root.removeAttribute('data-theme-color');
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-dim', theme.accentDim);
  root.style.setProperty('--aurora1', theme.aurora1);
  root.style.setProperty('--aurora2', theme.aurora2);
  root.style.setProperty('--aurora3', theme.aurora3);
  root.style.setProperty('--conic1', theme.conic1);
  root.style.setProperty('--conic2', theme.conic2);
  root.style.setProperty('--conic3', theme.conic3);
}

function setActiveSwatch(activeKey, swatches) {
  swatches.forEach((button) => {
    const isActive = button.dataset.color === activeKey;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

export function initColorThemes() {
  const swatches = Array.from(document.querySelectorAll('#colorSwatches .swatch'));
  if (!swatches.length) return;

  let activeTheme = localStorage.getItem('motiondiff-color-theme') || 'green';
  applyColorTheme(activeTheme);
  setActiveSwatch(activeTheme, swatches);

  swatches.forEach((button) => {
    button.addEventListener('click', () => {
      activeTheme = button.dataset.color || 'green';
      applyColorTheme(activeTheme);
      localStorage.setItem('motiondiff-color-theme', activeTheme);
      setActiveSwatch(activeTheme, swatches);
    });
  });
}

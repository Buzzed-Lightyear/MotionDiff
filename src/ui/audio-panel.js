import { DEFAULT_AUDIO_PARAMS, MAX_VOICES, SCALE_NAMES } from '../app/audio.js';

/**
 * Controls for the sonification engine.
 *
 * Builds its own DOM inside the single container div `main.js` hands it, and
 * owns every listener — main.js only calls initAudioPanel. The enable button
 * is the user gesture the AudioContext needs, so nothing here touches audio
 * before it is clicked.
 */

const SLIDERS = [
  { key: 'masterVolume', label: 'Volume',    min: -60, max: 0,    step: 1,     format: (v) => `${v} dB` },
  { key: 'gate',         label: 'Gate',      min: 0,   max: 0.5,  step: 0.005, format: (v) => v.toFixed(3) },
  { key: 'attackMs',     label: 'Attack',    min: 5,   max: 500,  step: 5,     format: (v) => `${v} ms` },
  { key: 'releaseMs',    label: 'Release',   min: 20,  max: 2000, step: 10,    format: (v) => `${v} ms` },
  { key: 'cols',         label: 'Columns',   min: 1,   max: 16,   step: 1,     format: (v) => `${v}` },
  { key: 'rows',         label: 'Rows',      min: 1,   max: 8,    step: 1,     format: (v) => `${v}` },
  { key: 'baseMidi',     label: 'Base Note', min: 24,  max: 72,   step: 1,     format: (v) => `MIDI ${v}` },
];

/** Same accent-fill trick the sliders in ui/controls.js use. */
function setRangeFill(slider) {
  const min = Number.parseFloat(slider.min || '0');
  const max = Number.parseFloat(slider.max || '100');
  const value = Number.parseFloat(slider.value || '0');
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  slider.style.backgroundSize = `${percent}% 100%, 100% 100%`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{engine: import('../app/audio.js').AudioEngine, container: HTMLElement|null}} options
 */
export function initAudioPanel({ engine, container }) {
  if (!engine || !container) return;

  // The container is a grid item in .control-sections; take the full row.
  container.style.gridColumn = '1 / -1';

  const section = el('section', 'control-section audio-section');
  section.appendChild(el('span', 'section-title section-label', 'Sonification'));

  const enableBtn = el('button', 'btn-ctrl btn-record', 'Enable audio');
  enableBtn.type = 'button';
  enableBtn.id = 'audioEnableBtn';
  enableBtn.setAttribute('aria-pressed', 'false');
  section.appendChild(enableBtn);

  const grid = el('div', 'slider-grid');
  const inputs = {};
  const values = {};

  for (const spec of SLIDERS) {
    const cell = el('div', 'slider-cell');
    cell.appendChild(el('span', 'ctrl-label', spec.label));

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(engine.params[spec.key] ?? DEFAULT_AUDIO_PARAMS[spec.key]);
    input.setAttribute('aria-label', `${spec.label} (sonification)`);
    if (spec.key === 'cols' || spec.key === 'rows') {
      input.title = `One voice per cell, capped at ${MAX_VOICES}`;
    }
    cell.appendChild(input);

    const value = el('span', 'ctrl-val', spec.format(Number(input.value)));
    cell.appendChild(value);

    input.addEventListener('input', () => {
      engine.setParams({ [spec.key]: Number(input.value) });
      syncFromEngine();
    });

    inputs[spec.key] = input;
    values[spec.key] = value;
    grid.appendChild(cell);
  }
  section.appendChild(grid);

  const scaleBlock = el('div', 'performance-block');
  scaleBlock.appendChild(el('span', 'performance-label', 'Scale'));
  const scaleFields = el('div', 'performance-fields');
  const scaleSelect = el('select', 'control-select');
  scaleSelect.setAttribute('aria-label', 'Sonification scale');
  for (const name of SCALE_NAMES) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    scaleSelect.appendChild(option);
  }
  scaleSelect.value = engine.params.scale;
  scaleFields.appendChild(scaleSelect);
  scaleBlock.appendChild(scaleFields);

  const statusEl = el('div', 'performance-status');
  scaleBlock.appendChild(statusEl);
  section.appendChild(scaleBlock);

  container.appendChild(section);

  let notice = '';

  function setStatus() {
    const { cols, rows } = engine.params;
    const state = engine.isRunning()
      ? `${cols}&times;${rows} &middot; ${cols * rows} voices`
      : engine.params.enabled ? 'Waiting for playback' : 'Audio off';
    statusEl.innerHTML = notice ? `${state} &middot; ${notice}` : state;
  }

  /**
   * Pull values back out of the engine — it clamps grids past the voice cap
   * and rejects out-of-range values, and the sliders must show what stuck.
   */
  function syncFromEngine() {
    for (const spec of SLIDERS) {
      const current = engine.params[spec.key];
      if (Number(inputs[spec.key].value) !== current) {
        inputs[spec.key].value = String(current);
      }
      values[spec.key].textContent = spec.format(current);
      setRangeFill(inputs[spec.key]);
    }
    scaleSelect.value = engine.params.scale;
    enableBtn.textContent = engine.params.enabled ? 'Disable audio' : 'Enable audio';
    enableBtn.setAttribute('aria-pressed', engine.params.enabled ? 'true' : 'false');
    setStatus();
  }

  engine.onNotice = (message) => {
    notice = message;
    setStatus();
  };

  scaleSelect.addEventListener('change', () => {
    engine.setParams({ scale: scaleSelect.value });
    syncFromEngine();
  });

  enableBtn.addEventListener('click', () => {
    if (engine.params.enabled) {
      engine.setParams({ enabled: false });
      notice = '';
      syncFromEngine();
      return;
    }

    // Inside the click handler on purpose: an AudioContext cannot start
    // without a user gesture.
    notice = '';
    enableBtn.disabled = true;
    engine.start().catch((error) => {
      notice = `Audio failed: ${error.message}`;
    }).finally(() => {
      enableBtn.disabled = false;
      syncFromEngine();
    });
  });

  syncFromEngine();
}

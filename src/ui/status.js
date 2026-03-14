const statusEl = document.getElementById('statusMsg');
let statusFrameId = null;

export function setStatus(message, type) {
  if (!statusEl) return;
  if (statusFrameId !== null) {
    cancelAnimationFrame(statusFrameId);
    statusFrameId = null;
  }
  statusEl.classList.remove('visible');
  statusEl.textContent = message;
  statusEl.className = 'status-msg';
  if (/loading/i.test(message)) statusEl.classList.add('loading');
  if (type === 'error') statusEl.classList.add('error');
  else if (type === 'success') statusEl.classList.add('success');
  statusFrameId = requestAnimationFrame(() => {
    statusEl.classList.add('visible');
    statusFrameId = null;
  });
}

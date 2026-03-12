const statusEl = document.getElementById('statusMsg');

export function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = 'status-msg';
  if (type === 'error') statusEl.classList.add('error');
  else if (type === 'success') statusEl.classList.add('success');
}

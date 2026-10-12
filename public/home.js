const form = document.getElementById('create-form');
const result = document.getElementById('result');
const btn = document.getElementById('create-btn');

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  result.innerHTML = '<p>Uploading…</p>';
  try {
    const name = document.getElementById('pname').value.trim();
    const fileInput = document.getElementById('file');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      result.innerHTML = '<p class="err">Choose a CSV file first.</p>';
      btn.disabled = false;
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    if (name) fd.append('name', name);

    const res = await fetch('/api/projects', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      result.innerHTML = `<p class="err">${esc(data.error?.message ?? 'Could not create the API.')}</p>`;
      btn.disabled = false;
      return;
    }

    const cols = (data.columns || []).map((c) => `${esc(c.name)} (${esc(c.type)})`).join(', ');
    result.innerHTML = `
      <p class="ok">Your API is ready: ${data.rowCount} row(s).</p>
      <div class="panel">
        <strong>Columns</strong>
        <pre>${esc(cols)}</pre>
        <strong>Base URL</strong>
        <pre>${esc(data.baseUrl)}</pre>
        <strong>API key (shown once &mdash; save it)</strong>
        <pre>${esc(data.apiKey)}</pre>
        <strong>Manage token (shown once &mdash; keep it to replace/delete this project)</strong>
        <pre>${esc(data.manageToken)}</pre>
        <strong>Try it</strong>
        <pre>curl -H "x-api-key: ${esc(data.apiKey)}" "${esc(data.baseUrl)}/rows?limit=5"</pre>
      </div>`;
  } catch {
    result.innerHTML = '<p class="err">Network error. Is the server running?</p>';
  } finally {
    btn.disabled = false;
  }
});

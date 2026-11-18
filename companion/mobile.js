let token = sessionStorage.getItem('octopuses-host-token') || '';
const $ = (id) => document.getElementById(id);
async function api(route, body) {
  const response = await fetch(route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
function node(tag, text) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
function action(label, fn) { const button = node('button', label); button.onclick = () => { button.disabled = true; void fn().then(refresh).catch((e) => { $('status').textContent = e.message; }).finally(() => { button.disabled = false; }); }; return button; }
$('pair').onsubmit = async (event) => {
  event.preventDefault(); try { const result = await api('/pair', { code: $('code').value.trim().toUpperCase(), kind: 'mobile' }); token = result.token; sessionStorage.setItem('octopuses-host-token', token); $('code').value = ''; await refresh(); } catch (e) { $('status').textContent = e.message; }
};
$('logout').onclick = () => { token = ''; sessionStorage.removeItem('octopuses-host-token'); $('controls').hidden = true; $('pair').hidden = false; };
$('create').onsubmit = async (event) => {
  event.preventDefault(); try { await api('/jobs', { projectId: $('project').value, prompt: $('prompt').value, container: $('container').checked, network: $('network').checked }); $('prompt').value = ''; await refresh(); } catch (e) { $('status').textContent = e.message; }
};
let updating = false;
async function refresh() {
  if (!token || updating) return; updating = true;
  try {
    const state = await api('/status'); $('pair').hidden = true; $('controls').hidden = false;
    $('status').textContent = state.modelReady ? '已连接；后台任务在主机上执行' : '主机已连接，请在桌面端同步模型与项目';
    const previous = $('project').value;
    $('project').replaceChildren(...state.projects.map((p) => { const option = node('option', p.name); option.value = p.id; return option; }));
    if (state.projects.some((p) => p.id === previous)) $('project').value = previous;
    const cards = [...state.jobs].reverse().map((job) => {
      const card = node('article'); card.append(node('strong', job.prompt), node('p', `${job.status} · ${job.turn || 0} 轮`));
      if (job.approval) {
        card.append(node('pre', JSON.stringify(job.approval, null, 2)));
        const actions = node('div'); actions.className = 'actions';
        for (const [label, approved] of [['批准此次操作', true], ['拒绝', false]]) actions.append(action(label, () => api(`/jobs/${job.id}/approve`, { id: job.approval.id, approved })));
        card.append(actions);
      }
      if (job.result || job.error) card.append(node('pre', job.result || job.error));
      const running = ['running', 'queued', 'approval'].includes(job.status);
      card.append(action(running ? '暂停' : '检查后继续', () => api(`/jobs/${job.id}/${running ? 'pause' : 'resume'}`, {})));
      return card;
    }); $('jobs').replaceChildren(...cards);
  } catch (e) { $('status').textContent = e.message; } finally { updating = false; }
}
setInterval(() => void refresh(), 3000); void refresh();

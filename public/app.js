const app = document.getElementById('app');
const categories = ['Groceries', 'Food', 'Electricity', 'Gas', 'Internet', 'Rent', 'Maintenance', 'Other'];
const navItems = [
  ['dashboard', 'Dashboard', '⌂'], ['add-expense', 'Add expense', '＋'], ['expenses', 'Expenses', '▤'],
  ['approvals', 'Approvals', '✓'], ['settlements', 'Settlements', '⇄'], ['reports', 'Reports', '▥']
];
let currentUser = null;
let memberCache = [];
let notificationOpen = false;
let currentRoute = 'dashboard';
let toastTimer;
let livePollBusy = false;
const liveSnapshots = new Map();

function liveSnapshot(route, data) {
  if (route === 'dashboard') {
    const { unreadNotifications, ...dashboard } = data;
    return JSON.stringify(dashboard);
  }
  return JSON.stringify(data);
}

function rememberLiveSnapshot(route, data) {
  liveSnapshots.set(route, liveSnapshot(route, data));
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((Number(paise) || 0) / 100);
const shortMoney = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format((Number(paise) || 0) / 100);
const dateLabel = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const initials = name => String(name || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
const settledAmount = settlement => settlement.confirmed_amount_paise ?? settlement.amount_paise;
const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  // A failed login is also a 401; preserve its specific server message instead of
  // incorrectly telling the user that an existing session expired.
  if (response.status === 401 && path !== '/api/auth/login') {
    currentUser = null;
    renderLogin();
    throw new Error('Your session has ended. Please log in again.');
  }
  if (!response.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
  return data;
}

function showToast(message, error = false) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    app.append(node);
  }
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function initialsAvatar(name) { return `<span class="avatar">${escapeHtml(initials(name))}</span>`; }
function expenseBadge(type) { return `<span class="badge ${escapeHtml(type)}">${escapeHtml(type)}</span>`; }
function statusBadge(status) { return `<span class="badge ${escapeHtml(status)}">${escapeHtml(String(status).replace('_', ' '))}</span>`; }

function renderLogin(errorMessage = '') {
  app.innerHTML = `
    <div class="login-page">
      <section class="login-art">
        <div class="brand"><img class="brand-logo" src="/balanceit-logo.png" alt="BalanceIT logo"><div class="brand-name">Balance<span>IT</span></div></div>
        <div class="login-art-copy">
          <span class="eyebrow">Shared living, made simple</span>
          <h1>Good house finances start here.</h1>
          <p>Keep shared expenses clear, approvals transparent, and every settlement fair for everyone in your home.</p>
          <div class="login-illustration" aria-hidden="true">
            <div class="illus-card"><small style="color:#758078;font-size:9px">Shared expenses</small><div class="illus-big">₹ 12,480</div><div class="illus-line green"></div><div class="illus-line" style="width:45%"></div></div>
            <div class="illus-card"><small style="color:#758078;font-size:9px">This month</small><div class="illus-line green" style="height:9px;width:75%;margin-top:13px"></div><div class="illus-line" style="height:9px;width:52%"></div></div>
            <div class="illus-card"><div class="illus-line green" style="width:80%;margin-top:12px"></div><div class="illus-line" style="width:60%"></div></div>
          </div>
        </div>
        <small style="position:relative;z-index:1;color:#88958b;font-size:10px">Made for a home that runs together.</small>
      </section>
      <section class="login-side">
        <div class="login-box">
          <div class="brand"><span class="brand-mark">B</span><div class="brand-name">Balance<span>IT</span></div></div>
          <h2>Welcome back</h2><p>Sign in with the account your house configured for you.</p>
          <form id="login-form" autocomplete="on">
            <div class="field"><label for="login-username">Username</label><input id="login-username" name="username" autocomplete="username" required maxlength="32" placeholder="Your username"></div>
            <div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Your password"></div>
            <div class="form-error" id="login-error">${escapeHtml(errorMessage)}</div>
            <button class="primary-button" type="submit">Sign in <span aria-hidden="true">→</span></button>
          </form>
          <div class="login-hint">BalanceIT is private to the five configured roommates. Ask your house administrator for your account details.</div>
        </div>
      </section>
    </div>`;
}

function routeFromHash() {
  const value = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [route, query = ''] = value.split('?');
  return { route, params: new URLSearchParams(query) };
}
function href(route) { return `#${route}`; }
function layout(content, route) {
  const name = navItems.find(item => item[0] === route)?.[1] || (route === 'profile' ? 'Profile' : 'Dashboard');
  const baseItems = navItems.map(([key, label, icon]) => `<a class="nav-link ${route === key ? 'active' : ''}" href="${href(key)}" aria-label="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join('');
  const userName = currentUser?.displayName || 'Roommate';
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#dashboard"><span class="brand-mark">B</span><div class="brand-name">Balance<span>IT</span></div></a>
      <div class="nav-label">Workspace</div><nav class="side-nav">${baseItems}</nav>
      <div class="sidebar-spacer"></div>
      <div class="home-card"><strong>Your shared home</strong><p>Five members, one transparent ledger. Every approved expense is visible to everyone.</p></div>
      <div class="user-mini">${initialsAvatar(userName)}<div class="user-mini-info"><strong>${escapeHtml(userName)}</strong><small>@${escapeHtml(currentUser?.username || '')}</small></div><button class="logout-icon" data-action="logout" title="Log out" aria-label="Log out">↪</button></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumb">BalanceIT <span style="color:#bcc4bd;padding:0 6px">/</span> <strong>${escapeHtml(name)}</strong></div>
        <div class="top-actions"><button class="icon-button" data-action="theme" title="Toggle dark theme" aria-label="Toggle dark theme">◐</button><button class="icon-button" data-action="notifications" title="Notifications" aria-label="Notifications">♧${window.__unread ? `<span class="notification-dot">${window.__unread > 9 ? '9+' : window.__unread}</span>` : ''}</button><a href="#profile" class="icon-button" title="Profile" aria-label="Profile">${escapeHtml(initials(userName))}</a></div>
        ${notificationOpen ? '<div class="notification-panel" id="notification-panel"><div class="notification-head"><strong>Notifications</strong><button class="text-button" data-action="read-all">Mark all read</button></div><div class="notification-list">Loading…</div></div>' : ''}
      </header>
      <div class="page-wrap" id="page-content">${content}</div>
    </main>
  </div>`;
  if (notificationOpen) loadNotifications();
}

function pageHeading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
}

function renderMemberRow(member) {
  const balance = member.netBalancePaise;
  const balanceLabel = balance > 0 ? 'Receives' : balance < 0 ? 'Owes' : 'Settled';
  const balanceClass = balance > 0 ? 'positive' : balance < 0 ? 'negative' : 'neutral';
  return `<div class="member-row"><div class="member-ident">${initialsAvatar(member.name)}<div><strong>${escapeHtml(member.name)}</strong><small>@${escapeHtml(member.username)}</small></div></div><div class="member-stat"><small>Total paid</small><strong>${money(member.totalPaidPaise)}</strong></div><div class="member-stat"><small>Fair share</small><strong>${money(member.fairSharePaise)}</strong></div><div class="member-stat"><small>${balanceLabel}</small><strong class="${balanceClass}">${money(Math.abs(balance))}</strong></div></div>`;
}

async function renderDashboard() {
  const d = await api('/api/dashboard');
  rememberLiveSnapshot('dashboard', d);
  const summaries = [
    ['Approved shared expenses', d.totalApprovedGroupPaise, '▤', 'Across all approved bills'],
    ['This month', d.currentMonthPaise, '◷', 'Approved shared spending'],
    ['Average share', d.averageSharePaise, '↗', 'Per member, all time'],
    ['Awaiting approval', d.pendingApprovals, '✓', 'Requests from your house'],
    ['Outstanding to settle', d.outstandingSettlementPaise, '⇄', 'Across all members']
  ];
  const cards = summaries.map(([label, value, icon, foot], index) => `<article class="card summary-card"><div class="summary-top"><span>${label}</span><span class="summary-icon">${icon}</span></div><div class="summary-value">${index === 3 ? value : shortMoney(value)}</div><div class="summary-foot">${foot}</div></article>`).join('');
  const recent = d.recentExpenses.length ? d.recentExpenses.map(row => `<tr><td>${dateLabel(row.expense_date)}</td><td><button class="text-button" data-action="details" data-id="${row.id}">${escapeHtml(row.title)}</button></td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.paid_by_name)}</td><td class="amount-cell">${money(row.amount_paise)}</td><td>${expenseBadge(row.expense_type)}</td></tr>`).join('') : '<tr><td colspan="6" class="table-empty">No approved expenses yet. Your ledger will appear here.</td></tr>';
  const suggestions = d.settlementSuggestions;
  const settlementNudge = suggestions.length ? `<div class="card section-card" style="margin-top:17px"><div class="section-head"><div><h2>Suggested settlements</h2><p>Transfers that bring everyone closer to zero.</p></div><a href="#settlements" class="text-button">Open settlements →</a></div>${suggestions.slice(0, 3).map(s => `<div class="suggestion-row"><div class="transfer-people">${escapeHtml(s.payerName)} <span class="transfer-arrow">→</span> ${escapeHtml(s.receiverName)}</div><strong class="transfer-amount">${money(s.amountPaise)}</strong></div>`).join('')}</div>` : '';
  return `${pageHeading('Your household at a glance', 'Dashboard', 'A clear view of shared spending and what still needs attention.', `<a class="primary-button" href="#add-expense">＋ Add expense</a>`)}
    <section class="cards summary-grid">${cards}</section>
    <div class="dashboard-grid">
      <section class="card section-card"><div class="section-head"><div><h2>Member spending overview</h2><p>Shared payments, fair shares, and each member’s net position.</p></div><span class="badge approved">5 members</span></div><div class="members-list">${d.members.map(renderMemberRow).join('')}</div><div class="list-footer"><span>Green receives · red owes</span><a href="#settlements">View balances →</a></div></section>
      <section class="card section-card"><div class="section-head"><div><h2>Recent expenses</h2><p>Latest approved activity in your home.</p></div><a href="#expenses" class="text-button">See all →</a></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Paid by</th><th>Amount</th><th>Type</th></tr></thead><tbody>${recent}</tbody></table></div><div class="list-footer"><span>Personal expenses are recorded separately.</span><a href="#expenses">Expense ledger →</a></div></section>
    </div>${settlementNudge}`;
}

async function renderAddExpense() {
  if (!memberCache.length) memberCache = await api('/api/members');
  return `${pageHeading('Keep the ledger up to date', 'Add an expense', 'Submit a bill for the household to review. The logged-in member is recorded as the payer.')}
    <div class="page-grid"><section class="card form-card"><form id="expense-form"><div class="form-grid">
      <div class="field full"><label for="expense-title">Expense description</label><input id="expense-title" name="title" required maxlength="120" placeholder="e.g. Weekly groceries"></div>
      <div class="field"><label for="expense-amount">Amount (₹)</label><input id="expense-amount" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0.00"></div>
      <div class="field"><label for="expense-date">Expense date</label><input id="expense-date" name="expenseDate" type="date" value="${localToday()}" required></div>
      <div class="field"><label for="expense-category">Category</label><select id="expense-category" name="category" required>${categories.map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><span class="field-label">Expense type</span><div class="radio-row"><label class="radio-option"><input type="radio" name="expenseType" value="shared" checked> Shared expense</label><label class="radio-option"><input type="radio" name="expenseType" value="personal"> Personal expense</label></div></div>
      <div class="field full" id="participants-field"><span class="field-label">Split participants</span><div class="help-text">Your expense is split equally among selected members. Paise remainder is assigned in member order.</div><div class="participants-box">${memberCache.map(m => `<label class="participant"><input type="checkbox" name="participantIds" value="${m.id}" checked> ${escapeHtml(m.displayName)}</label>`).join('')}</div></div>
    </div><div class="form-actions"><button class="secondary-button" type="reset">Clear form</button><button class="primary-button" type="submit">Submit for approval <span>→</span></button></div></form></section>
    <aside class="card form-aside"><div class="aside-icon">✓</div><h3>How approval works</h3><p>Every expense is reviewed by the other four members before it enters the approved ledger.</p><div class="rule-list"><div class="rule"><span>01</span><span>Three approvals confirm a request.</span></div><div class="rule"><span>02</span><span>Two rejections decline it, with a reason if members add one.</span></div><div class="rule"><span>03</span><span>Personal expenses are verified but never change shared balances.</span></div><div class="rule"><span>04</span><span>All five roommates can see the current voting status.</span></div></div></aside></div>`;
}

async function renderApprovals() {
  const data = await api('/api/approvals');
  rememberLiveSnapshot('approvals', data);
  const pending = data.pending.length ? `<div class="approval-grid">${data.pending.map(item => {
    const canVote = item.paid_by !== currentUser.id && !item.my_vote;
    const voted = item.my_vote ? `You have ${item.my_vote}d on this request.` : item.paid_by === currentUser.id ? 'You submitted this request and cannot vote on it.' : 'Your vote helps the household keep a clear record.';
    return `<article class="card approval-card"><div class="approval-meta">${statusBadge('pending')}<span style="font-size:9px;color:#8d9890">#${item.id}</span></div><div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><div><h3>${escapeHtml(item.title)}</h3><div style="font-size:10px;color:#879189">Submitted by ${escapeHtml(item.paid_by_name)}</div></div><strong class="approval-amount">${money(item.amount_paise)}</strong></div><div class="approval-detail">${escapeHtml(item.category)} · ${dateLabel(item.expense_date)} · ${escapeHtml(item.expense_type)} expense<br>Vote status: ${item.approvals || 0} approvals · ${item.rejections || 0} rejections</div><div class="vote-progress"><span class="yes" style="width:${Math.min((item.approvals || 0) / 3 * 100, 100)}%"></span><span class="no" style="width:${Math.min((item.rejections || 0) / 2 * 100, 100)}%"></span></div><div class="vote-labels"><span>${item.approvals || 0} / 3 approvals needed</span><span>${item.rejections || 0} / 2 rejections</span></div><div class="approval-detail" style="margin-bottom:0">${voted}</div>${canVote ? `<div class="vote-actions"><button class="primary-button" data-action="vote" data-vote="approved" data-id="${item.id}">✓ Approve</button><button class="danger-button" data-action="vote" data-vote="rejected" data-id="${item.id}">Reject</button></div>` : ''}</article>`;
  }).join('')}</div>` : `<div class="card empty-state"><div class="empty-icon">✓</div><h3>All caught up</h3><p>There are no expense requests waiting for approval right now.</p></div>`;
  const history = data.history.length ? data.history.map(item => `<tr><td>${dateLabel(item.expense_date)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.paid_by_name)}</td><td>${money(item.amount_paise)}</td><td>${item.approvals || 0} yes · ${item.rejections || 0} no</td><td>${statusBadge(item.status)}${item.rejection_reason ? `<div class="help-text" style="margin-top:5px">${escapeHtml(item.rejection_reason)}</div>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="table-empty">Approved and rejected requests will appear here.</td></tr>';
  return `${pageHeading('Transparent by design', 'Approval requests', 'Review expense submissions and follow every vote as it happens.', `<a class="secondary-button" href="#add-expense">＋ Add expense</a>`)}<h2 style="font:700 15px Manrope;margin:0 0 12px">Waiting for review <span class="badge pending">${data.pending.length}</span></h2>${pending}<section class="card section-card" style="margin-top:24px"><div class="section-head"><div><h2>Decision history</h2><p>Recently approved and rejected requests stay available for audit.</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Submitted by</th><th>Amount</th><th>Votes</th><th>Decision</th></tr></thead><tbody>${history}</tbody></table></div></section>`;
}

function filterValue(params, key) { return escapeHtml(params.get(key) || ''); }
async function renderExpenses(params) {
  if (!memberCache.length) memberCache = await api('/api/members');
  const q = new URLSearchParams(params);
  const query = q.toString();
  const data = await api(`/api/expenses${query ? `?${query}` : ''}`);
  const rows = data.rows.length ? data.rows.map(row => `<tr><td>${dateLabel(row.expense_date)}</td><td><button class="text-button" data-action="details" data-id="${row.id}">${escapeHtml(row.title)}</button></td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.paid_by_name)}</td><td class="amount-cell">${money(row.amount_paise)}</td><td>${expenseBadge(row.expense_type)}</td><td>${statusBadge(row.status)}</td></tr>`).join('') : '<tr><td colspan="7" class="table-empty">No approved expenses match these filters.</td></tr>';
  const memberTotals = data.byMember.map(m => `<span>${escapeHtml(m.display_name)} ${money(m.amount_paise)}</span>`).join(' · ');
  return `${pageHeading('The complete approved ledger', 'Expenses', 'Search, filter, and open the details behind any approved transaction.', `<a class="primary-button" href="#add-expense">＋ Add expense</a>`)}
    <section class="card section-card"><form class="filterbar" id="expense-filters">
      <div class="field search-field"><label for="filter-search">Search</label><input id="filter-search" name="search" value="${filterValue(params,'search')}" placeholder="Description, member or category"></div>
      <div class="field"><label for="filter-month">Month</label><input id="filter-month" type="month" name="month" value="${filterValue(params,'month')}"></div>
      <div class="field"><label for="filter-year">Year</label><input type="number" min="2000" max="2100" name="year" value="${filterValue(params,'year')}" placeholder="Any"></div>
      <div class="field"><label for="filter-member">Paid by</label><select id="filter-member" name="member"><option value="">All members</option>${memberCache.map(m => `<option value="${m.id}" ${params.get('member') == m.id ? 'selected' : ''}>${escapeHtml(m.displayName)}</option>`).join('')}</select></div>
      <div class="field"><label for="filter-category">Category</label><select id="filter-category" name="category"><option value="">All categories</option>${categories.map(c => `<option ${params.get('category') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label for="filter-type">Type</label><select id="filter-type" name="type"><option value="">All types</option><option value="shared" ${params.get('type') === 'shared' ? 'selected' : ''}>Shared</option><option value="personal" ${params.get('type') === 'personal' ? 'selected' : ''}>Personal</option></select></div>
      <button class="primary-button" type="submit">Filter</button><a class="secondary-button" href="#expenses">Clear</a>
    </form><div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Paid by</th><th>Amount</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="totals-strip"><div><small>Shared expenses</small><strong>${money(data.totals.shared_paise)}</strong></div><div><small>Personal expenses</small><strong>${money(data.totals.personal_paise)}</strong></div><div><small>Total recorded</small><strong>${money(data.totals.total_paise)}</strong></div></div>
    <div class="list-footer"><span>Paid by member: ${memberTotals || '—'}</span></div><div class="pager"><span>${data.total ? `Showing ${Math.min((data.page - 1) * 20 + 1, data.total)}–${Math.min(data.page * 20, data.total)} of ${data.total}` : 'No results'}</span><div class="pager-buttons"><button data-action="page" data-page="${Math.max(1,data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>← Previous</button><button data-action="page" data-page="${Math.min(data.pages,data.page + 1)}" ${data.page >= data.pages ? 'disabled' : ''}>Next →</button></div></div></section>`;
}

async function renderSettlements() {
  const data = await api('/api/settlements');
  rememberLiveSnapshot('settlements', data);
  const personalItems = new Map();
  for (const suggestion of data.suggestions.filter(s => s.payerId === currentUser.id || s.receiverId === currentUser.id)) {
    personalItems.set(`${suggestion.payerId}:${suggestion.receiverId}`, { ...suggestion, pending: null });
  }
  for (const pending of data.history.filter(s => s.status === 'pending_confirmation' && (s.payer_id === currentUser.id || s.receiver_id === currentUser.id))) {
    const key = `${pending.payer_id}:${pending.receiver_id}`;
    const item = personalItems.get(key) || {
      payerId: pending.payer_id, payerName: pending.payer_name,
      receiverId: pending.receiver_id, receiverName: pending.receiver_name,
      amountPaise: pending.amount_paise
    };
    item.pending = pending;
    personalItems.set(key, item);
  }
  const personalRows = personalItems.size ? [...personalItems.values()].map(item => {
    const isPayer = item.payerId === currentUser.id;
    const otherName = isPayer ? item.receiverName : item.payerName;
    const relationship = isPayer ? `You pay ${escapeHtml(otherName)}` : `${escapeHtml(otherName)} pays you`;
    const amountPaise = item.pending ? item.pending.amount_paise : item.amountPaise;
    let action = '';
    if (item.pending && isPayer) {
      action = `<span class="badge pending">Waiting for ${escapeHtml(item.receiverName)}</span>`;
    } else if (item.pending && !isPayer) {
      action = `<button class="primary-button" data-action="settlement-action" data-mode="confirm" data-id="${item.pending.id}" data-counterpart-name="${escapeHtml(otherName)}" data-amount-paise="${amountPaise}">Received</button>`;
    } else if (isPayer) {
      action = `<button class="primary-button" data-action="settlement-action" data-mode="pay" data-payer-id="${item.payerId}" data-receiver-id="${item.receiverId}" data-counterpart-name="${escapeHtml(otherName)}" data-amount-paise="${amountPaise}">Paid</button>`;
    } else {
      action = `<button class="secondary-button" data-action="settlement-action" data-mode="receive" data-payer-id="${item.payerId}" data-receiver-id="${item.receiverId}" data-counterpart-name="${escapeHtml(otherName)}" data-amount-paise="${amountPaise}">Received</button>`;
    }
    return `<div class="suggestion-row personal-settlement-row"><div class="personal-transfer"><div class="transfer-people">${relationship}</div><small>${item.pending ? `Payment request · ${dateLabel(item.pending.payment_date)}` : 'Suggested from your current balance'}</small></div><strong class="transfer-amount">${money(amountPaise)}</strong><div class="personal-action">${action}</div></div>`;
  }).join('') : '<div class="empty-state"><div class="empty-icon">✓</div><h3>No payment actions for you</h3><p>Your balance is settled, or no transfer is currently assigned to you.</p></div>';
  const suggestions = data.suggestions.length ? data.suggestions.map(s => `<div class="suggestion-row"><div class="transfer-people">${initialsAvatar(s.payerName)} ${escapeHtml(s.payerName)} <span class="transfer-arrow">→</span> ${escapeHtml(s.receiverName)}</div><strong class="transfer-amount">${money(s.amountPaise)}</strong></div>`).join('') : '<div class="empty-state"><div class="empty-icon">✓</div><h3>Everyone is settled</h3><p>There are no outstanding shared balances.</p></div>';
  const historyRows = data.history.length ? data.history.map(s => {
    const amount = settledAmount(s);
    const partialLabel = s.status === 'confirmed' && amount !== s.amount_paise ? `<small class="help-text">of requested ${money(s.amount_paise)}</small>` : '';
    return `<tr><td>${dateLabel(s.payment_date)}</td><td>${escapeHtml(s.payer_name)}</td><td>${escapeHtml(s.receiver_name)}</td><td class="amount-cell">${money(amount)}${partialLabel}</td><td>${statusBadge(s.status)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="table-empty">Recorded transfers will appear here.</td></tr>';
  const balance = data.members.find(member => member.id === currentUser.id)?.netBalancePaise || 0;
  const balanceText = balance < 0 ? `You need to pay ${money(-balance)}.` : balance > 0 ? `You should receive ${money(balance)}.` : 'Your balance is settled.';
  return `${pageHeading('Clear balances, fewer back-and-forths', 'Settlements', 'Suggested transfers use the full approved ledger. Pending payments wait for receiver confirmation.')}
    <section class="card section-card personal-settlements"><div class="section-head"><div><h2>Your settlement actions</h2><p>${escapeHtml(balanceText)} Choose the amount in the popup before recording it.</p></div><span class="badge ${balance < 0 ? 'pending' : balance > 0 ? 'approved' : 'confirmed'}">Your balance</span></div>${personalRows}</section>
    <div class="balance-grid">${data.members.map(m => { const value = m.netBalancePaise; return `<article class="card balance-card">${initialsAvatar(m.name)}<strong>${escapeHtml(m.name)}</strong><small>${value > 0 ? 'Should receive' : value < 0 ? 'Needs to pay' : 'Settled'}</small><div class="balance-num ${value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'}">${money(Math.abs(value))}</div></article>`; }).join('')}</div>
    <div class="settlement-layout"><section class="card section-card"><div class="section-head"><div><h2>Suggested transfers</h2><p>Matched to clear each outstanding balance in as few practical steps as possible.</p></div><span class="badge approved">${data.suggestions.length} transfers</span></div>${suggestions}</section><section class="card section-card"><div class="section-head"><div><h2>Settlement guide</h2><p>Paid sends a request to the receiver. Received updates balances immediately.</p></div></div><div class="rule-list" style="padding:0 20px 20px"><div class="rule"><span>Paid</span><span>The recipient must confirm the payment before it changes balances.</span></div><div class="rule"><span>Received</span><span>Record money you have received; no extra approval is sent.</span></div><div class="rule"><span>Partial</span><span>A custom amount is recorded in paise and the remaining balances recalculate.</span></div></div></section></div>
    <section class="card section-card" style="margin-top:18px"><div class="section-head"><div><h2>Settlement history</h2><p>Confirmed records reduce balances; pending requests stay visible for follow-up.</p></div></div><div class="table-wrap"><table><thead><tr><th>Payment date</th><th>Paid by</th><th>Received by</th><th>Amount</th><th>Status</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>`;
}

async function renderReports(params) {
  const now = new Date();
  const year = params.get('year') || String(now.getFullYear());
  const month = params.get('month') || String(now.getMonth() + 1).padStart(2, '0');
  const data = await api(`/api/reports?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  const search = new URLSearchParams({ year, month });
  const maxCategory = Math.max(1, ...data.categories.map(c => c.amount_paise));
  const categoriesChart = data.categories.length ? data.categories.map(c => `<div class="chart-row"><div class="chart-label"><span>${escapeHtml(c.category)}</span><strong>${money(c.amount_paise)}</strong></div><div class="chart-track"><div class="chart-bar" style="width:${Math.max(3,c.amount_paise / maxCategory * 100)}%"></div></div></div>`).join('') : '<p class="help-text" style="padding-top:15px">No category spending recorded in this month.</p>';
  const memberRows = data.members.map(m => `<tr><td><strong>${escapeHtml(m.name)}</strong></td><td>${money(m.sharedPaidPaise)}</td><td>${money(m.personalPaidPaise)}</td><td>${money(m.fairSharePaise)}</td><td class="${m.netBalancePaise > 0 ? 'positive' : m.netBalancePaise < 0 ? 'negative' : 'neutral'}">${money(m.netBalancePaise)}</td></tr>`).join('');
  const settlementRows = data.settlementHistory.length ? data.settlementHistory.map(s => `<tr><td>${dateLabel(s.payment_date)}</td><td>${escapeHtml(s.payer_name)}</td><td>${escapeHtml(s.receiver_name)}</td><td>${money(settledAmount(s))}</td><td>${statusBadge(s.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="table-empty">No settlements were recorded in this month.</td></tr>';
  return `${pageHeading('Spending patterns, made clear', 'Monthly reports', 'Monthly activity sits alongside all-time balances; changing the month never resets the ledger.', `<form id="report-filters" class="report-toolbar"><div class="field"><label for="report-month">Month</label><select id="report-month" name="month">${Array.from({length:12},(_,i)=>{const m=String(i+1).padStart(2,'0');return `<option value="${m}" ${month===m?'selected':''}>${new Date(2020,i,1).toLocaleDateString('en-IN',{month:'long'})}</option>`}).join('')}</select></div><div class="field"><label for="report-year">Year</label><input id="report-year" name="year" type="number" min="2000" max="2100" value="${escapeHtml(year)}"></div><button class="primary-button" type="submit">Apply</button><a class="secondary-button" href="/api/reports/export.csv?${search}" download>Export CSV</a></form>`)}
    <div class="report-stats"><article class="card report-stat"><small>Monthly shared expenses</small><strong>${money(data.totals.sharedPaise)}</strong></article><article class="card report-stat"><small>Monthly personal expenses</small><strong>${money(data.totals.personalPaise)}</strong></article></div>
    <div class="report-grid"><section class="card section-card"><div class="section-head"><div><h2>Category breakdown</h2><p>Approved spending during ${new Date(`${year}-${month}-15T12:00:00`).toLocaleDateString('en-IN',{month:'long',year:'numeric'})}.</p></div></div><div class="chart-list">${categoriesChart}</div></section>
      <section class="card section-card"><div class="section-head"><div><h2>Member totals</h2><p>Monthly amount paid and fair share.</p></div></div><div class="members-list">${data.members.map(m => `<div class="member-row" style="grid-template-columns:minmax(110px,1fr) 1fr"><div class="member-ident">${initialsAvatar(m.name)}<strong>${escapeHtml(m.name)}</strong></div><div class="member-stat"><small>Paid · fair share</small><strong>${money(m.totalPaidPaise)} · ${money(m.fairSharePaise)}</strong></div></div>`).join('')}</div></section></div>
    <section class="card section-card" style="margin-bottom:17px"><div class="section-head"><div><h2>Monthly member report</h2><p>Net balance is all-time and includes confirmed settlements.</p></div></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Shared paid</th><th>Personal paid</th><th>Fair share</th><th>Net balance</th></tr></thead><tbody>${memberRows}</tbody></table></div></section>
    <section class="card section-card"><div class="section-head"><div><h2>Settlement history</h2><p>Transfers recorded during ${escapeHtml(data.month)}.</p></div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Paid by</th><th>Received by</th><th>Amount</th><th>Status</th></tr></thead><tbody>${settlementRows}</tbody></table></div></section>`;
}

function renderProfile() {
  return `${pageHeading('Account details', 'Your profile', 'Your account is managed by the household administrator.')}
    <div class="page-grid"><section class="card form-aside"><div class="member-ident" style="margin-bottom:20px">${initialsAvatar(currentUser.displayName)}<div><strong>${escapeHtml(currentUser.displayName)}</strong><small>@${escapeHtml(currentUser.username)}</small></div></div><h3>BalanceIT member</h3><p>Only the five configured members can access this household ledger. All expenses you submit are automatically recorded as paid by you.</p><button class="danger-button" data-action="logout">↪ Log out</button></section></div>`;
}

async function loadRoute({ background = false } = {}) {
  const { route, params } = routeFromHash();
  currentRoute = route;
  if (!currentUser) return;
  const scrollPosition = window.scrollY;
  if (!background) layout('<div class="card empty-state"><div class="empty-icon">…</div><h3>Loading your ledger</h3><p>Getting the latest household data.</p></div>', route);
  try {
    let content;
    switch (route) {
      case 'dashboard': content = await renderDashboard(); break;
      case 'add-expense': content = await renderAddExpense(); break;
      case 'expenses': content = await renderExpenses(params); break;
      case 'approvals': content = await renderApprovals(); break;
      case 'settlements': content = await renderSettlements(); break;
      case 'reports': content = await renderReports(params); break;
      case 'profile': content = renderProfile(); break;
      default: location.hash = '#dashboard'; return;
    }
    if (routeFromHash().route === route) {
      const page = document.getElementById('page-content');
      if (page) {
        page.innerHTML = content;
        if (background) window.scrollTo(0, scrollPosition);
      }
    }
  } catch (error) {
    if (background) liveSnapshots.set(route, null);
    if (!background && !document.querySelector('.login-page')) {
      const page = document.getElementById('page-content');
      if (page) page.innerHTML = `<div class="card empty-state"><div class="empty-icon">!</div><h3>We couldn’t load this page</h3><p>${escapeHtml(error.message)}</p><button class="secondary-button" data-action="retry" style="margin-top:14px">Try again</button></div>`;
    }
  }
}

async function loadNotifications() {
  const container = document.querySelector('.notification-list');
  if (!container) return;
  try {
    const data = await api('/api/notifications');
    window.__unread = data.unread;
    updateUnreadBadge();
    container.innerHTML = data.notifications.length ? data.notifications.map(n => `<div class="notification-item ${n.is_read ? '' : 'unread'}" data-action="open-notification" data-id="${n.id}" data-related="${escapeHtml(n.related_type || '')}"><span><strong>${escapeHtml(n.title)}</strong><br>${escapeHtml(n.message)}<small>${dateLabel((n.created_at || '').slice(0,10))}</small></span></div>`).join('') : '<div class="empty-state" style="padding:25px 8px"><p>You’re all caught up.</p></div>';
  } catch { container.innerHTML = '<div class="help-text">Notifications could not be loaded.</div>'; }
}

function openSettlementModal(button) {
  const mode = button.dataset.mode;
  const amountPaise = Number(button.dataset.amountPaise);
  const counterpart = button.dataset.counterpartName || 'your roommate';
  const isPay = mode === 'pay';
  const isDirectReceive = mode === 'receive';
  const title = isPay ? `Pay ${counterpart}` : `Received from ${counterpart}`;
  const explanation = isPay
    ? `This sends ${counterpart} a payment request. Your balance changes after they confirm it.`
    : isDirectReceive
      ? `Record the amount you received from ${counterpart}. Balances update immediately; no approval request is sent.`
      : `Confirm the amount received from ${counterpart}. Balances update as soon as you confirm.`;
  const buttonLabel = isPay ? 'Send payment request' : isDirectReceive ? 'Mark received' : 'Confirm received';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<section class="modal settlement-modal" role="dialog" aria-modal="true" aria-labelledby="settlement-modal-title">
    <div class="modal-head"><div><div class="eyebrow">Settlement</div><h2 id="settlement-modal-title">${escapeHtml(title)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div>
    <p class="subtitle" style="margin-bottom:16px">${escapeHtml(explanation)}</p>
    <form id="settlement-action-form" data-mode="${escapeHtml(mode)}" data-id="${escapeHtml(button.dataset.id || '')}" data-payer-id="${escapeHtml(button.dataset.payerId || '')}" data-receiver-id="${escapeHtml(button.dataset.receiverId || '')}" data-amount-paise="${amountPaise}">
      <label class="full-amount-option"><input id="settlement-full-amount" name="fullAmount" type="checkbox" checked> <span>Use the full amount <strong>${money(amountPaise)}</strong></span></label>
      <div class="field" style="margin-top:14px"><label for="settlement-custom-amount">Custom amount (₹)</label><input id="settlement-custom-amount" name="amount" type="number" min="0.01" max="${(amountPaise / 100).toFixed(2)}" step="0.01" inputmode="decimal" value="${(amountPaise / 100).toFixed(2)}" disabled required><small class="help-text">Cannot exceed the current suggested or requested amount.</small></div>
      ${mode === 'confirm' ? '' : `<div class="field" style="margin-top:13px"><label for="settlement-action-date">${isPay ? 'Payment date' : 'Date received'}</label><input id="settlement-action-date" name="paymentDate" type="date" value="${localToday()}" required></div><div class="field" style="margin-top:13px"><label for="settlement-action-note">Note (optional)</label><input id="settlement-action-note" name="note" maxlength="250" placeholder="e.g. UPI transfer"></div>`}
      <div class="form-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">${buttonLabel}</button></div>
    </form></section>`;
  app.append(modal);
}

function updateUnreadBadge() {
  document.querySelectorAll('.notification-dot').forEach(n => n.remove());
  const button = document.querySelector('[data-action="notifications"]');
  if (button && window.__unread) button.insertAdjacentHTML('beforeend', `<span class="notification-dot">${window.__unread > 9 ? '9+' : window.__unread}</span>`);
}

async function showExpenseDetails(id) {
  try {
    const e = await api(`/api/expenses/${id}`);
    const participants = e.participants.length ? e.participants.map(p => `${escapeHtml(p.name)} (${money(p.share_paise)})`).join(', ') : 'No shared participants';
    const voters = e.votes.length ? e.votes.map(v => `<div class="suggestion-row" style="padding:10px 0"><span>${escapeHtml(v.name)}</span><span>${statusBadge(v.vote)} ${v.rejection_reason ? escapeHtml(v.rejection_reason) : ''}</span></div>`).join('') : '<p class="help-text">No votes recorded.</p>';
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">Expense detail</div><h2>${escapeHtml(e.title)}</h2>${statusBadge(e.status)}</div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="detail-grid"><div class="detail-item"><small>Amount</small><strong>${money(e.amount_paise)}</strong></div><div class="detail-item"><small>Paid by</small><strong>${escapeHtml(e.paid_by_name)}</strong></div><div class="detail-item"><small>Category · type</small><strong>${escapeHtml(e.category)} · ${escapeHtml(e.expense_type)}</strong></div><div class="detail-item"><small>Expense date</small><strong>${dateLabel(e.expense_date)}</strong></div><div class="detail-item" style="grid-column:1/-1"><small>Shared by</small><strong>${participants}</strong></div></div><div style="margin-top:18px"><strong style="font:700 12px Manrope">Votes (${e.approvals} approvals · ${e.rejections} rejections)</strong>${voters}</div>${e.rejection_reason ? `<p class="help-text">Rejection reason: ${escapeHtml(e.rejection_reason)}</p>` : ''}</section>`;
    document.body.append(modal);
  } catch (error) { showToast(error.message, true); }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  currentUser = null;
  notificationOpen = false;
  renderLogin();
  history.replaceState(null, '', location.pathname);
}

app.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const values = new FormData(form);
  if (form.id === 'login-form') {
    const error = document.getElementById('login-error');
    if (error) error.textContent = '';
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Signing in…';
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password') }) });
      currentUser = result.user;
      location.hash = '#dashboard';
      await afterLogin();
    } catch (err) {
      if (document.getElementById('login-error')) document.getElementById('login-error').textContent = err.message;
      const btn = document.querySelector('#login-form button[type="submit"]'); if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in <span aria-hidden="true">→</span>'; }
    }
    return;
  }
  if (form.id === 'expense-form') {
    const type = values.get('expenseType');
    const participantIds = values.getAll('participantIds').map(Number);
    if (type === 'shared' && participantIds.length === 0) return showToast('Select at least one split participant.', true);
    try {
      const result = await api('/api/expenses', { method: 'POST', body: JSON.stringify({ title: values.get('title'), amount: values.get('amount'), expenseDate: values.get('expenseDate'), category: values.get('category'), expenseType: type, participantIds }) });
      showToast(result.message);
      form.reset();
      const dateInput = form.querySelector('[name="expenseDate"]'); if (dateInput) dateInput.value = localToday();
      form.querySelectorAll('[name="participantIds"]').forEach(box => box.checked = true);
      location.hash = '#approvals';
    } catch (error) { showToast(error.message, true); }
    return;
  }
  if (form.id === 'expense-filters') {
    const query = new URLSearchParams();
    for (const [key, value] of values.entries()) if (String(value).trim()) query.set(key, value);
    location.hash = `#expenses${query.size ? `?${query}` : ''}`;
    return;
  }
  if (form.id === 'settlement-action-form') {
    const mode = form.dataset.mode;
    const amount = values.has('fullAmount')
      ? (Number(form.dataset.amountPaise) / 100).toFixed(2)
      : values.get('amount');
    try {
      let result;
      if (mode === 'pay') {
        result = await api('/api/settlements', { method: 'POST', body: JSON.stringify({ receiverId: form.dataset.receiverId, amount, paymentDate: values.get('paymentDate'), note: values.get('note') }) });
      } else if (mode === 'receive') {
        result = await api('/api/settlements/received', { method: 'POST', body: JSON.stringify({ payerId: form.dataset.payerId, amount, paymentDate: values.get('paymentDate'), note: values.get('note') }) });
      } else {
        result = await api(`/api/settlements/${form.dataset.id}/confirm`, { method: 'POST', body: JSON.stringify({ amount }) });
      }
      form.closest('.modal-backdrop')?.remove();
      await loadRoute({ background: true });
      showToast(result.message);
    } catch (error) { showToast(error.message, true); }
    return;
  }
  if (form.id === 'report-filters') {
    location.hash = `#reports?${new URLSearchParams({ month: values.get('month'), year: values.get('year') })}`;
  }
});

app.addEventListener('change', event => {
  if (event.target.name === 'expenseType') {
    const box = document.getElementById('participants-field');
    if (box) box.style.display = event.target.value === 'shared' ? '' : 'none';
  }
  if (event.target.id === 'settlement-receiver') {
    const option = event.target.selectedOptions[0];
    const amount = document.getElementById('settlement-amount');
    if (amount && option) amount.value = (Number(option.dataset.max) / 100).toFixed(2);
  }
  if (event.target.id === 'settlement-full-amount') {
    const amount = document.getElementById('settlement-custom-amount');
    if (amount) amount.disabled = event.target.checked;
  }
});

app.addEventListener('reset', event => {
  if (event.target.id === 'expense-form') setTimeout(() => {
    const field = document.getElementById('participants-field');
    if (field) field.style.display = '';
  }, 0);
});

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'logout') return logout();
  if (action === 'theme') { document.body.classList.toggle('dark'); return; }
  if (action === 'notifications') { notificationOpen = !notificationOpen; await loadRoute(); return; }
  if (action === 'read-all') { try { await api('/api/notifications/read-all', { method: 'PATCH', body: '{}' }); window.__unread = 0; await loadNotifications(); updateUnreadBadge(); } catch (e) { showToast(e.message, true); } return; }
  if (action === 'open-notification') {
    try { await api(`/api/notifications/${button.dataset.id}/read`, { method: 'PATCH', body: '{}' }); } catch {}
    notificationOpen = false;
    location.hash = button.dataset.related === 'settlement' ? '#settlements' : '#approvals';
    return;
  }
  if (action === 'details') return showExpenseDetails(button.dataset.id);
  if (action === 'settlement-action') return openSettlementModal(button);
  if (action === 'close-modal') { button.closest('.modal-backdrop')?.remove(); return; }
  if (action === 'retry') return loadRoute();
  if (action === 'page') {
    const { params } = routeFromHash(); params.set('page', button.dataset.page);
    location.hash = `#expenses?${params}`; return;
  }
  if (action === 'vote') {
    let reason = '';
    if (button.dataset.vote === 'rejected') reason = (window.prompt('Optional rejection reason:') || '').trim();
    button.disabled = true;
    try {
      const result = await api(`/api/approvals/${button.dataset.id}/vote`, { method: 'POST', body: JSON.stringify({ vote: button.dataset.vote, reason }) });
      await loadRoute({ background: true });
      showToast(result.status === 'approved' ? 'Expense approved and added to the ledger.' : result.status === 'rejected' ? 'Expense rejected and kept in the audit history.' : 'Your vote has been recorded.');
    } catch (error) { button.disabled = false; showToast(error.message, true); }
    return;
  }
  if (action === 'confirm-settlement') {
    button.disabled = true;
    try { const result = await api(`/api/settlements/${button.dataset.id}/confirm`, { method: 'POST', body: '{}' }); await loadRoute({ background: true }); showToast(result.message); }
    catch (error) { button.disabled = false; showToast(error.message, true); }
  }
});

document.addEventListener('click', event => {
  const backdrop = event.target.closest('.modal-backdrop');
  if (backdrop && event.target === backdrop) backdrop.remove();
  if (notificationOpen && !event.target.closest('.notification-panel') && !event.target.closest('[data-action="notifications"]')) {
    notificationOpen = false;
    document.querySelector('.notification-panel')?.remove();
  }
});

async function afterLogin() {
  const data = await api('/api/notifications');
  window.__unread = data.unread;
  await loadRoute();
}

window.addEventListener('hashchange', () => { notificationOpen = false; loadRoute(); });
async function boot() {
  try {
    const session = await api('/api/auth/session');
    if (!session.authenticated) return renderLogin();
    currentUser = session.user;
    const notifications = await api('/api/notifications');
    window.__unread = notifications.unread;
    await loadRoute();
  } catch (error) { renderLogin(error.message); }
}
setInterval(async () => {
  if (!currentUser || livePollBusy || document.hidden) return;
  livePollBusy = true;
  try {
    const data = await api('/api/notifications');
    window.__unread = data.unread;
    updateUnreadBadge();
    const route = currentRoute;
    const endpoints = { dashboard: '/api/dashboard', approvals: '/api/approvals', settlements: '/api/settlements' };
    if (endpoints[route] && !document.querySelector('.modal-backdrop')) {
      const snapshot = await api(endpoints[route]);
      const signature = liveSnapshot(route, snapshot);
      const previous = liveSnapshots.get(route);
      liveSnapshots.set(route, signature);
      if ((previous === null || (previous !== undefined && previous !== signature)) && currentRoute === route) {
        await loadRoute({ background: true });
      }
    }
  } catch {} finally {
    livePollBusy = false;
  }
}, 9000);
boot();

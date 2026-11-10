const { allocateShares } = require('./money');

const CATEGORIES = ['Groceries', 'Food', 'Electricity', 'Gas', 'Internet', 'Rent', 'Maintenance', 'Other'];
const TYPES = ['shared', 'personal'];

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function currentHouseholdMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = parts.find(part => part.type === 'year').value;
  const month = parts.find(part => part.type === 'month').value;
  return `${year}-${month}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function notify(db, userId, title, message, relatedType, relatedId) {
  await db.prepare(`INSERT INTO notifications(user_id,title,message,related_type,related_id) VALUES(?,?,?,?,?)`)
    .run(userId, title, message, relatedType, relatedId);
}

async function tallyVotes(db, expenseId, eligibleUserIds) {
  if (eligibleUserIds && eligibleUserIds.length === 0) return { approvals: 0, rejections: 0 };
  const voterFilter = eligibleUserIds ? ` AND user_id IN (${eligibleUserIds.map(() => '?').join(',')})` : '';
  const params = eligibleUserIds ? [expenseId, ...eligibleUserIds] : [expenseId];
  const tally = await db.prepare(`SELECT
      SUM(CASE WHEN vote='approved' THEN 1 ELSE 0 END) AS approvals,
      SUM(CASE WHEN vote='rejected' THEN 1 ELSE 0 END) AS rejections
    FROM expense_votes WHERE expense_id=?${voterFilter}`).get(...params);
  return { approvals: Number(tally?.approvals) || 0, rejections: Number(tally?.rejections) || 0 };
}

async function createExpense(db, actorId, body) {
  const title = String(body.title || '').trim();
  const category = String(body.category || '');
  const type = String(body.expenseType || '');
  const date = String(body.expenseDate || '');
  const amountPaise = Number(body.amountPaise);
  if (!title || title.length > 120) fail('Description is required and must be 120 characters or fewer.');
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) fail('Enter a valid positive amount.');
  if (!validDate(date)) fail('Choose a valid expense date.');
  if (!CATEGORIES.includes(category)) fail('Choose a valid expense category.');
  if (!TYPES.includes(type)) fail('Choose shared or personal expense.');
  const allUsers = (await db.prepare('SELECT id FROM users ORDER BY id').all()).map(row => row.id);
  if (allUsers.length !== 5 || !allUsers.includes(actorId)) fail('BalanceIT must be configured with exactly five members.', 500);
  let participants = [];
  if (type === 'shared') {
    const requested = Array.isArray(body.participantIds) ? body.participantIds.map(Number) : [];
    if (requested.length < 2 || requested.some(id => !allUsers.includes(id))) fail('A shared expense needs at least two valid participants.');
    if (new Set(requested).size !== requested.length) fail('A participant can only be selected once.');
    if (!requested.includes(actorId)) fail('Include yourself in the split. Your submission counts as your approval.');
    participants = allocateShares(amountPaise, requested);
  }
  const insert = db.transaction(async () => {
    const result = await db.prepare(`INSERT INTO expenses(title,amount_paise,category,expense_date,expense_type,paid_by,status)
      VALUES(?,?,?,?,?,?,'pending')`).run(title, amountPaise, category, date, type, actorId);
    const expenseId = Number(result.lastInsertRowid);
    for (const participant of participants) await db.prepare('INSERT INTO expense_participants(expense_id,user_id,share_paise) VALUES(?,?,?)').run(expenseId, participant.userId, participant.sharePaise);
    const name = (await db.prepare('SELECT display_name FROM users WHERE id=?').get(actorId)).display_name;
    const approvalRecipients = type === 'shared'
      ? participants.map(participant => participant.userId).filter(id => id !== actorId)
      : allUsers.filter(id => id !== actorId);
    for (const userId of approvalRecipients) {
      await notify(db, userId, 'Expense needs your review', `${name} submitted “${title}” for approval.`, 'expense', expenseId);
    }
    return expenseId;
  });
  return await insert();
}

async function voteOnExpense(db, actorId, expenseId, vote, reason = '') {
  if (!['approved', 'rejected'].includes(vote)) fail('Choose approve or reject.');
  const cleanReason = vote === 'rejected' ? String(reason || '').trim().slice(0, 250) : null;
  const apply = db.transaction(async () => {
    // Serialize votes per expense. PostgreSQL locks this row; SQLite begins the
    // transaction with BEGIN IMMEDIATE, so a vote cannot slip in after closure.
    const lock = db.isPostgres ? ' FOR UPDATE' : '';
    const expense = await db.prepare(`SELECT * FROM expenses WHERE id=?${lock}`).get(expenseId);
    if (!expense) fail('Expense not found.', 404);
    if (expense.paid_by === actorId) fail('You cannot vote on an expense you submitted.', 403);
    if (expense.status !== 'pending') fail('This expense is no longer awaiting approval.', 409);
    const allUsers = (await db.prepare('SELECT id FROM users ORDER BY id').all()).map(user => user.id);
    if (allUsers.length !== 5) fail('BalanceIT must be configured with exactly five members.', 500);
    let eligibleVoters;
    let automaticApprovals = 0;
    let approvalsRequired = 3;
    if (expense.expense_type === 'shared') {
      const participantIds = (await db.prepare('SELECT user_id FROM expense_participants WHERE expense_id=? ORDER BY user_id').all(expenseId)).map(row => row.user_id);
      if (!participantIds.includes(actorId)) fail('Only members included in this expense can vote on it.', 403);
      const approvalGroupSize = participantIds.length + (participantIds.includes(expense.paid_by) ? 0 : 1);
      if (approvalGroupSize < 2 || approvalGroupSize > 5) fail('This shared expense has an invalid participant group.', 500);
      automaticApprovals = 1; // The selected submitter counts as an approval, but never casts a stored vote.
      approvalsRequired = approvalGroupSize === 5 ? 4 : approvalGroupSize;
      eligibleVoters = participantIds.filter(userId => userId !== expense.paid_by);
    } else {
      eligibleVoters = allUsers.filter(userId => userId !== expense.paid_by);
    }
    try {
      await db.prepare('INSERT INTO expense_votes(expense_id,user_id,vote,rejection_reason) VALUES(?,?,?,?)')
        .run(expenseId, actorId, vote, cleanReason);
    } catch (error) {
      if (/UNIQUE constraint failed: expense_votes\.expense_id, expense_votes\.user_id/i.test(error.message || '') || (error.code === '23505' && error.constraint === 'expense_votes_expense_id_user_id_key')) fail('You have already voted on this expense.', 409);
      throw error;
    }
    const tally = await tallyVotes(db, expenseId, eligibleVoters);
    const approvals = automaticApprovals + tally.approvals;
    const rejectionsRequired = expense.expense_type === 'shared'
      ? (eligibleVoters.length + automaticApprovals === 5 ? 2 : 1)
      : 2;
    let status = 'pending';
    let rejectionReason = null;
    if (approvals >= approvalsRequired) status = 'approved';
    else if (tally.rejections >= rejectionsRequired || approvals + eligibleVoters.length - tally.approvals - tally.rejections < approvalsRequired) {
      status = 'rejected';
      const reasonParams = [expenseId, ...eligibleVoters];
      rejectionReason = (await db.prepare(`SELECT rejection_reason FROM expense_votes WHERE expense_id=? AND vote='rejected' AND rejection_reason IS NOT NULL AND rejection_reason!='' AND user_id IN (${eligibleVoters.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`).get(...reasonParams))?.rejection_reason || null;
    }
    if (status !== 'pending') {
      await db.prepare("UPDATE expenses SET status=?, rejection_reason=?, updated_at=datetime('now') WHERE id=? AND status='pending'")
        .run(status, rejectionReason, expenseId);
      const submitter = (await db.prepare('SELECT paid_by FROM expenses WHERE id=?').get(expenseId)).paid_by;
      const title = status === 'approved' ? 'Expense approved' : 'Expense rejected';
      const message = status === 'approved'
        ? `Your expense “${expense.title}” was approved and added to the ledger.`
        : `Your expense “${expense.title}” was rejected${rejectionReason ? `: ${rejectionReason}` : '.'}`;
      await notify(db, submitter, title, message, 'expense', expenseId);
    }
    return { status, approvals, rejections: tally.rejections, approvalsRequired };
  });
  return await apply();
}

async function financeSnapshot(db) {
  const members = await db.prepare('SELECT id,username,display_name FROM users ORDER BY id').all();
  const rows = await db.prepare(`SELECT id,amount_paise,expense_type,paid_by,expense_date,title,category,status
    FROM expenses WHERE status='approved' ORDER BY expense_date DESC,id DESC`).all();
  const balances = new Map(members.map(m => [m.id, {
    id: m.id, username: m.username, name: m.display_name,
    sharedPaidPaise: 0, personalPaidPaise: 0, totalPaidPaise: 0,
    fairSharePaise: 0, netBalancePaise: 0
  }]));
  const shares = await db.prepare(`SELECT ep.user_id,ep.share_paise FROM expense_participants ep
    JOIN expenses e ON e.id=ep.expense_id WHERE e.status='approved' AND e.expense_type='shared'`).all();
  for (const row of rows) {
    const member = balances.get(row.paid_by);
    if (!member) continue;
    member.totalPaidPaise += row.amount_paise;
    if (row.expense_type === 'shared') member.sharedPaidPaise += row.amount_paise;
    else member.personalPaidPaise += row.amount_paise;
  }
  for (const row of shares) {
    const member = balances.get(row.user_id);
    if (member) member.fairSharePaise += row.share_paise;
  }
  const settlements = await db.prepare(`SELECT payer_id,receiver_id,
    COALESCE(confirmed_amount_paise,amount_paise) AS settled_amount_paise
    FROM settlements WHERE status='confirmed'`).all();
  for (const row of settlements) {
    const payer = balances.get(row.payer_id);
    const receiver = balances.get(row.receiver_id);
    if (payer) payer.netBalancePaise += row.settled_amount_paise;
    if (receiver) receiver.netBalancePaise -= row.settled_amount_paise;
  }
  for (const member of balances.values()) member.netBalancePaise += member.sharedPaidPaise - member.fairSharePaise;
  const approvedSharedPaise = rows.filter(row => row.expense_type === 'shared').reduce((sum, row) => sum + row.amount_paise, 0);
  const approvedPersonalPaise = rows.filter(row => row.expense_type === 'personal').reduce((sum, row) => sum + row.amount_paise, 0);
  return { members: [...balances.values()], rows, approvedSharedPaise, approvedPersonalPaise };
}

function suggestSettlements(memberBalances) {
  const active = memberBalances.filter(member => member.netBalancePaise !== 0)
    .map(member => ({ id: member.id, name: member.name, balance: member.netBalancePaise }));
  const owed = active.filter(m => m.balance < 0).reduce((sum, m) => sum - m.balance, 0);
  const receivable = active.filter(m => m.balance > 0).reduce((sum, m) => sum + m.balance, 0);
  if (owed !== receivable) fail('Ledger balances do not reconcile. Please review approved expense splits.', 500);
  if (!active.length) return [];

  // There are exactly five members, so enumerate zero-sum member groups to find a
  // minimum-transfer partition. Every indivisible group can be cleared in k-1 transfers.
  const zeroSumGroups = [];
  for (let mask = 1; mask < (1 << active.length); mask++) {
    let count = 0;
    let sum = 0;
    for (let index = 0; index < active.length; index++) {
      if (mask & (1 << index)) { count++; sum += active[index].balance; }
    }
    if (count > 1 && sum === 0) zeroSumGroups.push(mask);
  }
  let bestPartition = [];
  function partition(remaining, groups) {
    if (remaining === 0) {
      if (groups.length > bestPartition.length) bestPartition = groups;
      return;
    }
    if (groups.length + Math.floor(active.length / 2) <= bestPartition.length) return;
    const firstMember = remaining & -remaining;
    for (const group of zeroSumGroups) {
      if ((group & firstMember) && (group & remaining) === group) partition(remaining ^ group, [...groups, group]);
    }
  }
  partition((1 << active.length) - 1, []);

  const suggestions = [];
  for (const group of bestPartition) {
    const debtors = active.filter((_, index) => group & (1 << index)).filter(member => member.balance < 0)
      .map(member => ({ ...member, remaining: -member.balance })).sort((a, b) => b.remaining - a.remaining || a.id - b.id);
    const creditors = active.filter((_, index) => group & (1 << index)).filter(member => member.balance > 0)
      .map(member => ({ ...member, remaining: member.balance })).sort((a, b) => b.remaining - a.remaining || a.id - b.id);
    let d = 0, c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amountPaise = Math.min(debtors[d].remaining, creditors[c].remaining);
      if (amountPaise > 0) suggestions.push({ payerId: debtors[d].id, payerName: debtors[d].name, receiverId: creditors[c].id, receiverName: creditors[c].name, amountPaise });
      debtors[d].remaining -= amountPaise;
      creditors[c].remaining -= amountPaise;
      if (debtors[d].remaining === 0) d++;
      if (creditors[c].remaining === 0) c++;
    }
  }
  return suggestions;
}

async function getDashboard(db, actorId) {
  const snapshot = await financeSnapshot(db);
  const month = currentHouseholdMonth();
  const currentMonthPaise = snapshot.rows.filter(row => row.expense_type === 'shared' && row.expense_date.startsWith(month))
    .reduce((sum, row) => sum + row.amount_paise, 0);
  const pendingApprovals = (await db.prepare("SELECT COUNT(*) AS count FROM expenses WHERE status='pending'").get()).count;
  const unreadNotifications = await db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0').get(actorId);
  return {
    totalApprovedGroupPaise: snapshot.approvedSharedPaise,
    currentMonthPaise,
    averageSharePaise: snapshot.members.length ? Math.round(snapshot.approvedSharedPaise / snapshot.members.length) : 0,
    pendingApprovals,
    outstandingSettlementPaise: snapshot.members.filter(m => m.netBalancePaise < 0).reduce((sum, m) => sum - m.netBalancePaise, 0),
    members: snapshot.members,
    recentExpenses: await Promise.all(snapshot.rows.slice(0, 8).map(row => expenseWithPayer(db, row.id))),
    settlementSuggestions: suggestSettlements(snapshot.members),
    unreadNotifications: unreadNotifications.count
  };
}

async function expenseWithPayer(db, id) {
  const expense = await db.prepare(`SELECT e.*,u.display_name AS paid_by_name,u.username AS paid_by_username FROM expenses e JOIN users u ON u.id=e.paid_by WHERE e.id=?`).get(id);
  if (!expense) return null;
  expense.participants = await db.prepare(`SELECT u.id,u.display_name AS name,ep.share_paise FROM expense_participants ep JOIN users u ON u.id=ep.user_id WHERE ep.expense_id=? ORDER BY u.id`).all(id);
  const eligibleVoters = expense.expense_type === 'shared'
    ? expense.participants.map(participant => participant.id).filter(userId => userId !== expense.paid_by)
    : (await db.prepare('SELECT id FROM users WHERE id!=? ORDER BY id').all(expense.paid_by)).map(user => user.id);
  const tally = await tallyVotes(db, id, eligibleVoters);
  expense.approvals = tally.approvals + (expense.expense_type === 'shared' ? 1 : 0);
  expense.rejections = tally.rejections;
  const approvalGroupSize = expense.participants.length + (expense.participants.some(participant => participant.id === expense.paid_by) ? 0 : 1);
  expense.approvals_required = expense.expense_type === 'personal' ? 3 : (approvalGroupSize === 5 ? 4 : approvalGroupSize);
  expense.votes = await db.prepare(`SELECT v.user_id,u.display_name AS name,v.vote,v.rejection_reason,v.created_at FROM expense_votes v JOIN users u ON u.id=v.user_id WHERE v.expense_id=? ORDER BY v.created_at`).all(id);
  return expense;
}

async function listExpenses(db, query = {}) {
  const where = ["e.status='approved'"];
  const params = [];
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) { where.push("substr(e.expense_date,1,7)=?"); params.push(query.month); }
  if (query.year && /^\d{4}$/.test(query.year)) { where.push("substr(e.expense_date,1,4)=?"); params.push(query.year); }
  if (query.member && /^\d+$/.test(query.member)) { where.push('e.paid_by=?'); params.push(Number(query.member)); }
  if (query.category && CATEGORIES.includes(query.category)) { where.push('e.category=?'); params.push(query.category); }
  if (query.type && TYPES.includes(query.type)) { where.push('e.expense_type=?'); params.push(query.type); }
  if (query.search) { where.push('(e.title LIKE ? OR u.display_name LIKE ? OR e.category LIKE ?)'); const term = `%${String(query.search).slice(0, 80)}%`; params.push(term, term, term); }
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM expenses e JOIN users u ON u.id=e.paid_by WHERE ${where.join(' AND ')}`).get(...params)).count;
  const rows = await db.prepare(`SELECT e.*,u.display_name AS paid_by_name FROM expenses e JOIN users u ON u.id=e.paid_by
    WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC,e.id DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const totals = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN expense_type='shared' THEN amount_paise ELSE 0 END),0) AS shared_paise,
    COALESCE(SUM(CASE WHEN expense_type='personal' THEN amount_paise ELSE 0 END),0) AS personal_paise,
    COALESCE(SUM(amount_paise),0) AS total_paise FROM expenses e JOIN users u ON u.id=e.paid_by WHERE ${where.join(' AND ')}`)
    .get(...params);
  const byMember = await db.prepare(`SELECT u.id,u.display_name,COALESCE(SUM(e.amount_paise),0) AS amount_paise FROM users u
    LEFT JOIN expenses e ON e.paid_by=u.id AND ${where.join(' AND ')} GROUP BY u.id ORDER BY u.id`).all(...params);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / limit)), totals, byMember };
}

async function getApprovals(db, actorId) {
  const pending = await db.prepare(`WITH pending_expenses AS (
    SELECT e.id,e.title,e.amount_paise,e.category,e.expense_date,e.expense_type,e.paid_by,e.status,e.created_at,
      u.display_name AS paid_by_name,
      (SELECT COUNT(*) FROM expense_participants ep WHERE ep.expense_id=e.id) AS participant_count,
      CASE WHEN EXISTS(SELECT 1 FROM expense_participants ep WHERE ep.expense_id=e.id AND ep.user_id=e.paid_by) THEN 1 ELSE 0 END AS payer_is_participant
    FROM expenses e JOIN users u ON u.id=e.paid_by WHERE e.status='pending'
  )
  SELECT p.*,
    CASE WHEN p.expense_type='shared' THEN 1 ELSE 0 END +
      (SELECT COUNT(*) FROM expense_votes v WHERE v.expense_id=p.id AND v.vote='approved' AND v.user_id!=p.paid_by
        AND (p.expense_type='personal' OR EXISTS(SELECT 1 FROM expense_participants ep WHERE ep.expense_id=p.id AND ep.user_id=v.user_id))) AS approvals,
    (SELECT COUNT(*) FROM expense_votes v WHERE v.expense_id=p.id AND v.vote='rejected' AND v.user_id!=p.paid_by
      AND (p.expense_type='personal' OR EXISTS(SELECT 1 FROM expense_participants ep WHERE ep.expense_id=p.id AND ep.user_id=v.user_id))) AS rejections,
    (SELECT v.vote FROM expense_votes v WHERE v.expense_id=p.id AND v.user_id=? LIMIT 1) AS my_vote,
    p.participant_count + CASE WHEN p.payer_is_participant=1 THEN 0 ELSE 1 END AS approval_group_size,
    CASE WHEN p.expense_type='personal' THEN 3
      WHEN p.participant_count + CASE WHEN p.payer_is_participant=1 THEN 0 ELSE 1 END=5 THEN 4
      ELSE p.participant_count + CASE WHEN p.payer_is_participant=1 THEN 0 ELSE 1 END END AS approvals_required,
    CASE WHEN p.expense_type='personal' THEN 2
      WHEN p.participant_count + CASE WHEN p.payer_is_participant=1 THEN 0 ELSE 1 END=5 THEN 2
      ELSE 1 END AS rejections_required,
    CASE WHEN p.paid_by!=? AND (p.expense_type='personal' OR EXISTS(
      SELECT 1 FROM expense_participants ep WHERE ep.expense_id=p.id AND ep.user_id=?
    )) THEN 1 ELSE 0 END AS can_vote
  FROM pending_expenses p ORDER BY p.created_at DESC`).all(actorId, actorId, actorId);
  const history = await db.prepare(`SELECT e.id,e.title,e.amount_paise,e.category,e.expense_date,e.expense_type,e.status,e.rejection_reason,u.display_name AS paid_by_name,
    (SELECT SUM(vote='approved') FROM expense_votes WHERE expense_id=e.id) AS approvals,
    (SELECT SUM(vote='rejected') FROM expense_votes WHERE expense_id=e.id) AS rejections
    FROM expenses e JOIN users u ON u.id=e.paid_by WHERE e.status!='pending' ORDER BY e.updated_at DESC LIMIT 20`).all();
  return { pending, history };
}

async function getSettlements(db) {
  const snapshot = await financeSnapshot(db);
  const history = await db.prepare(`SELECT s.*,p.display_name AS payer_name,r.display_name AS receiver_name FROM settlements s
    JOIN users p ON p.id=s.payer_id JOIN users r ON r.id=s.receiver_id ORDER BY s.created_at DESC LIMIT 100`).all();
  return { members: snapshot.members, suggestions: suggestSettlements(snapshot.members), history };
}

async function createSettlement(db, actorId, body) {
  const receiverId = Number(body.receiverId);
  const amountPaise = Number(body.amountPaise);
  const paymentDate = String(body.paymentDate || '');
  const note = String(body.note || '').trim().slice(0, 250) || null;
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) fail('Enter a valid positive payment amount.');
  if (!validDate(paymentDate)) fail('Choose a valid payment date.');
  if (receiverId === actorId) fail('You cannot record a payment to yourself.');
  const dbReceiver = await db.prepare('SELECT id FROM users WHERE id=?').get(receiverId);
  if (!dbReceiver) fail('Choose a valid recipient.');
  const snapshot = await financeSnapshot(db);
  const payer = snapshot.members.find(m => m.id === actorId);
  const receiver = snapshot.members.find(m => m.id === receiverId);
  if (!payer || !receiver || payer.netBalancePaise >= 0 || receiver.netBalancePaise <= 0) fail('This member pair has no outstanding settlement to record.', 409);
  if (amountPaise > Math.min(-payer.netBalancePaise, receiver.netBalancePaise)) fail('Payment exceeds the current outstanding amount between these balances.', 409);
  const pending = await db.prepare(`SELECT id FROM settlements WHERE payer_id=? AND receiver_id=? AND status='pending_confirmation'`).get(actorId, receiverId);
  if (pending) fail('A payment request for this member is already waiting for confirmation.', 409);
  const tx = db.transaction(async () => {
    const result = await db.prepare(`INSERT INTO settlements(payer_id,receiver_id,amount_paise,payment_date,note,status) VALUES(?,?,?,?,?,'pending_confirmation')`)
      .run(actorId, receiverId, amountPaise, paymentDate, note);
    const payerName = (await db.prepare('SELECT display_name FROM users WHERE id=?').get(actorId)).display_name;
    await notify(db, receiverId, 'Confirm a settlement', `${payerName} recorded a payment. Confirm it once received.`, 'settlement', Number(result.lastInsertRowid));
    return Number(result.lastInsertRowid);
  });
  return await tx();
}

async function recordReceivedSettlement(db, actorId, body) {
  const payerId = Number(body.payerId);
  const amountPaise = Number(body.amountPaise);
  const paymentDate = String(body.paymentDate || '');
  const note = String(body.note || '').trim().slice(0, 250) || null;
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) fail('Enter a valid positive amount received.');
  if (!validDate(paymentDate)) fail('Choose a valid payment date.');
  if (payerId === actorId) fail('A payment must come from another member.');
  const snapshot = await financeSnapshot(db);
  const payer = snapshot.members.find(member => member.id === payerId);
  const receiver = snapshot.members.find(member => member.id === actorId);
  if (!payer || !receiver || payer.netBalancePaise >= 0 || receiver.netBalancePaise <= 0) fail('This member pair has no outstanding amount to receive.', 409);
  if (amountPaise > Math.min(-payer.netBalancePaise, receiver.netBalancePaise)) fail('Received amount exceeds the current outstanding balance.', 409);
  const pending = await db.prepare(`SELECT id FROM settlements WHERE payer_id=? AND receiver_id=? AND status='pending_confirmation'`).get(payerId, actorId);
  if (pending) fail('There is already a payment request from this member. Use its Received action to confirm the amount.', 409);

  const tx = db.transaction(async () => {
    const result = await db.prepare(`INSERT INTO settlements(payer_id,receiver_id,amount_paise,confirmed_amount_paise,payment_date,note,status,confirmed_at)
      VALUES(?,?,?,?,?,?,'confirmed',datetime('now'))`).run(payerId, actorId, amountPaise, amountPaise, paymentDate, note);
    const receiverName = (await db.prepare('SELECT display_name FROM users WHERE id=?').get(actorId)).display_name;
    const payerName = (await db.prepare('SELECT display_name FROM users WHERE id=?').get(payerId)).display_name;
    const settlementId = Number(result.lastInsertRowid);
    await notify(db, payerId, 'Payment marked received', `${receiverName} marked your payment as received.`, 'settlement', settlementId);
    await notify(db, actorId, 'Payment received', `Received a payment from ${payerName}.`, 'settlement', settlementId);
    return settlementId;
  });
  return await tx();
}

async function confirmSettlement(db, actorId, settlementId, confirmedAmountPaise) {
  const tx = db.transaction(async () => {
    const settlement = await db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
    if (!settlement) fail('Settlement not found.', 404);
    if (settlement.receiver_id !== actorId) fail('Only the receiver can confirm this payment.', 403);
    if (settlement.status !== 'pending_confirmation') fail('This settlement has already been confirmed.', 409);
    const actualPaise = confirmedAmountPaise === undefined ? settlement.amount_paise : Number(confirmedAmountPaise);
    if (!Number.isSafeInteger(actualPaise) || actualPaise <= 0 || actualPaise > settlement.amount_paise) {
      fail('Confirmed amount must be positive and no more than the requested amount.');
    }
    const snapshot = await financeSnapshot(db);
    const payer = snapshot.members.find(m => m.id === settlement.payer_id);
    const receiver = snapshot.members.find(m => m.id === settlement.receiver_id);
    if (!payer || !receiver || payer.netBalancePaise >= 0 || receiver.netBalancePaise <= 0 || actualPaise > Math.min(-payer.netBalancePaise, receiver.netBalancePaise)) {
      fail('The outstanding balances changed; this payment can no longer be confirmed as recorded.', 409);
    }
    await db.prepare("UPDATE settlements SET status='confirmed',confirmed_amount_paise=?,confirmed_at=datetime('now') WHERE id=? AND status='pending_confirmation'").run(actualPaise, settlementId);
    const receiverName = (await db.prepare('SELECT display_name FROM users WHERE id=?').get(actorId)).display_name;
    await notify(db, settlement.payer_id, 'Settlement confirmed', `${receiverName} confirmed ${actualPaise < settlement.amount_paise ? 'a partial payment' : 'your payment'}.`, 'settlement', settlementId);
    await notify(db, actorId, 'Settlement confirmed', 'The confirmed amount is now included in the balances.', 'settlement', settlementId);
    return { confirmedAmountPaise: actualPaise };
  });
  return await tx();
}

async function getReport(db, year, month) {
  if (!/^\d{4}$/.test(String(year)) || !/^(0[1-9]|1[0-2])$/.test(String(month))) fail('Choose a valid report month.');
  const key = `${year}-${month}`;
  const expenses = await db.prepare(`SELECT e.*,u.display_name AS paid_by_name FROM expenses e JOIN users u ON u.id=e.paid_by
    WHERE e.status='approved' AND substr(e.expense_date,1,7)=? ORDER BY e.expense_date,e.id`).all(key);
  const members = await db.prepare('SELECT id,display_name FROM users ORDER BY id').all();
  const paid = new Map(members.map(m => [m.id, { id: m.id, name: m.display_name, totalPaidPaise: 0, sharedPaidPaise: 0, personalPaidPaise: 0, fairSharePaise: 0 }]));
  for (const expense of expenses) {
    const m = paid.get(expense.paid_by);
    m.totalPaidPaise += expense.amount_paise;
    m[expense.expense_type === 'shared' ? 'sharedPaidPaise' : 'personalPaidPaise'] += expense.amount_paise;
  }
  const shares = await db.prepare(`SELECT ep.user_id,ep.share_paise FROM expense_participants ep JOIN expenses e ON e.id=ep.expense_id
    WHERE e.status='approved' AND e.expense_type='shared' AND substr(e.expense_date,1,7)=?`).all(key);
  for (const share of shares) if (paid.has(share.user_id)) paid.get(share.user_id).fairSharePaise += share.share_paise;
  const categories = await db.prepare(`SELECT e.category,SUM(e.amount_paise) AS amount_paise FROM expenses e WHERE e.status='approved' AND substr(e.expense_date,1,7)=? GROUP BY e.category ORDER BY amount_paise DESC`).all(key);
  const allBalances = (await financeSnapshot(db)).members;
  const settlementHistory = await db.prepare(`SELECT s.*,p.display_name AS payer_name,r.display_name AS receiver_name FROM settlements s JOIN users p ON p.id=s.payer_id JOIN users r ON r.id=s.receiver_id
    WHERE substr(s.payment_date,1,7)=? ORDER BY s.payment_date`).all(key);
  return {
    month: key, expenses, members: [...paid.values()].map(m => ({ ...m, netBalancePaise: allBalances.find(b => b.id === m.id)?.netBalancePaise || 0 })),
    categories,
    totals: {
      sharedPaise: expenses.filter(e => e.expense_type === 'shared').reduce((sum, e) => sum + e.amount_paise, 0),
      personalPaise: expenses.filter(e => e.expense_type === 'personal').reduce((sum, e) => sum + e.amount_paise, 0)
    }, settlementHistory
  };
}

async function buildDataResetArchive(db) {
  const members = await db.prepare('SELECT id,username,display_name FROM users ORDER BY id').all();
  const expenses = await db.prepare(`SELECT e.*,u.display_name AS paid_by_name FROM expenses e
    JOIN users u ON u.id=e.paid_by ORDER BY e.id`).all();
  for (const expense of expenses) {
    expense.participants = await db.prepare(`SELECT ep.user_id,u.display_name,ep.share_paise FROM expense_participants ep
      JOIN users u ON u.id=ep.user_id WHERE ep.expense_id=? ORDER BY ep.user_id`).all(expense.id);
    expense.votes = await db.prepare(`SELECT v.user_id,u.display_name,v.vote,v.rejection_reason,v.created_at FROM expense_votes v
      JOIN users u ON u.id=v.user_id WHERE v.expense_id=? ORDER BY v.created_at,v.id`).all(expense.id);
  }
  const settlements = await db.prepare(`SELECT s.*,p.display_name AS payer_name,r.display_name AS receiver_name
    FROM settlements s JOIN users p ON p.id=s.payer_id JOIN users r ON r.id=s.receiver_id ORDER BY s.id`).all();
  return { members, expenses, settlements };
}

async function getDataResetState(db) {
  const requests = await db.prepare(`SELECT r.id,r.requested_by,r.status,r.created_at,r.completed_at,
      u.display_name AS requested_by_name,
      (SELECT COUNT(*) FROM data_reset_votes v WHERE v.request_id=r.id AND v.vote='approved') AS approvals,
      (SELECT COUNT(*) FROM data_reset_votes v WHERE v.request_id=r.id AND v.vote='rejected') AS rejections,
      a.id AS archive_id,a.archived_at,a.expense_count,a.settlement_count
    FROM data_reset_requests r JOIN users u ON u.id=r.requested_by
    LEFT JOIN data_reset_archives a ON a.request_id=r.id
    ORDER BY r.created_at DESC,r.id DESC LIMIT 30`).all();
  for (const request of requests) {
    request.votes = await db.prepare(`SELECT v.user_id,u.display_name,v.vote,v.created_at FROM data_reset_votes v
      JOIN users u ON u.id=v.user_id WHERE v.request_id=? ORDER BY v.created_at,v.id`).all(request.id);
  }
  const pendingRequest = requests.find(request => request.status === 'pending') || null;
  return {
    pending: pendingRequest,
    history: requests.filter(request => request.status !== 'pending')
  };
}

async function createDataResetRequest(db, actorId) {
  const tx = db.transaction(async () => {
    const existing = await db.prepare("SELECT id FROM data_reset_requests WHERE status='pending'").get();
    if (existing) fail('A household data reset request is already awaiting votes.', 409);
    const requester = await db.prepare('SELECT id,display_name FROM users WHERE id=?').get(actorId);
    if (!requester) fail('Your member account could not be found.', 401);
    const result = await db.prepare("INSERT INTO data_reset_requests(requested_by,status) VALUES(?,'pending')").run(actorId);
    const requestId = Number(result.lastInsertRowid);
    await db.prepare("INSERT INTO data_reset_votes(request_id,user_id,vote) VALUES(?,?,'approved')").run(requestId, actorId);
    const recipients = await db.prepare('SELECT id FROM users WHERE id!=?').all(actorId);
    for (const recipient of recipients) {
      await notify(db, recipient.id, 'Household reset vote requested', `${requester.display_name} requested a full ledger reset. Review it on the Reports page.`, 'data_reset', requestId);
    }
    return requestId;
  });
  return await tx();
}

async function voteOnDataReset(db, actorId, requestId, vote) {
  if (!['approved', 'rejected'].includes(vote)) fail('Choose approve or reject for this reset request.');
  const tx = db.transaction(async () => {
    const request = await db.prepare('SELECT * FROM data_reset_requests WHERE id=?').get(requestId);
    if (!request) fail('Reset request not found.', 404);
    if (request.status !== 'pending') fail('This reset request is no longer awaiting votes.', 409);
    if (request.requested_by === actorId) fail('Your approval was already counted when you requested the reset.', 409);
    const existingVote = await db.prepare('SELECT vote FROM data_reset_votes WHERE request_id=? AND user_id=?').get(requestId, actorId);
    if (existingVote) fail('You have already voted on this reset request.', 409);
    if (!await db.prepare('SELECT id FROM users WHERE id=?').get(actorId)) fail('Your member account could not be found.', 401);

    await db.prepare('INSERT INTO data_reset_votes(request_id,user_id,vote) VALUES(?,?,?)').run(requestId, actorId, vote);
    const counts = await db.prepare(`SELECT SUM(vote='approved') AS approvals,SUM(vote='rejected') AS rejections
      FROM data_reset_votes WHERE request_id=?`).get(requestId);
    const approvals = counts.approvals || 0;
    const rejections = counts.rejections || 0;
    const voter = await db.prepare('SELECT display_name FROM users WHERE id=?').get(actorId);

    if (approvals >= 4) {
      const archive = await buildDataResetArchive(db);
      const archived = await db.prepare(`INSERT INTO data_reset_archives(request_id,archived_by,expense_count,settlement_count,archive_json)
        VALUES(?,?,?,?,?)`).run(requestId, request.requested_by, archive.expenses.length, archive.settlements.length, JSON.stringify(archive));
      const archiveId = Number(archived.lastInsertRowid);
      await db.prepare("UPDATE data_reset_requests SET status='completed',completed_at=datetime('now') WHERE id=?").run(requestId);

      // Keep member accounts and the reset audit/archive tables; clear only the active ledger and old notifications.
      await db.prepare('DELETE FROM expense_votes').run();
      await db.prepare('DELETE FROM expense_participants').run();
      await db.prepare('DELETE FROM expenses').run();
      await db.prepare('DELETE FROM settlements').run();
      await db.prepare('DELETE FROM notifications').run();
      const members = await db.prepare('SELECT id FROM users').all();
      for (const member of members) {
        await notify(db, member.id, 'Ledger reset completed', `The household approved a reset. ${archive.expenses.length} expense records and ${archive.settlements.length} settlement records were archived.`, 'data_reset', requestId);
      }
      return { status: 'completed', approvals, rejections, archiveId, message: 'Reset approved. The live ledger is cleared and its previous history is preserved in Reports.' };
    }

    if (rejections >= 2) {
      await db.prepare("UPDATE data_reset_requests SET status='rejected',completed_at=datetime('now') WHERE id=?").run(requestId);
      const members = await db.prepare('SELECT id FROM users').all();
      for (const member of members) {
        await notify(db, member.id, 'Reset request declined', 'The reset request received two rejections and was closed. No ledger data was changed.', 'data_reset', requestId);
      }
      return { status: 'rejected', approvals, rejections, message: 'Reset request declined. No ledger data was changed.' };
    }

    await notify(db, request.requested_by, 'Reset vote recorded', `${voter.display_name} ${vote} the household reset request.`, 'data_reset', requestId);
    return { status: 'pending', approvals, rejections, message: 'Your vote has been recorded.' };
  });
  return await tx();
}

async function getDataResetArchive(db, archiveId) {
  const row = await db.prepare(`SELECT a.*,r.requested_by,u.display_name AS requested_by_name
    FROM data_reset_archives a JOIN data_reset_requests r ON r.id=a.request_id
    JOIN users u ON u.id=r.requested_by WHERE a.id=?`).get(archiveId);
  if (!row) fail('Preserved history archive not found.', 404);
  return {
    id: row.id, archivedAt: row.archived_at, requestedBy: row.requested_by_name,
    expenseCount: row.expense_count, settlementCount: row.settlement_count,
    ...JSON.parse(row.archive_json)
  };
}

module.exports = {
  CATEGORIES, fail, validDate, currentHouseholdMonth, notify, tallyVotes, createExpense, voteOnExpense,
  financeSnapshot, suggestSettlements, getDashboard, expenseWithPayer, listExpenses,
  getApprovals, getSettlements, createSettlement, recordReceivedSettlement, confirmSettlement, getReport,
  getDataResetState, createDataResetRequest, voteOnDataReset, getDataResetArchive
};

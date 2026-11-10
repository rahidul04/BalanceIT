const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, toPostgresSql } = require('../src/db');
const { allocateShares, parseRupeesToPaise } = require('../src/money');
const service = require('../src/services');
const bcrypt = require('bcryptjs');
const { resetUsers, seedUsers } = require('../src/seed');

function fixture() {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO users(username,password_hash,display_name) VALUES(?,?,?)');
  for (let i = 1; i <= 5; i++) insert.run(`member${i}`, 'test-hash', `Member ${i}`);
  return db;
}

async function approve(db, expenseId, voters = [2, 3, 4]) {
  let state;
  for (const userId of voters) state = await service.voteOnExpense(db, userId, expenseId, 'approved');
  return state;
}

async function submit(db, userId = 1, extra = {}) {
  return await service.createExpense(db, userId, {
    title: 'House supplies', amountPaise: 10000, category: 'Groceries',
    expenseDate: '2026-11-07', expenseType: 'shared', participantIds: [1, 2], ...extra
  });
}

test('PostgreSQL adapter rewrites SQLite placeholders and expressions safely', () => {
  const query = toPostgresSql("SELECT * FROM users WHERE username=? COLLATE NOCASE AND vote='approved' AND x=?");
  assert.equal(query, "SELECT * FROM users WHERE LOWER(username)=LOWER($1) AND vote='approved' AND x=$2");
  assert.equal(toPostgresSql("SELECT SUM(vote='approved'), datetime('now') FROM expense_votes"), "SELECT SUM(CASE WHEN vote='approved' THEN 1 ELSE 0 END), CURRENT_TIMESTAMP FROM expense_votes");
});

test('expense creation is pending and creates review notifications for the other four members', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db);
  assert.equal((await db.prepare('SELECT status FROM expenses WHERE id=?').get(id)).status, 'pending');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE related_id=?').get(id)).n, 4);
  assert.deepEqual((await db.prepare('SELECT share_paise FROM expense_participants WHERE expense_id=? ORDER BY user_id').all(id)).map(r => r.share_paise), [5000, 5000]);
});

test('duplicate votes are blocked by the service and database unique constraint', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db);
  await service.voteOnExpense(db, 2, id, 'approved');
  await assert.rejects(service.voteOnExpense(db, 2, id, 'approved'), /already voted/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM expense_votes WHERE expense_id=?').get(id)).n, 1);
});

test('three distinct approvals approve an expense', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db);
  assert.equal((await service.voteOnExpense(db, 2, id, 'approved')).status, 'pending');
  assert.equal((await service.voteOnExpense(db, 3, id, 'approved')).status, 'pending');
  assert.equal((await service.voteOnExpense(db, 4, id, 'approved')).status, 'approved');
});

test('two rejections reject an expense and preserve the reason', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db);
  await service.voteOnExpense(db, 2, id, 'rejected', 'Please attach the receipt.');
  const result = await service.voteOnExpense(db, 3, id, 'rejected', '');
  assert.equal(result.status, 'rejected');
  assert.equal((await db.prepare('SELECT rejection_reason FROM expenses WHERE id=?').get(id)).rejection_reason, 'Please attach the receipt.');
});

test('expense submitter cannot approve their own expense', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db);
  await assert.rejects(service.voteOnExpense(db, 1, id, 'approved'), /cannot vote/);
});

test('equal split and deterministic paise remainder preserve the full amount', () => {
  assert.deepEqual(allocateShares(50000, [1, 2, 3, 4, 5]).map(p => p.sharePaise), [10000, 10000, 10000, 10000, 10000]);
  const split = allocateShares(100, [3, 1, 2]);
  assert.deepEqual(split, [{ userId: 1, sharePaise: 34 }, { userId: 2, sharePaise: 33 }, { userId: 3, sharePaise: 33 }]);
  assert.equal(split.reduce((sum, p) => sum + p.sharePaise, 0), 100);
  assert.equal(parseRupeesToPaise('20.05'), 2005);
  assert.throws(() => parseRupeesToPaise('1.999'), /valid amount/);
});

test('individual spending totals and net balances use shared expenses only', async t => {
  const db = fixture(); t.after(() => db.close());
  const shared = await submit(db, 1, { amountPaise: 10000 });
  await approve(db, shared);
  const personal = await submit(db, 2, { title: 'Personal headphones', amountPaise: 30000, expenseType: 'personal', participantIds: [] });
  await approve(db, personal, [1, 3, 4]);
  const snapshot = await service.financeSnapshot(db);
  const first = snapshot.members[0];
  const second = snapshot.members[1];
  assert.equal(first.sharedPaidPaise, 10000);
  assert.equal(first.fairSharePaise, 5000);
  assert.equal(first.netBalancePaise, 5000);
  assert.equal(second.personalPaidPaise, 30000);
  assert.equal(second.sharedPaidPaise, 0);
  assert.equal(second.netBalancePaise, -5000);
});

test('settlement suggestions match all debts to all credits without losing paise', () => {
  const balances = [
    { id: 1, name: 'One', netBalancePaise: -100000 },
    { id: 2, name: 'Two', netBalancePaise: -30000 },
    { id: 3, name: 'Three', netBalancePaise: 70000 },
    { id: 4, name: 'Four', netBalancePaise: 60000 },
    { id: 5, name: 'Five', netBalancePaise: 0 }
  ];
  const suggestions = service.suggestSettlements(balances);
  assert.equal(suggestions.reduce((sum, s) => sum + s.amountPaise, 0), 130000);
  assert.deepEqual(suggestions.map(s => [s.payerId, s.receiverId, s.amountPaise]), [[1, 3, 70000], [1, 4, 30000], [2, 4, 30000]]);
});

test('settlement suggestions minimize transfers when a balance grouping permits it', () => {
  const balances = [
    { id: 1, name: 'One', netBalancePaise: -400 },
    { id: 2, name: 'Two', netBalancePaise: -300 },
    { id: 3, name: 'Three', netBalancePaise: -300 },
    { id: 4, name: 'Four', netBalancePaise: 600 },
    { id: 5, name: 'Five', netBalancePaise: 400 }
  ];
  const suggestions = service.suggestSettlements(balances);
  assert.equal(suggestions.length, 3);
  assert.equal(suggestions.reduce((sum, s) => sum + s.amountPaise, 0), 1000);
  assert.deepEqual(suggestions.map(s => [s.payerId, s.receiverId]), [[1, 5], [2, 4], [3, 4]]);
});

test('pending expenses do not affect totals and only confirmed settlements change balances', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db, 1, { amountPaise: 10000 });
  assert.equal((await service.financeSnapshot(db)).approvedSharedPaise, 0);
  await approve(db, id);
  let snapshot = await service.financeSnapshot(db);
  assert.equal(snapshot.members[1].netBalancePaise, -5000);
  const settlementId = await service.createSettlement(db, 2, { receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07', note: 'UPI' });
  assert.equal((await service.financeSnapshot(db)).members[1].netBalancePaise, -5000);
  assert.equal((await db.prepare('SELECT status FROM settlements WHERE id=?').get(settlementId)).status, 'pending_confirmation');
  await service.confirmSettlement(db, 1, settlementId);
  snapshot = await service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 0);
  assert.equal(snapshot.members[1].netBalancePaise, 0);
});

test('receiver can mark a partial amount received immediately without an approval request', async t => {
  const db = fixture(); t.after(() => db.close());
  const expense = await submit(db, 1, { amountPaise: 10000 });
  await approve(db, expense);
  const settlementId = await service.recordReceivedSettlement(db, 1, {
    payerId: 2, amountPaise: 2500, paymentDate: '2026-11-07', note: 'Partial transfer'
  });
  const settlement = await db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  assert.equal(settlement.status, 'confirmed');
  assert.equal(settlement.amount_paise, 2500);
  assert.equal(settlement.confirmed_amount_paise, 2500);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE status='pending_confirmation'").get()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM expense_votes WHERE expense_id=?").get(expense)).n, 3);
  const snapshot = await service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 2500);
  assert.equal(snapshot.members[1].netBalancePaise, -2500);
});

test('receiver can confirm a custom partial amount while preserving the requested amount', async t => {
  const db = fixture(); t.after(() => db.close());
  const expense = await submit(db, 1, { amountPaise: 10000 });
  await approve(db, expense);
  const settlementId = await service.createSettlement(db, 2, {
    receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07'
  });
  const result = await service.confirmSettlement(db, 1, settlementId, 3000);
  const settlement = await db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  assert.equal(settlement.amount_paise, 5000);
  assert.equal(settlement.confirmed_amount_paise, 3000);
  assert.equal(result.confirmedAmountPaise, 3000);
  const snapshot = await service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 2000);
  assert.equal(snapshot.members[1].netBalancePaise, -2000);
});

test('a different member cannot confirm a settlement', async t => {
  const db = fixture(); t.after(() => db.close());
  const expense = await submit(db, 1);
  await approve(db, expense);
  const settlement = await service.createSettlement(db, 2, { receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07' });
  await assert.rejects(service.confirmSettlement(db, 3, settlement), /Only the receiver/);
});

test('approved ledger search filters descriptions and member names', async t => {
  const db = fixture(); t.after(() => db.close());
  const id = await submit(db, 1, { title: 'Internet router' });
  await approve(db, id);
  assert.equal((await service.listExpenses(db, { search: 'router' })).total, 1);
  assert.equal((await service.listExpenses(db, { search: 'Member 1' })).total, 1);
  assert.equal((await service.listExpenses(db, { search: 'not here' })).total, 0);
});

test('credential reset updates the configured five accounts without replacing their IDs', async t => {
  const db = fixture(); t.after(() => db.close());
  const members = Array.from({ length: 5 }, (_, index) => ({ username: `newmember${index + 1}`, password: `new-secure-password-${index + 1}`, displayName: `New Member ${index + 1}` }));
  await resetUsers(db, members);
  const users = await db.prepare('SELECT id,username,password_hash,display_name FROM users ORDER BY id').all();
  assert.deepEqual(users.map(user => user.id), [1, 2, 3, 4, 5]);
  assert.equal(users[0].username, 'newmember1');
  assert.equal(users[0].display_name, 'New Member 1');
  assert.equal(await bcrypt.compare(members[0].password, users[0].password_hash), true);
});

test('startup config sync updates existing display names without changing password hashes', async t => {
  const db = fixture(); t.after(() => db.close());
  const members = ['Rahidul', 'Bapan', 'Manojit', 'Hara', 'Wahid'].map((displayName, index) => ({
    username: `member${index + 1}`, password: 'unchanged-password', displayName
  }));
  await seedUsers(db, members);
  const rows = await db.prepare('SELECT username,password_hash,display_name FROM users ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.display_name), members.map(member => member.displayName));
  assert.deepEqual(rows.map(row => row.password_hash), Array(5).fill('test-hash'));
});

test('data reset waits for requester plus three other approvals, archives history, and keeps member accounts', async t => {
  const db = fixture(); t.after(() => db.close());
  const expenseId = await submit(db, 1, { amountPaise: 10000 });
  await approve(db, expenseId);
  const settlementId = await service.createSettlement(db, 2, { receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07', note: 'Original payment' });
  await service.confirmSettlement(db, 1, settlementId);

  const requestId = await service.createDataResetRequest(db, 5);
  assert.equal((await db.prepare('SELECT vote FROM data_reset_votes WHERE request_id=? AND user_id=5').get(requestId)).vote, 'approved');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE related_type=? AND related_id=?').get('data_reset', requestId)).n, 4);
  await assert.rejects(service.voteOnDataReset(db, 5, requestId, 'approved'), /already counted/);

  assert.equal((await service.voteOnDataReset(db, 1, requestId, 'approved')).status, 'pending');
  await assert.rejects(service.voteOnDataReset(db, 1, requestId, 'approved'), /already voted/);
  assert.equal((await service.voteOnDataReset(db, 2, requestId, 'approved')).status, 'pending');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).n, 1, 'the ledger remains until all required votes arrive');
  const completed = await service.voteOnDataReset(db, 3, requestId, 'approved');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.approvals, 4);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM expense_votes').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 5);

  const archive = await service.getDataResetArchive(db, completed.archiveId);
  assert.equal(archive.expenseCount, 1);
  assert.equal(archive.settlementCount, 1);
  assert.equal(archive.expenses[0].id, expenseId);
  assert.equal(archive.expenses[0].votes.length, 3);
  assert.equal(archive.settlements[0].id, settlementId);
  const state = await service.getDataResetState(db);
  assert.equal(state.pending, null);
  assert.equal(state.history[0].status, 'completed');
  assert.equal(state.history[0].archive_id, completed.archiveId);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title='Ledger reset completed'").get()).n, 5);
});

test('two reset rejections close the request without deleting or archiving ledger data', async t => {
  const db = fixture(); t.after(() => db.close());
  const expenseId = await submit(db);
  const requestId = await service.createDataResetRequest(db, 1);
  assert.equal((await service.voteOnDataReset(db, 2, requestId, 'rejected')).status, 'pending');
  const declined = await service.voteOnDataReset(db, 3, requestId, 'rejected');
  assert.equal(declined.status, 'rejected');
  assert.equal((await db.prepare('SELECT status FROM expenses WHERE id=?').get(expenseId)).status, 'pending');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM data_reset_archives').get()).n, 0);
  await assert.rejects(service.voteOnDataReset(db, 4, requestId, 'approved'), /no longer awaiting votes/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title='Reset request declined'").get()).n, 5);
});

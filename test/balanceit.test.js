const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
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

function approve(db, expenseId, voters = [2, 3, 4]) {
  let state;
  for (const userId of voters) state = service.voteOnExpense(db, userId, expenseId, 'approved');
  return state;
}

function submit(db, userId = 1, extra = {}) {
  return service.createExpense(db, userId, {
    title: 'House supplies', amountPaise: 10000, category: 'Groceries',
    expenseDate: '2026-11-07', expenseType: 'shared', participantIds: [1, 2], ...extra
  });
}

test('expense creation is pending and creates review notifications for the other four members', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db);
  assert.equal(db.prepare('SELECT status FROM expenses WHERE id=?').get(id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE related_id=?').get(id).n, 4);
  assert.deepEqual(db.prepare('SELECT share_paise FROM expense_participants WHERE expense_id=? ORDER BY user_id').all(id).map(r => r.share_paise), [5000, 5000]);
});

test('duplicate votes are blocked by the service and database unique constraint', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db);
  service.voteOnExpense(db, 2, id, 'approved');
  assert.throws(() => service.voteOnExpense(db, 2, id, 'approved'), /already voted/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_votes WHERE expense_id=?').get(id).n, 1);
});

test('three distinct approvals approve an expense', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db);
  assert.equal(service.voteOnExpense(db, 2, id, 'approved').status, 'pending');
  assert.equal(service.voteOnExpense(db, 3, id, 'approved').status, 'pending');
  assert.equal(service.voteOnExpense(db, 4, id, 'approved').status, 'approved');
});

test('two rejections reject an expense and preserve the reason', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db);
  service.voteOnExpense(db, 2, id, 'rejected', 'Please attach the receipt.');
  const result = service.voteOnExpense(db, 3, id, 'rejected', '');
  assert.equal(result.status, 'rejected');
  assert.equal(db.prepare('SELECT rejection_reason FROM expenses WHERE id=?').get(id).rejection_reason, 'Please attach the receipt.');
});

test('expense submitter cannot approve their own expense', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db);
  assert.throws(() => service.voteOnExpense(db, 1, id, 'approved'), /cannot vote/);
});

test('equal split and deterministic paise remainder preserve the full amount', () => {
  assert.deepEqual(allocateShares(50000, [1, 2, 3, 4, 5]).map(p => p.sharePaise), [10000, 10000, 10000, 10000, 10000]);
  const split = allocateShares(100, [3, 1, 2]);
  assert.deepEqual(split, [{ userId: 1, sharePaise: 34 }, { userId: 2, sharePaise: 33 }, { userId: 3, sharePaise: 33 }]);
  assert.equal(split.reduce((sum, p) => sum + p.sharePaise, 0), 100);
  assert.equal(parseRupeesToPaise('20.05'), 2005);
  assert.throws(() => parseRupeesToPaise('1.999'), /valid amount/);
});

test('individual spending totals and net balances use shared expenses only', t => {
  const db = fixture(); t.after(() => db.close());
  const shared = submit(db, 1, { amountPaise: 10000 });
  approve(db, shared);
  const personal = submit(db, 2, { title: 'Personal headphones', amountPaise: 30000, expenseType: 'personal', participantIds: [] });
  approve(db, personal, [1, 3, 4]);
  const snapshot = service.financeSnapshot(db);
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

test('pending expenses do not affect totals and only confirmed settlements change balances', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db, 1, { amountPaise: 10000 });
  assert.equal(service.financeSnapshot(db).approvedSharedPaise, 0);
  approve(db, id);
  let snapshot = service.financeSnapshot(db);
  assert.equal(snapshot.members[1].netBalancePaise, -5000);
  const settlementId = service.createSettlement(db, 2, { receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07', note: 'UPI' });
  assert.equal(service.financeSnapshot(db).members[1].netBalancePaise, -5000);
  assert.equal(db.prepare('SELECT status FROM settlements WHERE id=?').get(settlementId).status, 'pending_confirmation');
  service.confirmSettlement(db, 1, settlementId);
  snapshot = service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 0);
  assert.equal(snapshot.members[1].netBalancePaise, 0);
});

test('receiver can mark a partial amount received immediately without an approval request', t => {
  const db = fixture(); t.after(() => db.close());
  const expense = submit(db, 1, { amountPaise: 10000 });
  approve(db, expense);
  const settlementId = service.recordReceivedSettlement(db, 1, {
    payerId: 2, amountPaise: 2500, paymentDate: '2026-11-07', note: 'Partial transfer'
  });
  const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  assert.equal(settlement.status, 'confirmed');
  assert.equal(settlement.amount_paise, 2500);
  assert.equal(settlement.confirmed_amount_paise, 2500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE status='pending_confirmation'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM expense_votes WHERE expense_id=?").get(expense).n, 3);
  const snapshot = service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 2500);
  assert.equal(snapshot.members[1].netBalancePaise, -2500);
});

test('receiver can confirm a custom partial amount while preserving the requested amount', t => {
  const db = fixture(); t.after(() => db.close());
  const expense = submit(db, 1, { amountPaise: 10000 });
  approve(db, expense);
  const settlementId = service.createSettlement(db, 2, {
    receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07'
  });
  const result = service.confirmSettlement(db, 1, settlementId, 3000);
  const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  assert.equal(settlement.amount_paise, 5000);
  assert.equal(settlement.confirmed_amount_paise, 3000);
  assert.equal(result.confirmedAmountPaise, 3000);
  const snapshot = service.financeSnapshot(db);
  assert.equal(snapshot.members[0].netBalancePaise, 2000);
  assert.equal(snapshot.members[1].netBalancePaise, -2000);
});

test('a different member cannot confirm a settlement', t => {
  const db = fixture(); t.after(() => db.close());
  const expense = submit(db, 1);
  approve(db, expense);
  const settlement = service.createSettlement(db, 2, { receiverId: 1, amountPaise: 5000, paymentDate: '2026-11-07' });
  assert.throws(() => service.confirmSettlement(db, 3, settlement), /Only the receiver/);
});

test('approved ledger search filters descriptions and member names', t => {
  const db = fixture(); t.after(() => db.close());
  const id = submit(db, 1, { title: 'Internet router' });
  approve(db, id);
  assert.equal(service.listExpenses(db, { search: 'router' }).total, 1);
  assert.equal(service.listExpenses(db, { search: 'Member 1' }).total, 1);
  assert.equal(service.listExpenses(db, { search: 'not here' }).total, 0);
});

test('credential reset updates the configured five accounts without replacing their IDs', async t => {
  const db = fixture(); t.after(() => db.close());
  const members = Array.from({ length: 5 }, (_, index) => ({ username: `newmember${index + 1}`, password: `new-secure-password-${index + 1}`, displayName: `New Member ${index + 1}` }));
  await resetUsers(db, members);
  const users = db.prepare('SELECT id,username,password_hash,display_name FROM users ORDER BY id').all();
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
  const rows = db.prepare('SELECT username,password_hash,display_name FROM users ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.display_name), members.map(member => member.displayName));
  assert.deepEqual(rows.map(row => row.password_hash), Array(5).fill('test-hash'));
});

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
process.env.DATABASE_URL = '';
const bcrypt = require('bcryptjs');
const { app, db } = require('../src/server');

const insertUser = db.prepare('INSERT INTO users(username,password_hash,display_name) VALUES(?,?,?)');
for (let i = 1; i <= 5; i++) insertUser.run(`member${i}`, bcrypt.hashSync(`secure-test-password-${i}`, 4), `Member ${i}`);

test('session authentication protects private API and the voting flow works end to end', async t => {
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/dashboard`);
  assert.equal(response.status, 401);

  async function login(member) {
    const result = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `member${member}`, password: `secure-test-password-${member}` })
    });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie')?.match(/roomledger\.sid=[^;]+/)?.[0];
    assert.ok(cookie, 'login returns an HTTP-only session cookie');
    return cookie;
  }

  const member1 = await login(1);
  const dashboard = await fetch(`${base}/api/dashboard`, { headers: { cookie: member1 } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).members.length, 5);
  const publicMembers = await fetch(`${base}/api/members`, { headers: { cookie: member1 } });
  assert.equal(publicMembers.status, 200);
  assert.equal((await publicMembers.json())[0].displayName, 'Member 1');

  const unauthenticatedWrite = await fetch(`${base}/api/expenses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticatedWrite.status, 401);
  const origin = { origin: base, cookie: member1 };
  const foreignOrigin = await fetch(`${base}/api/expenses`, {
    method: 'POST', headers: { ...origin, origin: 'https://example.invalid', 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(foreignOrigin.status, 403);
  const created = await fetch(`${base}/api/expenses`, {
    method: 'POST', headers: { ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Milk and bread', amount: '101.05', expenseDate: '2026-11-07', category: 'Groceries', expenseType: 'shared', participantIds: [1, 2, 3] })
  });
  assert.equal(created.status, 201);
  const expenseId = (await created.json()).id;
  const ownVote = await fetch(`${base}/api/approvals/${expenseId}/vote`, { method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: JSON.stringify({ vote: 'approved' }) });
  assert.equal(ownVote.status, 403);

  for (const member of [2, 3, 4]) {
    const cookie = await login(member);
    const vote = await fetch(`${base}/api/approvals/${expenseId}/vote`, {
      method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ vote: 'approved' })
    });
    assert.equal(vote.status, 200);
  }
  const detail = await fetch(`${base}/api/expenses/${expenseId}`, { headers: { cookie: member1 } });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).status, 'approved');

  const received = await fetch(`${base}/api/settlements/received`, {
    method: 'POST', headers: { ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ payerId: 2, amount: '1.00', paymentDate: '2026-11-07' })
  });
  assert.equal(received.status, 201);
  const settlement = await received.json();
  assert.match(settlement.message, /Balances have been updated/);

  const resetResponse = await fetch(`${base}/api/data-resets`, {
    method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(resetResponse.status, 201);
  const resetId = (await resetResponse.json()).id;
  for (const member of [2, 3, 4]) {
    const cookie = await login(member);
    const vote = await fetch(`${base}/api/data-resets/${resetId}/vote`, {
      method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ vote: 'approved' })
    });
    assert.equal(vote.status, 200);
    if (member === 4) assert.equal((await vote.json()).status, 'completed');
  }
  const resetHistory = await fetch(`${base}/api/data-resets`, { headers: { cookie: member1 } });
  const resetHistoryData = await resetHistory.json();
  assert.equal(resetHistoryData.history[0].status, 'completed');
  const archiveId = resetHistoryData.history[0].archive_id;
  const archiveResponse = await fetch(`${base}/api/data-resets/archives/${archiveId}`, { headers: { cookie: member1 } });
  assert.equal(archiveResponse.status, 200);
  assert.equal((await archiveResponse.json()).expenses.length, 1);
});

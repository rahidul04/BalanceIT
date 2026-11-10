require('dotenv').config();
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const { openDatabase } = require('./db');
const { DatabaseSessionStore } = require('./session-store');
const { seedUsers } = require('./seed');
const { parseRupeesToPaise } = require('./money');
const service = require('./services');

const app = express();
const db = openDatabase(config);
if (config.nodeEnv === 'production') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } } }));
app.use(express.json({ limit: '30kb' }));
app.use(session({
  store: new DatabaseSessionStore(db),
  secret: config.sessionSecret,
  // Keep the established cookie name so current browser sessions survive the rename.
  name: 'roomledger.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in to continue.' });
const sameOrigin = (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Request origin was not accepted.' });
    } catch { return res.status(403).json({ error: 'Request origin was not accepted.' }); }
  }
  next();
};
const protectedApi = [requireAuth, sameOrigin];

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/auth/session', (req, res) => res.json({ authenticated: !!req.session.user, user: req.session.user || null }));
app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password || username.length > 32 || password.length > 200) return res.status(400).json({ error: 'Enter your username and password.' });
  const user = await db.prepare('SELECT id,username,password_hash,display_name FROM users WHERE username=? COLLATE NOCASE').get(username);
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!valid) return res.status(401).json({ error: 'That username and password do not match.' });
  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Could not start a secure session. Please try again.' });
    req.session.user = { id: user.id, username: user.username, displayName: user.display_name };
    req.session.save(saveError => saveError ? res.status(500).json({ error: 'Could not save your session. Please try again.' }) : res.json({ user: req.session.user }));
  });
}));
app.post('/api/auth/logout', ...protectedApi, (req, res) => req.session.destroy(error => {
  if (error) return res.status(500).json({ error: 'Could not log out. Please try again.' });
  res.clearCookie('roomledger.sid', { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production' });
  res.json({ ok: true });
}));

app.get('/api/dashboard', ...protectedApi, asyncRoute(async (req, res) => res.json(await service.getDashboard(db, req.session.user.id))));
app.get('/api/members', ...protectedApi, asyncRoute(async (req, res) => res.json(await db.prepare('SELECT id,username,display_name AS displayName FROM users ORDER BY id').all())));
app.get('/api/expenses', ...protectedApi, asyncRoute(async (req, res) => res.json(await service.listExpenses(db, req.query))));
app.get('/api/expenses/:id', ...protectedApi, asyncRoute(async (req, res) => {
  const expense = await service.expenseWithPayer(db, Number(req.params.id));
  if (!expense) return res.status(404).json({ error: 'Expense not found.' });
  res.json(expense);
}));
app.post('/api/expenses', ...protectedApi, asyncRoute(async (req, res) => {
  let amountPaise;
  try { amountPaise = parseRupeesToPaise(req.body.amount); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const id = await service.createExpense(db, req.session.user.id, { ...req.body, amountPaise });
  res.status(201).json({ id, message: 'Expense submitted. It is awaiting approval from the other members.' });
}));

app.get('/api/approvals', ...protectedApi, asyncRoute(async (req, res) => res.json(await service.getApprovals(db, req.session.user.id))));
app.post('/api/approvals/:id/vote', ...protectedApi, asyncRoute(async (req, res) => {
  const result = await service.voteOnExpense(db, req.session.user.id, Number(req.params.id), req.body.vote, req.body.reason);
  res.json(result);
}));

app.get('/api/settlements', ...protectedApi, asyncRoute(async (req, res) => res.json(await service.getSettlements(db))));
app.post('/api/settlements', ...protectedApi, asyncRoute(async (req, res) => {
  let amountPaise;
  try { amountPaise = parseRupeesToPaise(req.body.amount); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const id = await service.createSettlement(db, req.session.user.id, { ...req.body, amountPaise });
  res.status(201).json({ id, message: 'Payment recorded and sent to the receiver for confirmation.' });
}));
app.post('/api/settlements/received', ...protectedApi, asyncRoute(async (req, res) => {
  let amountPaise;
  try { amountPaise = parseRupeesToPaise(req.body.amount); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const id = await service.recordReceivedSettlement(db, req.session.user.id, { ...req.body, amountPaise });
  res.status(201).json({ id, message: 'Payment marked received. Balances have been updated.' });
}));
app.post('/api/settlements/:id/confirm', ...protectedApi, asyncRoute(async (req, res) => {
  let confirmedAmountPaise;
  if (req.body.amount !== undefined) {
    try { confirmedAmountPaise = parseRupeesToPaise(req.body.amount); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  }
  const result = await service.confirmSettlement(db, req.session.user.id, Number(req.params.id), confirmedAmountPaise);
  res.json({ ok: true, confirmedAmountPaise: result.confirmedAmountPaise, message: 'Payment confirmed and balances have been updated.' });
}));

app.get('/api/notifications', ...protectedApi, asyncRoute(async (req, res) => {
  const userId = req.session.user.id;
  res.json({ unread: (await db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0').get(userId)).count,
    notifications: await db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(userId) });
}));
app.patch('/api/notifications/read-all', ...protectedApi, asyncRoute(async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.user.id);
  res.json({ ok: true });
}));
app.patch('/api/notifications/:id/read', ...protectedApi, asyncRoute(async (req, res) => {
  const result = await db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(Number(req.params.id), req.session.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
}));

app.get('/api/data-resets', ...protectedApi, asyncRoute(async (req, res) => res.json(await service.getDataResetState(db))));
app.post('/api/data-resets', ...protectedApi, asyncRoute(async (req, res) => {
  const id = await service.createDataResetRequest(db, req.session.user.id);
  res.status(201).json({ id, message: 'Reset request created. Your approval counts; three other members must approve it.' });
}));
app.post('/api/data-resets/:id/vote', ...protectedApi, asyncRoute(async (req, res) => {
  res.json(await service.voteOnDataReset(db, req.session.user.id, Number(req.params.id), req.body.vote));
}));
app.get('/api/data-resets/archives/:id', ...protectedApi, asyncRoute(async (req, res) => {
  res.json(await service.getDataResetArchive(db, Number(req.params.id)));
}));

app.get('/api/reports', ...protectedApi, asyncRoute(async (req, res) => {
  const current = service.currentHouseholdMonth().split('-');
  res.json(await service.getReport(db, req.query.year || current[0], req.query.month || current[1]));
}));
app.get('/api/reports/export.csv', ...protectedApi, asyncRoute(async (req, res) => {
  const current = service.currentHouseholdMonth().split('-');
  const report = await service.getReport(db, req.query.year || current[0], req.query.month || current[1]);
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [['Date','Description','Category','Paid By','Amount INR','Type','Status'], ...report.expenses.map(e => [e.expense_date,e.title,e.category,e.paid_by_name,(e.amount_paise / 100).toFixed(2),e.expense_type,e.status]),
    [], ['Member','Total paid INR','Shared paid INR','Personal paid INR','Fair share INR','All-time net balance INR'],
    ...report.members.map(m => [m.name,(m.totalPaidPaise/100).toFixed(2),(m.sharedPaidPaise/100).toFixed(2),(m.personalPaidPaise/100).toFixed(2),(m.fairSharePaise/100).toFixed(2),(m.netBalancePaise/100).toFixed(2)])];
  res.type('text/csv').set('Content-Disposition', `attachment; filename="balanceit-${report.month}.csv"`).send(lines.map(row => row.map(cell).join(',')).join('\r\n'));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  maxAge: config.nodeEnv === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    // HTML and its entry-point assets should revalidate after each deploy so users don't keep stale UI.
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? (config.nodeEnv === 'production' ? 'Something went wrong. Please try again.' : error.message) : error.message });
});

async function start() {
  if (config.nodeEnv === 'production' && config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  if (process.env.RENDER === 'true' && config.nodeEnv === 'production' && !config.databaseUrl) throw new Error('Set DATABASE_URL to your Supabase PostgreSQL connection string. Render Free local files are temporary and cannot safely store the BalanceIT ledger.');
  await db.initialize?.();
  await seedUsers(db);
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`BalanceIT is listening on port ${config.port}`));
  const shutdown = () => server.close(async () => {
    try { await db.close(); } finally { process.exit(0); }
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { app, db, start };

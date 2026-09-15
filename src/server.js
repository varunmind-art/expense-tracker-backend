// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { google } = require('googleapis');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 5001;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Email Transporter (Gmail SMTP) ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

// --- JWT Auth Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// --- Default Categories (with type) ---
const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining',      icon: '🍔', color: '#FF6B6B', type: 'EXPENSE' },
  { name: 'Transport',           icon: '🚗', color: '#4ECDC4', type: 'EXPENSE' },
  { name: 'Shopping',            icon: '🛍️', color: '#45B7D1', type: 'EXPENSE' },
  { name: 'Bills & Utilities',   icon: '📄', color: '#96CEB4', type: 'EXPENSE' },
  { name: 'Entertainment',       icon: '🎬', color: '#FFEEAD', type: 'EXPENSE' },
  { name: 'Healthcare',          icon: '🏥', color: '#D4A5A5', type: 'EXPENSE' },
  { name: 'Education',           icon: '📚', color: '#9B59B6', type: 'EXPENSE' },
  { name: 'Rent',                icon: '🏠', color: '#E67E22', type: 'EXPENSE' },
  { name: 'Salary',              icon: '💰', color: '#2ECC71', type: 'EXPENSE' },
  { name: 'Other',               icon: '📌', color: '#95A5A6', type: 'EXPENSE' },
  // ⭐ Savings categories
  { name: 'Mutual Funds',        icon: '📈', color: '#2ECC71', type: 'SAVINGS' },
  { name: 'Emergency Fund',      icon: '🛟', color: '#E74C3C', type: 'SAVINGS' },
  { name: 'Stocks',              icon: '📊', color: '#3498DB', type: 'SAVINGS' },
];

// --- HELPER: Seed Categories for a new user ---
const seedCategories = async (userId) => {
  const data = DEFAULT_CATEGORIES.map((cat) => ({
    ...cat,
    isDefault: true,
    userId,
  }));
  await prisma.category.createMany({ data });
};

// --- HELPER: Get default category for a user (fallback: "Other") ---
const getUserDefaultCategory = async (userId) => {
  let category = await prisma.category.findFirst({
    where: { userId, name: 'Other' },
  });
  if (!category) {
    category = await prisma.category.findFirst({ where: { userId } });
  }
  if (!category) throw new Error('No category found for user.');
  return category;
};

// ==========================================
// 1. AUTH ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name },
    });

    await seedCategories(user.id);

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: user.id, email, name: user.name } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email, name: user.name } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'No user found with this email.' });

    const resetToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: `"Expense Tracker" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Reset Your Password',
      html: `<p>Hi ${user.name || 'there'},</p><p>Click <a href="${resetLink}">here</a> to reset your password. This link expires in 1 hour.</p>`,
    });

    res.json({ message: 'Password reset email sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send reset email.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: decoded.id },
      data: { password: hashed },
    });
    res.json({ message: 'Password updated successfully.' });
  } catch (error) {
    res.status(400).json({ error: 'Invalid or expired token.' });
  }
});

// ==========================================
// 2. EXPENSE ROUTES (Protected)
// ==========================================
app.get('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, categoryId, search, type } = req.query;
    const where = { userId: req.user.id };

    if (startDate) where.date = { ...where.date, gte: new Date(startDate) };
    if (endDate) where.date = { ...where.date, lte: new Date(endDate) };
    if (categoryId) where.categoryId = categoryId;
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { note: { contains: search, mode: 'insensitive' } },
        { category: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const expenses = await prisma.expense.findMany({
      where,
      include: { category: true },
      orderBy: { date: 'desc' },
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expenses.' });
  }
});

app.post('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const { amount, date, note, categoryId, receiptUrl, isRecurring, type } = req.body;
    const expense = await prisma.expense.create({
      data: {
        amount: parseFloat(amount),
        date: date ? new Date(date) : new Date(),
        note,
        receiptUrl,
        isRecurring: isRecurring || false,
        type: type === 'SAVINGS' ? 'SAVINGS' : 'EXPENSE',
        userId: req.user.id,
        categoryId,
      },
      include: { category: true },
    });
    res.status(201).json(expense);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create expense.' });
  }
});

app.put('/api/expenses/:id', authenticateToken, async (req, res) => {
  try {
    const { amount, date, note, categoryId, receiptUrl, type } = req.body;
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId: req.user.id },
      data: {
        amount: parseFloat(amount),
        date: new Date(date),
        note,
        categoryId,
        receiptUrl,
        ...(type && { type }),
      },
      include: { category: true },
    });
    res.json(expense);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update expense.' });
  }
});

app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.expense.delete({
      where: { id: req.params.id, userId: req.user.id },
    });
    res.json({ message: 'Expense deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete expense.' });
  }
});

// Export CSV
app.get('/api/export/csv', authenticateToken, async (req, res) => {
  try {
    const expenses = await prisma.expense.findMany({
      where: { userId: req.user.id },
      include: { category: true },
      orderBy: { date: 'desc' },
    });

    let csv = 'Date,Type,Category,Amount,Note,Receipt\n';
    expenses.forEach((e) => {
      csv += `${e.date.toISOString().split('T')[0]},${e.type || 'EXPENSE'},${e.category.name},${e.amount},${e.note || ''},${e.receiptUrl || ''}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('expenses_export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ==========================================
// 3. INCOME ROUTES
// ==========================================
app.get('/api/incomes', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, month } = req.query;
    const where = { userId: req.user.id };

    if (month) {
      const [y, m] = month.split('-').map(Number);
      where.date = { gte: new Date(y, m - 1, 1), lte: new Date(y, m, 0, 23, 59, 59) };
    } else {
      if (startDate) where.date = { ...where.date, gte: new Date(startDate) };
      if (endDate) where.date = { ...where.date, lte: new Date(endDate) };
    }

    const incomes = await prisma.income.findMany({ where, orderBy: { date: 'desc' } });
    res.json(incomes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch incomes.' });
  }
});

app.post('/api/incomes', authenticateToken, async (req, res) => {
  try {
    const { amount, date, note, source } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }
    const income = await prisma.income.create({
      data: {
        amount: parseFloat(amount),
        date: date ? new Date(date) : new Date(),
        note,
        source: source || 'SALARY',
        userId: req.user.id,
      },
    });
    res.status(201).json(income);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create income.' });
  }
});

app.delete('/api/incomes/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.income.delete({ where: { id: req.params.id, userId: req.user.id } });
    res.json({ message: 'Income deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete income.' });
  }
});

// ==========================================
// 4. DASHBOARD SUMMARY
// ==========================================
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const { month } = req.query;
    let startDate, endDate;
    if (month) {
      const [y, m] = month.split('-').map(Number);
      startDate = new Date(y, m - 1, 1);
      endDate = new Date(y, m, 0, 23, 59, 59);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    }

    const [incomes, expenseRows, savingsRows] = await Promise.all([
      prisma.income.findMany({ where: { userId: req.user.id, date: { gte: startDate, lte: endDate } } }),
      prisma.expense.findMany({
        where: { userId: req.user.id, type: 'EXPENSE', date: { gte: startDate, lte: endDate } },
        include: { category: true },
      }),
      prisma.expense.findMany({
        where: { userId: req.user.id, type: 'SAVINGS', date: { gte: startDate, lte: endDate } },
        include: { category: true },
      }),
    ]);

    const sumOf = (arr) => arr.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const totalIncome = sumOf(incomes);
    const spent = sumOf(expenseRows);
    const saved = sumOf(savingsRows);
    const unspent = totalIncome - spent - saved;
    const savingsRate = totalIncome > 0 ? (saved / totalIncome) * 100 : 0;

    const breakdown = {};
    savingsRows.forEach((r) => {
      const name = r.category?.name || 'Uncategorized';
      breakdown[name] = (breakdown[name] || 0) + parseFloat(r.amount || 0);
    });

    const expenseBreakdown = {};
    expenseRows.forEach((r) => {
      const name = r.category?.name || 'Uncategorized';
      expenseBreakdown[name] = (expenseBreakdown[name] || 0) + parseFloat(r.amount || 0);
    });

    res.json({
      month: startDate.toISOString().slice(0, 7),
      income: totalIncome,
      spent,
      saved,
      unspent,
      savingsRate: Number(savingsRate.toFixed(2)),
      savingsByCategory: Object.entries(breakdown).map(([name, amount]) => ({ name, amount })),
      expensesByCategory: Object.entries(expenseBreakdown).map(([name, amount]) => ({ name, amount })),
      counts: {
        income: incomes.length,
        expenses: expenseRows.length,
        savings: savingsRows.length,
      },
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary.' });
  }
});

// ==========================================
// 5. CATEGORY ROUTES
// ==========================================
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { userId: req.user.id },
      orderBy: { name: 'asc' },
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
  try {
    const { name, icon, color, type } = req.body;
    const category = await prisma.category.create({
      data: {
        name,
        icon,
        color,
        type: type === 'SAVINGS' ? 'SAVINGS' : 'EXPENSE',
        userId: req.user.id,
        isDefault: false,
      },
    });
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Category name already exists.' });
    res.status(500).json({ error: 'Failed to create category.' });
  }
});

// ⭐ One-time seed of savings categories for existing users
app.post('/api/seed-savings-categories', authenticateToken, async (req, res) => {
  try {
    const savingsDefaults = [
      { name: 'Mutual Funds',   icon: '📈', color: '#2ECC71', type: 'SAVINGS' },
      { name: 'Emergency Fund', icon: '🛟', color: '#E74C3C', type: 'SAVINGS' },
      { name: 'Stocks',         icon: '📊', color: '#3498DB', type: 'SAVINGS' },
    ];

    const created = [];
    const skipped = [];

    for (const cat of savingsDefaults) {
      const existing = await prisma.category.findFirst({
        where: { userId: req.user.id, name: cat.name },
      });
      if (existing) {
        // If it already exists but is EXPENSE, upgrade it to SAVINGS
        if (existing.type !== 'SAVINGS') {
          await prisma.category.update({
            where: { id: existing.id },
            data: { type: 'SAVINGS' },
          });
          skipped.push(`${cat.name} (upgraded to SAVINGS)`);
        } else {
          skipped.push(`${cat.name} (already exists)`);
        }
        continue;
      }
      const c = await prisma.category.create({
        data: { ...cat, userId: req.user.id, isDefault: true },
      });
      created.push(c.name);
    }

    res.json({ message: 'Seed complete', created, skipped });
  } catch (error) {
    console.error('Seed error:', error);
    res.status(500).json({ error: 'Failed to seed savings categories.' });
  }
});

app.put('/api/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { name, icon, color, type } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required.' });
    const category = await prisma.category.update({
      where: { id: req.params.id, userId: req.user.id },
      data: {
        name: name.trim(),
        icon,
        color,
        ...(type && { type: type === 'SAVINGS' ? 'SAVINGS' : 'EXPENSE' }),
      },
    });
    res.json(category);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A category with this name already exists.' });
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category.' });
  }
});

app.delete('/api/categories/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.category.delete({
      where: { id: req.params.id, userId: req.user.id, isDefault: false },
    });
    res.json({ message: 'Category deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete category.' });
  }
});

// ==========================================
// 6. BUDGET ROUTES
// ==========================================
app.get('/api/budgets', authenticateToken, async (req, res) => {
  try {
    const budgets = await prisma.budget.findMany({
      where: { userId: req.user.id },
      include: { category: true },
    });
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch budgets.' });
  }
});

app.post('/api/budgets', authenticateToken, async (req, res) => {
  try {
    const { amount, period, startDate, categoryId } = req.body;
    const budget = await prisma.budget.create({
      data: {
        amount: parseFloat(amount),
        period,
        startDate: startDate ? new Date(startDate) : new Date(),
        userId: req.user.id,
        categoryId,
      },
      include: { category: true },
    });
    res.status(201).json(budget);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Budget for this category and period already exists.' });
    res.status(500).json({ error: 'Failed to set budget.' });
  }
});

// Update an existing budget
app.put('/api/budgets/:id', authenticateToken, async (req, res) => {
  try {
    const { amount, period, categoryId, startDate } = req.body;

    // Make sure the budget belongs to this user
    const existing = await prisma.budget.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Budget not found.' });
    }

    const updated = await prisma.budget.update({
      where: { id: req.params.id },
      data: {
        amount: parseFloat(amount),
        ...(period && { period }),
        ...(categoryId && { categoryId }),
        ...(startDate && { startDate: new Date(startDate) }),
      },
      include: { category: true },
    });
    res.json(updated);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'A budget for this category and period already exists.' });
    }
    console.error('Update budget error:', error);
    res.status(500).json({ error: 'Failed to update budget.' });
  }
});

app.delete('/api/budgets/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.budget.delete({
      where: { id: req.params.id, userId: req.user.id },
    });
    res.json({ message: 'Budget deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete budget.' });
  }
});

// ==========================================
// 7. RECURRING EXPENSES CRON JOB
// ==========================================
const processRecurringExpenses = async () => {
  console.log('🔄 Running recurring expense job...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rules = await prisma.recurringRule.findMany({
    where: { isActive: true, nextExecution: { lte: today } },
    include: { user: true, category: true },
  });

  for (const rule of rules) {
    try {
      await prisma.expense.create({
        data: {
          amount: rule.amount,
          date: today,
          note: `${rule.description} (Auto - Recurring)`,
          isRecurring: true,
          userId: rule.userId,
          categoryId: rule.categoryId,
        },
      });

      let nextExec = new Date(today);
      if (rule.frequency === 'DAILY') nextExec.setDate(today.getDate() + 1);
      else if (rule.frequency === 'WEEKLY') nextExec.setDate(today.getDate() + 7);
      else if (rule.frequency === 'MONTHLY') {
        nextExec.setMonth(today.getMonth() + 1);
        if (rule.dayOfMonth) {
          nextExec.setDate(rule.dayOfMonth);
          if (nextExec.getDate() !== rule.dayOfMonth) nextExec.setDate(0);
        }
      } else if (rule.frequency === 'YEARLY') {
        nextExec.setFullYear(today.getFullYear() + 1);
      }

      await prisma.recurringRule.update({
        where: { id: rule.id },
        data: { nextExecution: nextExec },
      });

      console.log(`✅ Auto-created expense for "${rule.description}"`);
    } catch (error) {
      console.error(`❌ Failed to process recurring rule ${rule.id}:`, error);
    }
  }
};

cron.schedule('30 18 * * *', processRecurringExpenses);
setTimeout(processRecurringExpenses, 10000);

// ==========================================
// 8. GMAIL INTEGRATION
// ==========================================
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const parseYesBankEmail = (subject, body) => {
  const result = { amount: null, merchant: null };
  let amountMatch = body.match(/(?:INR|₹)\s*([\d,]+(?:\.\d{2})?)/i);
  if (!amountMatch) amountMatch = body.match(/([\d,]+\.\d{2})\s*(?:has been spent|spent on)/i);
  if (!amountMatch) amountMatch = subject.match(/(?:INR|₹)?\s*([\d,]+(?:\.\d{2})?)/i);
  if (amountMatch) result.amount = parseFloat(amountMatch[1].replace(/,/g, ''));

  let merchantMatch = body.match(/at\s+([A-Za-z0-9\s\.\-_]+?)(?:\s+on\s+|\s+for\s+|\s*$)/i);
  if (!merchantMatch) merchantMatch = body.match(/at\s+([^\n,]+)/i);
  if (!merchantMatch) merchantMatch = subject.match(/at\s+([A-Za-z0-9\s\.\-_]+)/i);
  if (merchantMatch) result.merchant = merchantMatch[1].trim();
  return result;
};

const processGmailReceipts = async (userId) => {
  console.log(`📧 Processing Gmail receipts for user ${userId}`);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return console.log(`❌ User ${userId} not found`);
  if (!user.gmailRefreshToken) return console.log(`❌ No Gmail refresh token for user ${userId}`);

  oauth2Client.setCredentials({ refresh_token: user.gmailRefreshToken });
  try {
    await oauth2Client.refreshAccessToken();
    console.log('✅ Access token refreshed successfully');
  } catch (error) {
    return console.error('❌ Failed to refresh access token:', error.message);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const query = `from:(amazon.in OR amazonpay.in OR swiggy.in OR zomato.com OR uber.com OR flipkart.com OR yesbank.in OR "syes.bank.in" OR "yes.bank.in" OR "yesbank" OR icici.bank.in) after:${Math.floor(sevenDaysAgo.getTime() / 1000)}`;

  let messages = [];
  try {
    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
    messages = res.data.messages || [];
    console.log(`📬 Found ${messages.length} matching emails`);
  } catch (error) {
    console.error('❌ Gmail API list error:', error.message);
    throw error;
  }

  if (messages.length === 0) return;

  let defaultCategory;
  try {
    defaultCategory = await getUserDefaultCategory(userId);
  } catch (error) {
    return console.error('❌ Failed to get default category:', error.message);
  }

  let importedCount = 0;
  for (const msg of messages) {
    try {
      const msgData = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const payload = msgData.data.payload;
      let subject = '';
      let body = '';
      const headers = payload.headers;
      headers.forEach((h) => { if (h.name === 'Subject') subject = h.value; });

      if (payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain') {
            body = Buffer.from(part.body.data, 'base64').toString('utf8');
            break;
          }
        }
      } else if (payload.body && payload.body.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf8');
      }
      if (!body && payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/html') {
            body = Buffer.from(part.body.data, 'base64').toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            break;
          }
        }
      }

      const sender = headers.find((h) => h.name === 'From')?.value || '';

      if (sender.includes('YES BANK') || sender.includes('yesbank') || sender.includes('syes.bank.in')) {
        const parsed = parseYesBankEmail(subject, body);
        if (parsed.amount && parsed.merchant) {
          const existing = await prisma.pendingImport.findFirst({
            where: { userId, sourceId: msg.id, source: 'GMAIL_YESBANK' },
          });
          if (!existing) {
            await prisma.pendingImport.create({
              data: {
                userId,
                amount: parsed.amount,
                date: new Date(parseInt(msgData.data.internalDate)),
                merchant: parsed.merchant,
                note: subject,
                source: 'GMAIL_YESBANK',
                sourceId: msg.id,
                status: 'pending',
              },
            });
            console.log(`📥 Added pending import: ₹${parsed.amount} from ${parsed.merchant}`);
          }
        }
        continue;
      }

      let amountMatch = body.match(/(?:Rs|₹|INR)\s*([\d,]+(?:\.\d{2})?)/i);
      if (!amountMatch) amountMatch = body.match(/([\d,]+\.\d{2})\s*(?:was paid|paid|spent)/i);
      if (!amountMatch) amountMatch = subject.match(/(?:Rs|₹|INR)\s*([\d,]+(?:\.\d{2})?)/i);
      if (!amountMatch) continue;

      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      const subjectLower = subject.toLowerCase();
      const bodyLower = body.toLowerCase();
      const skipKeywords = ['cashback', 'refund', 'delivery', 'order has been received', 'delivered', 'received'];
      if (skipKeywords.some((kw) => subjectLower.includes(kw) || bodyLower.includes(kw))) {
        console.log(`⏭️ Skipping non-expense email: ${subject}`);
        continue;
      }

      const existing = await prisma.expense.findFirst({
        where: { userId, amount, note: { contains: subject }, date: { gte: sevenDaysAgo } },
      });
      if (existing) continue;

      await prisma.expense.create({
        data: {
          amount,
          date: new Date(parseInt(msgData.data.internalDate)),
          note: `Auto-import: ${subject}`,
          isRecurring: false,
          type: 'EXPENSE',
          userId,
          categoryId: defaultCategory.id,
        },
      });
      importedCount++;
      console.log(`✅ Auto-imported: ₹${amount} — ${subject}`);
    } catch (error) {
      console.error(`❌ Error processing email ${msg.id}:`, error.message);
    }
  }
  console.log(`📊 Imported ${importedCount} new expenses.`);
};

app.get('/api/auth/gmail', authenticateToken, (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
    state: req.user.id,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
  });
  res.json({ authUrl });
});

app.get('/api/auth/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or user ID');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    await prisma.user.update({
      where: { id: state },
      data: { gmailRefreshToken: tokens.refresh_token },
    });
    res.send('Gmail connected successfully! You can close this tab.');
  } catch (error) {
    console.error('Gmail OAuth error:', error);
    res.status(500).send('Failed to connect Gmail.');
  }
});

app.get('/api/auth/gmail/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { gmailRefreshToken: true },
    });
    res.json({ connected: !!user?.gmailRefreshToken });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check Gmail status' });
  }
});

app.post('/api/gmail/sync', authenticateToken, async (req, res) => {
  try {
    await processGmailReceipts(req.user.id);
    res.json({ message: 'Gmail sync completed successfully! Check your expenses.' });
  } catch (error) {
    console.error('Manual sync error:', error);
    res.status(500).json({ error: 'Sync failed. Check logs for details.' });
  }
});

// ==========================================
// 9. PENDING IMPORTS ROUTES
// ==========================================
app.get('/api/pending', authenticateToken, async (req, res) => {
  try {
    const pending = await prisma.pendingImport.findMany({
      where: { userId: req.user.id, status: 'pending' },
      orderBy: { date: 'desc' },
      include: { category: true },
    });
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending imports.' });
  }
});

app.put('/api/pending/:id', authenticateToken, async (req, res) => {
  const { amount, merchant, date, note, categoryId } = req.body;
  try {
    const pending = await prisma.pendingImport.update({
      where: { id: req.params.id, userId: req.user.id },
      data: {
        amount: parseFloat(amount),
        merchant,
        date: new Date(date),
        note,
        categoryId: categoryId || null,
      },
      include: { category: true },
    });
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update pending import.' });
  }
});

app.delete('/api/pending/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.pendingImport.delete({
      where: { id: req.params.id, userId: req.user.id },
    });
    res.json({ message: 'Pending import deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete pending import.' });
  }
});

app.post('/api/pending/:id/confirm', authenticateToken, async (req, res) => {
  const { categoryId } = req.body;
  try {
    const pending = await prisma.pendingImport.findFirst({
      where: { id: req.params.id, userId: req.user.id, status: 'pending' },
    });
    if (!pending) return res.status(404).json({ error: 'Pending import not found.' });

    let finalCategoryId = categoryId || pending.categoryId;
    if (!finalCategoryId) {
      const fallback = await getUserDefaultCategory(req.user.id);
      finalCategoryId = fallback.id;
    }

    const expense = await prisma.expense.create({
      data: {
        amount: pending.amount,
        date: pending.date,
        note: pending.note || pending.merchant,
        categoryId: finalCategoryId,
        userId: req.user.id,
        isRecurring: false,
        type: 'EXPENSE',
      },
    });

    await prisma.pendingImport.update({
      where: { id: pending.id },
      data: { status: 'confirmed' },
    });
    res.json({ message: 'Expense created from pending import.', expense });
  } catch (error) {
    console.error('Confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm pending import.' });
  }
});

// ==========================================
// 10. KEEP-ALIVE PING
// ==========================================
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// 11. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Email configured for: ${process.env.EMAIL_USER}`);
  console.log(`Recurring expense job scheduled for 00:05 IST daily.`);
});
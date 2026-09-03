// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { google } = require('googleapis'); // Added for Gmail

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

// --- Default Categories Seeder ---
const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', icon: '🍔', color: '#FF6B6B' },
  { name: 'Transport', icon: '🚗', color: '#4ECDC4' },
  { name: 'Shopping', icon: '🛍️', color: '#45B7D1' },
  { name: 'Bills & Utilities', icon: '📄', color: '#96CEB4' },
  { name: 'Entertainment', icon: '🎬', color: '#FFEEAD' },
  { name: 'Healthcare', icon: '🏥', color: '#D4A5A5' },
  { name: 'Education', icon: '📚', color: '#9B59B6' },
  { name: 'Rent', icon: '🏠', color: '#E67E22' },
  { name: 'Salary', icon: '💰', color: '#2ECC71' },
  { name: 'Other', icon: '📌', color: '#95A5A6' },
];

// --- HELPER: Seed Categories for a new user ---
const seedCategories = async (userId) => {
  const data = DEFAULT_CATEGORIES.map(cat => ({
    ...cat,
    isDefault: true,
    userId: userId,
  }));
  await prisma.category.createMany({ data });
};

// ==========================================
// 1. AUTH ROUTES
// ==========================================

// Register
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

// Login
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

// Forgot Password
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

// Reset Password
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
    const { startDate, endDate, categoryId, search } = req.query;
    const where = { userId: req.user.id };
    
    if (startDate) where.date = { ...where.date, gte: new Date(startDate) };
    if (endDate) where.date = { ...where.date, lte: new Date(endDate) };
    if (categoryId) where.categoryId = categoryId;
    if (search) {
      where.OR = [
        { note: { contains: search, mode: 'insensitive' } },
        { category: { name: { contains: search, mode: 'insensitive' } } }
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
    const { amount, date, note, categoryId, receiptUrl, isRecurring } = req.body;
    const expense = await prisma.expense.create({
      data: {
        amount: parseFloat(amount),
        date: date ? new Date(date) : new Date(),
        note,
        receiptUrl,
        isRecurring: isRecurring || false,
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
    const { amount, date, note, categoryId, receiptUrl } = req.body;
    const expense = await prisma.expense.update({
      where: { id: req.params.id, userId: req.user.id },
      data: { amount: parseFloat(amount), date: new Date(date), note, categoryId, receiptUrl },
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
    
    let csv = 'Date,Category,Amount,Note,Receipt\n';
    expenses.forEach(e => {
      csv += `${e.date.toISOString().split('T')[0]},${e.category.name},${e.amount},${e.note || ''},${e.receiptUrl || ''}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('expenses_export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ==========================================
// 3. CATEGORY ROUTES
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
    const { name, icon, color } = req.body;
    const category = await prisma.category.create({
      data: { name, icon, color, userId: req.user.id, isDefault: false },
    });
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Category name already exists.' });
    res.status(500).json({ error: 'Failed to create category.' });
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
// 4. BUDGET ROUTES
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
// 5. RECURRING EXPENSES CRON JOB
// ==========================================
const processRecurringExpenses = async () => {
  console.log('🔄 Running recurring expense job...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rules = await prisma.recurringRule.findMany({
    where: {
      isActive: true,
      nextExecution: { lte: today },
    },
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
      if (rule.frequency === 'DAILY') {
        nextExec.setDate(today.getDate() + 1);
      } else if (rule.frequency === 'WEEKLY') {
        nextExec.setDate(today.getDate() + 7);
      } else if (rule.frequency === 'MONTHLY') {
        nextExec.setMonth(today.getMonth() + 1);
        if (rule.dayOfMonth) {
          nextExec.setDate(rule.dayOfMonth);
          if (nextExec.getDate() !== rule.dayOfMonth) {
            nextExec.setDate(0);
          }
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
// 6. GMAIL INTEGRATION
// ==========================================

// OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Initiate Gmail OAuth
app.get('/api/auth/gmail', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
    state: userId,
  });
  res.json({ authUrl });
});

// Gmail OAuth callback
app.get('/api/auth/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or user ID');
  }
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

// Check Gmail connection status (NEW)
app.get('/api/auth/gmail/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { gmailRefreshToken: true }
    });
    res.json({ connected: !!user?.gmailRefreshToken });
  } catch (error) {
    console.error('Gmail status error:', error);
    res.status(500).json({ error: 'Failed to check Gmail status' });
  }
});

// ==========================================
// 6. KEEP-ALIVE PING ENDPOINT
// ==========================================
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// 7. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Email configured for: ${process.env.EMAIL_USER}`);
  console.log(`Recurring expense job scheduled for 00:05 IST daily.`);
});
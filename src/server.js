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

// ==========================================
// Helper: Parse YES BANK emails
// ==========================================
const parseYesBankEmail = (subject, body) => {
  const result = { amount: null, merchant: null };
  // Extract amount – look for ₹ symbol
  const amountMatch = body.match(/₹\s*([\d,]+(?:\.\d{2})?)/);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  }
  // Extract merchant – look for "at" or "at " followed by text
  const merchantMatch = body.match(/at\s+([A-Za-z0-9\s\.\-]+)/i);
  if (merchantMatch) {
    result.merchant = merchantMatch[1].trim();
  }
  // If not found in body, try subject
  if (!result.merchant) {
    const subjectMatch = subject.match(/at\s+([A-Za-z0-9\s\.\-]+)/i);
    if (subjectMatch) result.merchant = subjectMatch[1].trim();
  }
  return result;
};

// ==========================================
// processGmailReceipts – now creates pending imports for YES BANK
// ==========================================
const processGmailReceipts = async (userId) => {
  console.log(`📧 Processing Gmail receipts for user ${userId}`);
  
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.log(`❌ User ${userId} not found`);
    return;
  }
  
  if (!user.gmailRefreshToken) {
    console.log(`❌ No Gmail refresh token for user ${userId}`);
    return;
  }

  console.log('🔑 Refresh token exists, setting credentials...');
  oauth2Client.setCredentials({ refresh_token: user.gmailRefreshToken });
  
  try {
    console.log('🔄 Refreshing access token...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    console.log('✅ Access token refreshed successfully');
  } catch (error) {
    console.error('❌ Failed to refresh access token:', error.message);
    return;
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Search for recent emails (last 7 days) – include YES BANK
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  const query = `from:(amazon.in OR swiggy.in OR zomato.com OR uber.com OR flipkart.com OR yesbank.in) after:${Math.floor(sevenDaysAgo.getTime() / 1000)}`;

  console.log(`🔍 Searching emails with query: "${query}"`);
  
  let messages = [];
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50,
    });
    messages = res.data.messages || [];
    console.log(`📬 Found ${messages.length} matching emails`);
  } catch (error) {
    console.error('❌ Gmail API list error:', error.message);
    throw error;
  }

  if (messages.length === 0) {
    console.log('ℹ️ No matching emails found in the last 7 days');
    return;
  }

  let importedCount = 0;
  for (const msg of messages) {
    try {
      console.log(`📩 Fetching email ${msg.id}...`);
      const msgData = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      const payload = msgData.data.payload;
      let subject = '';
      let body = '';
      const headers = payload.headers;
      for (const header of headers) {
        if (header.name === 'Subject') subject = header.value;
      }
      // Get plain text body
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

      const sender = headers.find(h => h.name === 'From')?.value || '';

      // --- Check if it's a YES BANK alert ---
      if (sender.includes('YES BANK') || sender.includes('yesbank')) {
        const parsed = parseYesBankEmail(subject, body);
        if (parsed.amount && parsed.merchant) {
          // Check for duplicate
          const existing = await prisma.pendingImport.findFirst({
            where: {
              userId,
              sourceId: msg.id,
              source: 'GMAIL_YESBANK',
            },
          });
          if (existing) {
            console.log(`⏭️ Duplicate pending import for email ${msg.id}`);
            continue;
          }
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
          continue; // skip regular expense creation
        }
      }

      // --- For other senders (Amazon, Swiggy, etc.) – create expense directly ---
      // Extract amount
      const amountMatch = body.match(/₹\s*([\d,]+(?:\.\d{2})?)/);
      if (!amountMatch) {
        console.log(`⏭️ No amount found in email ${msg.id}`);
        continue;
      }
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      console.log(`💰 Found amount: ₹${amount}`);

      // Determine merchant
      let merchant = 'Unknown';
      if (sender.includes('amazon')) merchant = 'Amazon';
      else if (sender.includes('swiggy')) merchant = 'Swiggy';
      else if (sender.includes('zomato')) merchant = 'Zomato';
      else if (sender.includes('uber')) merchant = 'Uber';
      else if (sender.includes('flipkart')) merchant = 'Flipkart';

      // Prevent duplicates
      const existing = await prisma.expense.findFirst({
        where: {
          userId,
          amount,
          note: { contains: subject },
          date: { gte: sevenDaysAgo },
        },
      });
      if (existing) {
        console.log(`⏭️ Duplicate expense found for email ${msg.id}, skipping.`);
        continue;
      }

      // Create expense
      await prisma.expense.create({
        data: {
          amount,
          date: new Date(parseInt(msgData.data.internalDate)),
          note: `Auto-import: ${subject}`,
          isRecurring: false,
          userId,
          categoryId: null,
        },
      });
      importedCount++;
      console.log(`✅ Auto-imported expense for user ${userId}: ₹${amount} from ${merchant}`);
    } catch (error) {
      console.error(`❌ Error processing email ${msg.id}:`, error.message);
    }
  }
  console.log(`📊 Imported ${importedCount} new expenses.`);
};

// ==========================================
// Gmail OAuth routes
// ==========================================
app.get('/api/auth/gmail', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  console.log('🔍 GOOGLE_REDIRECT_URI:', redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
    state: userId,
    redirect_uri: redirectUri,
  });
  res.json({ authUrl });
});

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
// Manual sync endpoint
// ==========================================
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
// PENDING IMPORTS ROUTES
// ==========================================

// Get all pending imports for the user
app.get('/api/pending', authenticateToken, async (req, res) => {
  try {
    const pending = await prisma.pendingImport.findMany({
      where: { userId: req.user.id, status: 'pending' },
      orderBy: { date: 'desc' },
      include: { category: true },
    });
    res.json(pending);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch pending imports.' });
  }
});

// Update a pending import (edit amount, merchant, date, note, category)
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
    console.error(error);
    res.status(500).json({ error: 'Failed to update pending import.' });
  }
});

// Delete (reject) a pending import
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

// Confirm a pending import → create an expense
app.post('/api/pending/:id/confirm', authenticateToken, async (req, res) => {
  const { categoryId } = req.body;
  try {
    const pending = await prisma.pendingImport.findFirst({
      where: { id: req.params.id, userId: req.user.id, status: 'pending' },
    });
    if (!pending) {
      return res.status(404).json({ error: 'Pending import not found or already processed.' });
    }
    // Create expense
    const expense = await prisma.expense.create({
      data: {
        amount: pending.amount,
        date: pending.date,
        note: pending.note || pending.merchant,
        categoryId: categoryId || pending.categoryId,
        userId: req.user.id,
        isRecurring: false,
      },
    });
    // Update pending status to confirmed
    await prisma.pendingImport.update({
      where: { id: pending.id },
      data: { status: 'confirmed' },
    });
    res.json({ message: 'Expense created from pending import.', expense });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to confirm pending import.' });
  }
});

// ==========================================
// 7. KEEP-ALIVE PING ENDPOINT
// ==========================================
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// 8. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Email configured for: ${process.env.EMAIL_USER}`);
  console.log(`Recurring expense job scheduled for 00:05 IST daily.`);
});
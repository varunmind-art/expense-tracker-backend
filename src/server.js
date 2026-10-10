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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Access denied. No token provided.',
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({
        error: 'Invalid or expired token.',
      });
    }

    req.user = user;
    next();
  });
};

// ==========================================
// HELPERS
// ==========================================

const DEFAULT_CATEGORIES = [
  {
    name: 'Food & Dining',
    icon: '🍔',
    color: '#FF6B6B',
    type: 'EXPENSE',
  },
  {
    name: 'Transport',
    icon: '🚗',
    color: '#4ECDC4',
    type: 'EXPENSE',
  },
  {
    name: 'Shopping',
    icon: '🛍️',
    color: '#45B7D1',
    type: 'EXPENSE',
  },
  {
    name: 'Bills & Utilities',
    icon: '📄',
    color: '#96CEB4',
    type: 'EXPENSE',
  },
  {
    name: 'Entertainment',
    icon: '🎬',
    color: '#FFEEAD',
    type: 'EXPENSE',
  },
  {
    name: 'Healthcare',
    icon: '🏥',
    color: '#D4A5A5',
    type: 'EXPENSE',
  },
  {
    name: 'Education',
    icon: '📚',
    color: '#9B59B6',
    type: 'EXPENSE',
  },
  {
    name: 'Rent',
    icon: '🏠',
    color: '#E67E22',
    type: 'EXPENSE',
  },
  {
    name: 'Salary',
    icon: '💰',
    color: '#2ECC71',
    type: 'EXPENSE',
  },
  {
    name: 'Other',
    icon: '📌',
    color: '#95A5A6',
    type: 'EXPENSE',
  },
  {
    name: 'Mutual Funds',
    icon: '📈',
    color: '#2ECC71',
    type: 'SAVINGS',
  },
  {
    name: 'Emergency Fund',
    icon: '🛟',
    color: '#E74C3C',
    type: 'SAVINGS',
  },
  {
    name: 'Stocks',
    icon: '📊',
    color: '#3498DB',
    type: 'SAVINGS',
  },
];

const seedCategories = async (userId) => {
  const data = DEFAULT_CATEGORIES.map((cat) => ({
    ...cat,
    isDefault: true,
    userId,
  }));

  await prisma.category.createMany({ data });
};

const getUserDefaultCategory = async (userId) => {
  let category = await prisma.category.findFirst({
    where: {
      userId,
      name: 'Other',
    },
  });

  if (!category) {
    category = await prisma.category.findFirst({
      where: {
        userId,
      },
    });
  }

  if (!category) {
    throw new Error('No category found for user.');
  }

  return category;
};

const computeNextExecution = (
  frequency,
  dayOfMonth,
  dayOfWeek
) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const next = new Date(now);

  if (frequency === 'DAILY') {
    next.setDate(now.getDate() + 1);
  } else if (frequency === 'WEEKLY') {
    const target =
      dayOfWeek !== null && dayOfWeek !== undefined
        ? parseInt(dayOfWeek)
        : now.getDay();

    const diff =
      (target - now.getDay() + 7) % 7;

    next.setDate(
      now.getDate() + (diff === 0 ? 7 : diff)
    );
  } else if (frequency === 'MONTHLY') {
    const targetDate = dayOfMonth
      ? parseInt(dayOfMonth)
      : now.getDate();

    next.setMonth(now.getMonth() + 1);
    next.setDate(targetDate);

    if (next.getDate() !== targetDate) {
      next.setDate(0);
    }
  } else if (frequency === 'YEARLY') {
    next.setFullYear(now.getFullYear() + 1);
  }

  return next;
};

const normaliseMerchant = (merchant) => {
  if (merchant === null || merchant === undefined) {
    return null;
  }

  const trimmed = String(merchant).trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 100);
};

const resolveMerchantAlias = async (
  userId,
  inputName
) => {
  const name = normaliseMerchant(inputName);

  if (!name) {
    return null;
  }

  const match = await prisma.merchant.findFirst({
    where: {
      userId,
      OR: [
        {
          name,
        },
        {
          aliases: {
            has: name,
          },
        },
      ],
    },
  });

  return match ? match.name : name;
};

const upsertManagedMerchant = async (
  userId,
  merchantName
) => {
  const name = normaliseMerchant(merchantName);

  if (!name) {
    return;
  }

  const resolved = await resolveMerchantAlias(
    userId,
    name
  );

  if (resolved !== name) {
    return;
  }

  try {
    await prisma.merchant.upsert({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
      update: {},
      create: {
        userId,
        name,
        isActive: true,
      },
    });
  } catch (err) {
    console.error(
      'upsertManagedMerchant error:',
      err.message
    );
  }
};

// ==========================================
// ACCOUNT HELPERS
// ==========================================

const VALID_ACCOUNT_TYPES = [
  'BANK',
  'CREDIT_CARD',
  'CASH',
  'WALLET',
  'UPI',
  'OTHER',
];

const getOwnedAccount = async (
  userId,
  accountId
) => {
  if (!accountId) {
    return null;
  }

  return prisma.account.findFirst({
    where: {
      id: accountId,
      userId,
    },
  });
};

// ==========================================
// 1. AUTH
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      email,
      password,
      name,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password required.',
      });
    }

    const existing =
      await prisma.user.findUnique({
        where: {
          email,
        },
      });

    if (existing) {
      return res.status(409).json({
        error: 'Email already registered.',
      });
    }

    const hashedPassword = await bcrypt.hash(
      password,
      10
    );

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
    });

    await seedCategories(user.id);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '30d',
      }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Registration failed.',
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const {
      email,
      password,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password required.',
      });
    }

    const user =
      await prisma.user.findUnique({
        where: {
          email,
        },
      });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials.',
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password
    );

    if (!valid) {
      return res.status(401).json({
        error: 'Invalid credentials.',
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '30d',
      }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Login failed.',
    });
  }
});

app.post(
  '/api/auth/forgot-password',
  async (req, res) => {
    try {
      const {
        email,
      } = req.body;

      const user =
        await prisma.user.findUnique({
          where: {
            email,
          },
        });

      if (!user) {
        return res.status(404).json({
          error: 'No user found with this email.',
        });
      }

      const resetToken = jwt.sign(
        {
          id: user.id,
        },
        process.env.JWT_SECRET,
        {
          expiresIn: '1h',
        }
      );

      const resetLink =
        `${process.env.FRONTEND_URL}` +
        `/reset-password?token=${resetToken}`;

      await transporter.sendMail({
        from:
          `"Expense Tracker" <` +
          `${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Reset Your Password',
        html:
          `<p>Hi ${user.name || 'there'},</p>` +
          `<p>Click <a href="${resetLink}">here</a> ` +
          `to reset your password. ` +
          `This link expires in 1 hour.</p>`,
      });

      res.json({
        message: 'Password reset email sent.',
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Failed to send reset email.',
      });
    }
  }
);

app.post(
  '/api/auth/reset-password',
  async (req, res) => {
    try {
      const {
        token,
        newPassword,
      } = req.body;

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET
      );

      const hashed =
        await bcrypt.hash(
          newPassword,
          10
        );

      await prisma.user.update({
        where: {
          id: decoded.id,
        },
        data: {
          password: hashed,
        },
      });

      res.json({
        message:
          'Password updated successfully.',
      });
    } catch (error) {
      res.status(400).json({
        error: 'Invalid or expired token.',
      });
    }
  }
);

// ==========================================
// 2. EXPENSES
// ==========================================

app.get(
  '/api/expenses',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        startDate,
        endDate,
        categoryId,
        search,
        type,
        merchant,
      } = req.query;

      const where = {
        userId: req.user.id,
      };

      if (startDate) {
        where.date = {
          ...where.date,
          gte: new Date(startDate),
        };
      }

      if (endDate) {
        where.date = {
          ...where.date,
          lte: new Date(endDate),
        };
      }

      if (categoryId) {
        where.categoryId = categoryId;
      }

      if (type) {
        where.type = type;
      }

      if (merchant) {
        where.merchant = merchant;
      }

      if (search) {
        where.OR = [
          {
            note: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            merchant: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            category: {
              name: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        ];
      }

      const expenses =
        await prisma.expense.findMany({
          where,
          include: {
            category: true,
            account: true,
          },
          orderBy: {
            date: 'desc',
          },
        });

      res.json(expenses);
    } catch (error) {
      console.error(
        'Fetch expenses error:',
        error
      );

      res.status(500).json({
        error: 'Failed to fetch expenses.',
      });
    }
  }
);

app.post(
  '/api/expenses',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        amount,
        date,
        note,
        merchant,
        categoryId,
        receiptUrl,
        isRecurring,
        type,
        accountId,
      } = req.body;

      const rawMerchant =
        normaliseMerchant(merchant);

      const normMerchant = rawMerchant
        ? await resolveMerchantAlias(
            req.user.id,
            rawMerchant
          )
        : null;

      if (accountId) {
        const account =
          await getOwnedAccount(
            req.user.id,
            accountId
          );

        if (!account) {
          return res.status(400).json({
            error: 'Invalid account.',
          });
        }
      }

      const expense =
        await prisma.expense.create({
          data: {
            amount: parseFloat(amount),
            date: date
              ? new Date(date)
              : new Date(),
            note,
            merchant: normMerchant,
            receiptUrl,
            isRecurring:
              isRecurring || false,
            type:
              type === 'SAVINGS'
                ? 'SAVINGS'
                : 'EXPENSE',
            userId: req.user.id,
            categoryId,
            accountId:
              accountId || null,
          },
          include: {
            category: true,
            account: true,
          },
        });

      if (normMerchant) {
        await upsertManagedMerchant(
          req.user.id,
          normMerchant
        );
      }

      res.status(201).json(expense);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Failed to create expense.',
      });
    }
  }
);

app.put(
  '/api/expenses/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        amount,
        date,
        note,
        merchant,
        categoryId,
        receiptUrl,
        type,
        accountId,
      } = req.body;

      if (accountId) {
        const account =
          await getOwnedAccount(
            req.user.id,
            accountId
          );

        if (!account) {
          return res.status(400).json({
            error: 'Invalid account.',
          });
        }
      }

      const rawMerchant =
        merchant !== undefined
          ? normaliseMerchant(merchant)
          : undefined;

      const normMerchant = rawMerchant
        ? await resolveMerchantAlias(
            req.user.id,
            rawMerchant
          )
        : rawMerchant;

      const expense =
        await prisma.expense.update({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
          data: {
            amount: parseFloat(amount),
            date: new Date(date),
            note,
            ...(merchant !== undefined && {
              merchant: normMerchant,
            }),
            categoryId,
            receiptUrl,
            ...(type && {
              type,
            }),
            ...(accountId !== undefined && {
              accountId:
                accountId || null,
            }),
          },
          include: {
            category: true,
            account: true,
          },
        });

      if (normMerchant) {
        await upsertManagedMerchant(
          req.user.id,
          normMerchant
        );
      }

      res.json(expense);
    } catch (error) {
      console.error(
        'Update expense error:',
        error
      );

      res.status(500).json({
        error: 'Failed to update expense.',
      });
    }
  }
);

app.delete(
  '/api/expenses/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.expense.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message: 'Expense deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to delete expense.',
      });
    }
  }
);

app.get(
  '/api/export/csv',
  authenticateToken,
  async (req, res) => {
    try {
      const expenses =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
          },
          include: {
            category: true,
          },
          orderBy: {
            date: 'desc',
          },
        });

      let csv =
        'Date,Type,Category,Merchant,Amount,Note,Receipt\n';

      expenses.forEach((expense) => {
        const merchant =
          (expense.merchant || '').replace(
            /,/g,
            ';'
          );

        const note =
          (expense.note || '').replace(
            /,/g,
            ';'
          );

        csv +=
          `${expense.date.toISOString().split('T')[0]},` +
          `${expense.type || 'EXPENSE'},` +
          `${expense.category.name},` +
          `${merchant},` +
          `${expense.amount},` +
          `${note},` +
          `${expense.receiptUrl || ''}\n`;
      });

      res.header(
        'Content-Type',
        'text/csv'
      );

      res.attachment(
        'expenses_export.csv'
      );

      res.send(csv);
    } catch (error) {
      res.status(500).json({
        error: 'Export failed.',
      });
    }
  }
);

// ==========================================
// 3. MERCHANTS
// ==========================================

app.get(
  '/api/merchants',
  authenticateToken,
  async (req, res) => {
    try {
      const rows =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
            merchant: {
              not: null,
            },
          },
          select: {
            merchant: true,
            date: true,
          },
          orderBy: {
            date: 'desc',
          },
        });

      const map = {};

      rows.forEach((row) => {
        const name =
          (row.merchant || '').trim();

        if (!name) {
          return;
        }

        if (!map[name]) {
          map[name] = {
            name,
            count: 0,
            lastDate: row.date,
          };
        }

        map[name].count += 1;

        if (
          row.date >
          map[name].lastDate
        ) {
          map[name].lastDate =
            row.date;
        }
      });

      res.json(
        Object.values(map).sort(
          (a, b) =>
            b.count - a.count
        )
      );
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to fetch merchants.',
      });
    }
  }
);

// Merchant stats with alias resolution
// and category breakdown.
app.get(
  '/api/merchants/stats',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        month,
      } = req.query;

      let startDate;
      let endDate;
      let prevStartDate;
      let prevEndDate;

      if (month) {
        const [year, monthNumber] =
          month
            .split('-')
            .map(Number);

        startDate = new Date(
          year,
          monthNumber - 1,
          1
        );

        endDate = new Date(
          year,
          monthNumber,
          0,
          23,
          59,
          59
        );

        prevStartDate = new Date(
          year,
          monthNumber - 2,
          1
        );

        prevEndDate = new Date(
          year,
          monthNumber - 1,
          0,
          23,
          59,
          59
        );
      } else {
        const now = new Date();

        startDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          1
        );

        endDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59
        );

        prevStartDate = new Date(
          now.getFullYear(),
          now.getMonth() - 1,
          1
        );

        prevEndDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          0,
          23,
          59,
          59
        );
      }

      const twelveMonthsAgo =
        new Date();

      twelveMonthsAgo.setMonth(
        twelveMonthsAgo.getMonth() - 12
      );

      const allRecent =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
            type: 'EXPENSE',
            merchant: {
              not: null,
            },
            date: {
              gte: twelveMonthsAgo,
            },
          },
          include: {
            category: true,
          },
          orderBy: {
            date: 'desc',
          },
        });

      const allMerchantRecords =
        await prisma.merchant.findMany({
          where: {
            userId: req.user.id,
          },
          select: {
            name: true,
            aliases: true,
          },
        });

      const aliasMap = {};

      allMerchantRecords.forEach(
        (merchantRecord) => {
          aliasMap[
            merchantRecord.name
          ] = merchantRecord.name;

          merchantRecord.aliases.forEach(
            (alias) => {
              aliasMap[alias] =
                merchantRecord.name;
            }
          );
        }
      );

      const merchantMap = {};

      allRecent.forEach((expense) => {
        const rawName =
          (expense.merchant || '').trim();

        if (!rawName) {
          return;
        }

        const name =
          aliasMap[rawName] ||
          rawName;

        if (!merchantMap[name]) {
          merchantMap[name] = {
            name,
            monthSpent: 0,
            monthCount: 0,
            prevMonthSpent: 0,
            prevMonthCount: 0,
            allTimeSpent: 0,
            allTimeCount: 0,
            lastDate: expense.date,
            categoryCounts: {},
            categoryIcons: {},
            categoryAmounts: {},
          };
        }

        const merchant =
          merchantMap[name];

        const amount =
          parseFloat(
            expense.amount || 0
          );

        merchant.allTimeSpent +=
          amount;

        merchant.allTimeCount += 1;

        if (
          expense.date >
          merchant.lastDate
        ) {
          merchant.lastDate =
            expense.date;
        }

        const categoryName =
          expense.category?.name ||
          'Uncategorized';

        const categoryIcon =
          expense.category?.icon ||
          '📌';

        merchant.categoryCounts[
          categoryName
        ] =
          (merchant.categoryCounts[
            categoryName
          ] || 0) + 1;

        merchant.categoryAmounts[
          categoryName
        ] =
          (merchant.categoryAmounts[
            categoryName
          ] || 0) + amount;

        merchant.categoryIcons[
          categoryName
        ] = categoryIcon;

        if (
          expense.date >= startDate &&
          expense.date <= endDate
        ) {
          merchant.monthSpent +=
            amount;

          merchant.monthCount += 1;
        }

        if (
          expense.date >=
            prevStartDate &&
          expense.date <= prevEndDate
        ) {
          merchant.prevMonthSpent +=
            amount;

          merchant.prevMonthCount +=
            1;
        }
      });

      const merchants =
        Object.values(merchantMap)
          .map((merchant) => {
            let primaryCategory =
              null;

            let maxCount = 0;

            Object.entries(
              merchant.categoryCounts
            ).forEach(
              ([name, count]) => {
                if (
                  count > maxCount
                ) {
                  maxCount = count;

                  primaryCategory = {
                    name,
                    icon:
                      merchant
                        .categoryIcons[
                        name
                      ] || '📌',
                  };
                }
              }
            );

            let trend = 'flat';

            if (
              merchant.prevMonthSpent ===
                0 &&
              merchant.monthSpent > 0
            ) {
              trend = 'new';
            } else if (
              merchant.prevMonthSpent > 0
            ) {
              const change =
                ((merchant.monthSpent -
                  merchant.prevMonthSpent) /
                  merchant.prevMonthSpent) *
                100;

              if (change > 10) {
                trend = 'up';
              } else if (
                change < -10
              ) {
                trend = 'down';
              }
            }

            return {
              name: merchant.name,

              monthSpent:
                merchant.monthSpent,

              monthCount:
                merchant.monthCount,

              monthAvg:
                merchant.monthCount > 0
                  ? merchant.monthSpent /
                    merchant.monthCount
                  : 0,

              prevMonthSpent:
                merchant.prevMonthSpent,

              allTimeSpent:
                merchant.allTimeSpent,

              allTimeCount:
                merchant.allTimeCount,

              lastDate:
                merchant.lastDate,

              primaryCategory,

              trend,

              categoryBreakdown:
                Object.entries(
                  merchant.categoryAmounts
                )
                  .map(
                    ([
                      name,
                      amount,
                    ]) => ({
                      name,

                      icon:
                        merchant
                          .categoryIcons[
                          name
                        ] || '📌',

                      amount,

                      count:
                        merchant
                          .categoryCounts[
                          name
                        ] || 0,

                      pct:
                        merchant
                          .allTimeSpent >
                        0
                          ? (amount /
                              merchant
                                .allTimeSpent) *
                            100
                          : 0,
                    })
                  )
                  .sort(
                    (a, b) =>
                      b.amount -
                      a.amount
                  ),
            };
          })
          .filter(
            (merchant) =>
              merchant.monthCount > 0 ||
              merchant.prevMonthCount >
                0
          )
          .sort(
            (a, b) =>
              b.monthSpent -
              a.monthSpent
          );

      res.json({
        month:
          startDate
            .toISOString()
            .slice(0, 7),
        merchants,
      });
    } catch (error) {
      console.error(
        'Merchant stats error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch merchant stats.',
      });
    }
  }
);

app.get(
  '/api/merchants/transactions',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        limit,
      } = req.query;

      if (!name) {
        return res.status(400).json({
          error:
            'Merchant name is required.',
        });
      }

      const take = Math.min(
        parseInt(limit) || 10,
        50
      );

      const merchant =
        await prisma.merchant.findFirst({
          where: {
            userId: req.user.id,
            name,
          },
        });

      const aliases =
        merchant?.aliases || [];

      const namesToMatch = [
        name,
        ...aliases,
      ];

      const transactions =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
            merchant: {
              in: namesToMatch,
            },
          },
          include: {
            category: true,
          },
          orderBy: {
            date: 'desc',
          },
          take,
        });

      res.json({
        merchant: name,
        aliases,
        transactions,
      });
    } catch (error) {
      console.error(
        'Merchant transactions error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch transactions.',
      });
    }
  }
);

app.get(
  '/api/merchants/frequency',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
      } = req.query;

      if (!name) {
        return res.status(400).json({
          error:
            'Merchant name is required.',
        });
      }

      const merchantRec =
        await prisma.merchant.findFirst({
          where: {
            userId: req.user.id,
            name,
          },
        });

      const aliases =
        merchantRec?.aliases || [];

      const namesToMatch = [
        name,
        ...aliases,
      ];

      const expenses =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
            merchant: {
              in: namesToMatch,
            },
            type: 'EXPENSE',
          },
          orderBy: {
            date: 'desc',
          },
        });

      const matrix =
        Array.from(
          {
            length: 5,
          },
          () => Array(7).fill(0)
        );

      const amountMatrix =
        Array.from(
          {
            length: 5,
          },
          () => Array(7).fill(0)
        );

      const byDayOfWeek =
        Array(7).fill(0);

      const byWeekOfMonth =
        Array(5).fill(0);

      const byHour =
        Array(24).fill(0);

      let totalVisits = 0;
      let totalAmount = 0;
      let earliestDate = null;
      let latestDate = null;

      expenses.forEach((expense) => {
        const date =
          new Date(expense.date);

        const dayOfWeek =
          date.getDay();

        const dayOfMonth =
          date.getDate();

        const week = Math.min(
          4,
          Math.floor(
            (dayOfMonth - 1) / 7
          )
        );

        const amount =
          parseFloat(
            expense.amount || 0
          );

        matrix[week][dayOfWeek] += 1;

        amountMatrix[
          week
        ][dayOfWeek] += amount;

        byDayOfWeek[
          dayOfWeek
        ] += 1;

        byWeekOfMonth[
          week
        ] += 1;

        byHour[
          date.getHours()
        ] += 1;

        totalVisits += 1;
        totalAmount += amount;

        if (
          !earliestDate ||
          date < earliestDate
        ) {
          earliestDate = date;
        }

        if (
          !latestDate ||
          date > latestDate
        ) {
          latestDate = date;
        }
      });

      const maxDow =
        Math.max(...byDayOfWeek);

      const busiestDowIndex =
        byDayOfWeek.indexOf(maxDow);

      const DAY_NAMES = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ];

      const maxHour =
        Math.max(...byHour);

      const busiestHourIndex =
        byHour.indexOf(maxHour);

      res.json({
        merchant: name,
        aliases,
        totalVisits,
        totalAmount,

        avgPerVisit:
          totalVisits > 0
            ? totalAmount /
              totalVisits
            : 0,

        earliestDate,
        latestDate,

        matrix,
        amountMatrix,
        byDayOfWeek,
        byWeekOfMonth,
        byHour,

        busiestDay:
          maxDow > 0
            ? DAY_NAMES[
                busiestDowIndex
              ]
            : null,

        busiestHour:
          maxHour > 0
            ? busiestHourIndex
            : null,
      });
    } catch (error) {
      console.error(
        'Frequency error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch frequency.',
      });
    }
  }
);

// ==========================================
// 4. MANAGED MERCHANT LIST
// ==========================================

app.get(
  '/api/merchant-list',
  authenticateToken,
  async (req, res) => {
    try {
      const merchants =
        await prisma.merchant.findMany({
          where: {
            userId: req.user.id,
          },
          orderBy: [
            {
              isActive: 'desc',
            },
            {
              name: 'asc',
            },
          ],
        });

      res.json(merchants);
    } catch (error) {
      console.error(
        'List merchant error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch merchant list.',
      });
    }
  }
);

app.post(
  '/api/merchant-list',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        isActive,
      } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({
          error:
            'Merchant name is required.',
        });
      }

      const merchant =
        await prisma.merchant.create({
          data: {
            name:
              name
                .trim()
                .slice(0, 100),
            isActive:
              isActive !== false,
            userId: req.user.id,
          },
        });

      res.status(201).json(merchant);
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'This merchant already exists.',
        });
      }

      console.error(
        'Create merchant error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to create merchant.',
      });
    }
  }
);

app.put(
  '/api/merchant-list/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        isActive,
      } = req.body;

      const existing =
        await prisma.merchant.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Merchant not found.',
        });
      }

      const updated =
        await prisma.merchant.update({
          where: {
            id: req.params.id,
          },
          data: {
            ...(name !== undefined &&
              name.trim() && {
                name:
                  name
                    .trim()
                    .slice(0, 100),
              }),

            ...(isActive !==
              undefined && {
              isActive,
            }),
          },
        });

      res.json(updated);
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'A merchant with this name already exists.',
        });
      }

      console.error(
        'Update merchant error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update merchant.',
      });
    }
  }
);

app.delete(
  '/api/merchant-list/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.merchant.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message:
          'Merchant removed.',
      });
    } catch (error) {
      console.error(
        'Delete merchant error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to delete merchant.',
      });
    }
  }
);

app.post(
  '/api/merchant-list/import-existing',
  authenticateToken,
  async (req, res) => {
    try {
      const rows =
        await prisma.expense.findMany({
          where: {
            userId: req.user.id,
            merchant: {
              not: null,
            },
          },
          select: {
            merchant: true,
          },
        });

      const uniqueNames =
        new Set();

      rows.forEach((row) => {
        const name =
          (row.merchant || '').trim();

        if (name) {
          uniqueNames.add(name);
        }
      });

      const existing =
        await prisma.merchant.findMany({
          where: {
            userId: req.user.id,
          },
          select: {
            name: true,
          },
        });

      const existingSet =
        new Set(
          existing.map(
            (merchant) =>
              merchant.name
          )
        );

      let added = 0;
      let skipped = 0;

      for (
        const name of uniqueNames
      ) {
        if (
          existingSet.has(name)
        ) {
          skipped++;
          continue;
        }

        try {
          await prisma.merchant.create({
            data: {
              userId: req.user.id,
              name,
              isActive: true,
            },
          });

          existingSet.add(name);
          added++;
        } catch (err) {
          console.error(
            `Import skip for "${name}":`,
            err.message
          );

          skipped++;
        }
      }

      res.json({
        message: 'Import complete',
        added,
        skipped,
      });
    } catch (error) {
      console.error(
        'Import merchants error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to import merchants.',
        details: error.message,
      });
    }
  }
);

app.post(
  '/api/merchant-list/:id/aliases',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        alias,
      } = req.body;

      if (
        !alias ||
        !alias.trim()
      ) {
        return res.status(400).json({
          error: 'Alias is required.',
        });
      }

      const cleanAlias =
        alias
          .trim()
          .slice(0, 100);

      const merchant =
        await prisma.merchant.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!merchant) {
        return res.status(404).json({
          error:
            'Merchant not found.',
        });
      }

      const conflict =
        await prisma.merchant.findFirst({
          where: {
            userId: req.user.id,

            NOT: {
              id: merchant.id,
            },

            OR: [
              {
                name: cleanAlias,
              },
              {
                aliases: {
                  has: cleanAlias,
                },
              },
            ],
          },
        });

      if (conflict) {
        return res.status(409).json({
          error:
            `"${cleanAlias}" already belongs to ` +
            `${conflict.name}.`,
        });
      }

      if (
        merchant.aliases.includes(
          cleanAlias
        )
      ) {
        return res.json(
          merchant
        );
      }

      const updated =
        await prisma.merchant.update({
          where: {
            id: merchant.id,
          },
          data: {
            aliases: {
              push: cleanAlias,
            },
          },
        });

      res.json(updated);
    } catch (error) {
      console.error(
        'Add alias error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to add alias.',
      });
    }
  }
);

app.delete(
  '/api/merchant-list/:id/aliases/:alias',
  authenticateToken,
  async (req, res) => {
    try {
      const alias =
        decodeURIComponent(
          req.params.alias
        );

      const merchant =
        await prisma.merchant.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!merchant) {
        return res.status(404).json({
          error:
            'Merchant not found.',
        });
      }

      const updated =
        await prisma.merchant.update({
          where: {
            id: merchant.id,
          },
          data: {
            aliases:
              merchant.aliases.filter(
                (item) =>
                  item !== alias
              ),
          },
        });

      res.json(updated);
    } catch (error) {
      console.error(
        'Remove alias error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to remove alias.',
      });
    }
  }
);

// ==========================================
// 5. ACCOUNTS
// ==========================================

app.get(
  '/api/accounts',
  authenticateToken,
  async (req, res) => {
    try {
      const accounts =
        await prisma.account.findMany({
          where: {
            userId: req.user.id,
          },
          orderBy: [
            {
              isActive: 'desc',
            },
            {
              name: 'asc',
            },
          ],
        });

      res.json(accounts);
    } catch (error) {
      console.error(
        'Fetch accounts error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch accounts.',
      });
    }
  }
);

app.post(
  '/api/accounts',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        type,
        institution,
        last4,
        currency,
      } = req.body;

      if (
        !name ||
        !name.trim()
      ) {
        return res.status(400).json({
          error:
            'Account name is required.',
        });
      }

      if (
        !VALID_ACCOUNT_TYPES.includes(
          type
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid account type.',
        });
      }

      const cleanLast4 =
        last4?.trim() || null;

      if (
        cleanLast4 &&
        !/^\d{4}$/.test(cleanLast4)
      ) {
        return res.status(400).json({
          error:
            'Last 4 digits must contain exactly 4 numbers.',
        });
      }

      const account =
        await prisma.account.create({
          data: {
            name: name.trim(),
            type,

            institution:
              institution?.trim() ||
              null,

            last4: cleanLast4,

            currency:
              currency
                ?.trim()
                .toUpperCase() ||
              'INR',

            userId: req.user.id,
          },
        });

      res.status(201).json(
        account
      );
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'An account with this name already exists.',
        });
      }

      console.error(
        'Create account error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to create account.',
      });
    }
  }
);

app.put(
  '/api/accounts/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const existing =
        await prisma.account.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Account not found.',
        });
      }

      const {
        name,
        type,
        institution,
        last4,
        currency,
      } = req.body;

      if (
        name !== undefined &&
        !name.trim()
      ) {
        return res.status(400).json({
          error:
            'Account name cannot be blank.',
        });
      }

      if (
        type !== undefined &&
        !VALID_ACCOUNT_TYPES.includes(
          type
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid account type.',
        });
      }

      const cleanLast4 =
        last4 !== undefined
          ? last4?.trim() || null
          : undefined;

      if (
        cleanLast4 &&
        !/^\d{4}$/.test(cleanLast4)
      ) {
        return res.status(400).json({
          error:
            'Last 4 digits must contain exactly 4 numbers.',
        });
      }

      const updated =
        await prisma.account.update({
          where: {
            id: existing.id,
          },
          data: {
            ...(name !== undefined && {
              name: name.trim(),
            }),

            ...(type !== undefined && {
              type,
            }),

            ...(institution !==
              undefined && {
              institution:
                institution?.trim() ||
                null,
            }),

            ...(last4 !== undefined && {
              last4: cleanLast4,
            }),

            ...(currency !==
              undefined && {
              currency:
                currency
                  ?.trim()
                  .toUpperCase() ||
                'INR',
            }),
          },
        });

      res.json(updated);
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'An account with this name already exists.',
        });
      }

      console.error(
        'Update account error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update account.',
      });
    }
  }
);

app.patch(
  '/api/accounts/:id/toggle',
  authenticateToken,
  async (req, res) => {
    try {
      const existing =
        await prisma.account.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Account not found.',
        });
      }

      const updated =
        await prisma.account.update({
          where: {
            id: existing.id,
          },
          data: {
            isActive:
              !existing.isActive,
          },
        });

      res.json(updated);
    } catch (error) {
      console.error(
        'Toggle account error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update account.',
      });
    }
  }
);

app.delete(
  '/api/accounts/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const existing =
        await prisma.account.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Account not found.',
        });
      }

      await prisma.account.delete({
        where: {
          id: existing.id,
        },
      });

      res.json({
        message:
          'Account deleted.',
      });
    } catch (error) {
      console.error(
        'Delete account error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to delete account.',
      });
    }
  }
);

// ==========================================
// 6. INCOME
// ==========================================

app.get(
  '/api/incomes',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        startDate,
        endDate,
        month,
      } = req.query;

      const where = {
        userId: req.user.id,
      };

      if (month) {
        const [year, monthNumber] =
          month
            .split('-')
            .map(Number);

        where.date = {
          gte: new Date(
            year,
            monthNumber - 1,
            1
          ),
          lte: new Date(
            year,
            monthNumber,
            0,
            23,
            59,
            59
          ),
        };
      } else {
        if (startDate) {
          where.date = {
            ...where.date,
            gte: new Date(startDate),
          };
        }

        if (endDate) {
          where.date = {
            ...where.date,
            lte: new Date(endDate),
          };
        }
      }

      const incomes =
        await prisma.income.findMany({
          where,
          include: {
            account: true,
          },
          orderBy: {
            date: 'desc',
          },
        });

      res.json(incomes);
    } catch (error) {
      console.error(
        'Fetch incomes error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch incomes.',
      });
    }
  }
);

app.post(
  '/api/incomes',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        amount,
        date,
        note,
        source,
        accountId,
      } = req.body;

      if (
        !amount ||
        parseFloat(amount) <= 0
      ) {
        return res.status(400).json({
          error:
            'A positive amount is required.',
        });
      }

      if (accountId) {
        const account =
          await getOwnedAccount(
            req.user.id,
            accountId
          );

        if (!account) {
          return res.status(400).json({
            error:
              'Invalid account.',
          });
        }
      }

      const income =
        await prisma.income.create({
          data: {
            amount:
              parseFloat(amount),

            date: date
              ? new Date(date)
              : new Date(),

            note,

            source:
              source || 'SALARY',

            userId:
              req.user.id,

            accountId:
              accountId || null,
          },

          include: {
            account: true,
          },
        });

      res.status(201).json(income);
    } catch (error) {
      console.error(
        'Create income error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to create income.',
      });
    }
  }
);

app.delete(
  '/api/incomes/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.income.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message: 'Income deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to delete income.',
      });
    }
  }
);

// ==========================================
// 7. DASHBOARD SUMMARY
// ==========================================

app.get(
  '/api/dashboard/summary',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        month,
      } = req.query;

      let startDate;
      let endDate;

      if (month) {
        const [year, monthNumber] =
          month
            .split('-')
            .map(Number);

        startDate = new Date(
          year,
          monthNumber - 1,
          1
        );

        endDate = new Date(
          year,
          monthNumber,
          0,
          23,
          59,
          59
        );
      } else {
        const now = new Date();

        startDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          1
        );

        endDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59
        );
      }

      const [
        incomes,
        expenseRows,
        savingsRows,
      ] = await Promise.all([
        prisma.income.findMany({
          where: {
            userId: req.user.id,
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
        }),

        prisma.expense.findMany({
          where: {
            userId: req.user.id,
            type: 'EXPENSE',
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
          include: {
            category: true,
          },
        }),

        prisma.expense.findMany({
          where: {
            userId: req.user.id,
            type: 'SAVINGS',
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
          include: {
            category: true,
          },
        }),
      ]);

      const sumOf = (rows) =>
        rows.reduce(
          (sum, row) =>
            sum +
            parseFloat(
              row.amount || 0
            ),
          0
        );

      const totalIncome =
        sumOf(incomes);

      const spent =
        sumOf(expenseRows);

      const saved =
        sumOf(savingsRows);

      const unspent =
        totalIncome -
        spent -
        saved;

      const savingsRate =
        totalIncome > 0
          ? (saved /
              totalIncome) *
            100
          : 0;

      const breakdown = {};

      savingsRows.forEach(
        (row) => {
          const name =
            row.category?.name ||
            'Uncategorized';

          breakdown[name] =
            (breakdown[name] || 0) +
            parseFloat(
              row.amount || 0
            );
        }
      );

      const expenseBreakdown = {};

      expenseRows.forEach(
        (row) => {
          const name =
            row.category?.name ||
            'Uncategorized';

          expenseBreakdown[name] =
            (expenseBreakdown[
              name
            ] || 0) +
            parseFloat(
              row.amount || 0
            );
        }
      );

      res.json({
        month:
          startDate
            .toISOString()
            .slice(0, 7),

        income: totalIncome,
        spent,
        saved,
        unspent,

        savingsRate:
          Number(
            savingsRate.toFixed(2)
          ),

        savingsByCategory:
          Object.entries(
            breakdown
          ).map(
            ([name, amount]) => ({
              name,
              amount,
            })
          ),

        expensesByCategory:
          Object.entries(
            expenseBreakdown
          ).map(
            ([name, amount]) => ({
              name,
              amount,
            })
          ),

        counts: {
          income:
            incomes.length,

          expenses:
            expenseRows.length,

          savings:
            savingsRows.length,
        },
      });
    } catch (error) {
      console.error(
        'Dashboard summary error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to fetch dashboard summary.',
      });
    }
  }
);

// ==========================================
// 8. CATEGORIES
// ==========================================

app.get(
  '/api/categories',
  authenticateToken,
  async (req, res) => {
    try {
      const categories =
        await prisma.category.findMany({
          where: {
            userId: req.user.id,
          },
          orderBy: {
            name: 'asc',
          },
        });

      res.json(categories);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to fetch categories.',
      });
    }
  }
);

app.post(
  '/api/categories',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        icon,
        color,
        type,
      } = req.body;

      const category =
        await prisma.category.create({
          data: {
            name,
            icon,
            color,

            type:
              type === 'SAVINGS'
                ? 'SAVINGS'
                : 'EXPENSE',

            userId:
              req.user.id,

            isDefault:
              false,
          },
        });

      res.status(201).json(
        category
      );
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'Category name already exists.',
        });
      }

      res.status(500).json({
        error:
          'Failed to create category.',
      });
    }
  }
);

app.put(
  '/api/categories/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        name,
        icon,
        color,
        type,
      } = req.body;

      if (
        !name ||
        !name.trim()
      ) {
        return res.status(400).json({
          error:
            'Category name is required.',
        });
      }

      const category =
        await prisma.category.update({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
          data: {
            name: name.trim(),
            icon,
            color,

            ...(type && {
              type:
                type === 'SAVINGS'
                  ? 'SAVINGS'
                  : 'EXPENSE',
            }),
          },
        });

      res.json(category);
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'A category with this name already exists.',
        });
      }

      console.error(
        'Update category error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update category.',
      });
    }
  }
);

app.delete(
  '/api/categories/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.category.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
          isDefault: false,
        },
      });

      res.json({
        message:
          'Category deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to delete category.',
      });
    }
  }
);

app.post(
  '/api/seed-savings-categories',
  authenticateToken,
  async (req, res) => {
    try {
      const savingsDefaults = [
        {
          name: 'Mutual Funds',
          icon: '📈',
          color: '#2ECC71',
          type: 'SAVINGS',
        },
        {
          name:
            'Emergency Fund',
          icon: '🛟',
          color: '#E74C3C',
          type: 'SAVINGS',
        },
        {
          name: 'Stocks',
          icon: '📊',
          color: '#3498DB',
          type: 'SAVINGS',
        },
      ];

      const created = [];
      const skipped = [];

      for (
        const categoryData
        of savingsDefaults
      ) {
        const existing =
          await prisma.category.findFirst({
            where: {
              userId:
                req.user.id,
              name:
                categoryData.name,
            },
          });

        if (existing) {
          if (
            existing.type !==
            'SAVINGS'
          ) {
            await prisma.category.update({
              where: {
                id: existing.id,
              },
              data: {
                type: 'SAVINGS',
              },
            });

            skipped.push(
              `${categoryData.name} ` +
              '(upgraded to SAVINGS)'
            );
          } else {
            skipped.push(
              `${categoryData.name} ` +
              '(already exists)'
            );
          }

          continue;
        }

        const category =
          await prisma.category.create({
            data: {
              ...categoryData,
              userId:
                req.user.id,
              isDefault: true,
            },
          });

        created.push(
          category.name
        );
      }

      res.json({
        message: 'Seed complete',
        created,
        skipped,
      });
    } catch (error) {
      console.error(
        'Seed error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to seed savings categories.',
      });
    }
  }
);

// ==========================================
// 9. BUDGETS
// ==========================================

app.get(
  '/api/budgets',
  authenticateToken,
  async (req, res) => {
    try {
      const budgets =
        await prisma.budget.findMany({
          where: {
            userId: req.user.id,
          },
          include: {
            category: true,
          },
        });

      res.json(budgets);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to fetch budgets.',
      });
    }
  }
);

app.post(
  '/api/budgets',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        amount,
        period,
        startDate,
        categoryId,
      } = req.body;

      const budget =
        await prisma.budget.create({
          data: {
            amount:
              parseFloat(amount),

            period,

            startDate:
              startDate
                ? new Date(
                    startDate
                  )
                : new Date(),

            userId:
              req.user.id,

            categoryId,
          },

          include: {
            category: true,
          },
        });

      res.status(201).json(
        budget
      );
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'Budget for this category and period already exists.',
        });
      }

      res.status(500).json({
        error:
          'Failed to set budget.',
      });
    }
  }
);

app.put(
  '/api/budgets/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        amount,
        period,
        categoryId,
        startDate,
      } = req.body;

      const existing =
        await prisma.budget.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Budget not found.',
        });
      }

      const updated =
        await prisma.budget.update({
          where: {
            id: req.params.id,
          },
          data: {
            amount:
              parseFloat(amount),

            ...(period && {
              period,
            }),

            ...(categoryId && {
              categoryId,
            }),

            ...(startDate && {
              startDate:
                new Date(
                  startDate
                ),
            }),
          },

          include: {
            category: true,
          },
        });

      res.json(updated);
    } catch (error) {
      if (
        error.code === 'P2002'
      ) {
        return res.status(409).json({
          error:
            'A budget for this category and period already exists.',
        });
      }

      console.error(
        'Update budget error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update budget.',
      });
    }
  }
);

app.delete(
  '/api/budgets/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.budget.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message:
          'Budget deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to delete budget.',
      });
    }
  }
);

// ==========================================
// 10. RECURRING RULES
// ==========================================

app.get(
  '/api/recurring-rules',
  authenticateToken,
  async (req, res) => {
    try {
      const rules =
        await prisma.recurringRule.findMany({
          where: {
            userId: req.user.id,
          },

          include: {
            category: true,
          },

          orderBy: [
            {
              isActive: 'desc',
            },
            {
              nextExecution: 'asc',
            },
          ],
        });

      res.json(rules);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to fetch recurring rules.',
      });
    }
  }
);

app.post(
  '/api/recurring-rules',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        description,
        amount,
        frequency,
        dayOfMonth,
        dayOfWeek,
        categoryId,
      } = req.body;

      if (
        !description ||
        !amount ||
        !frequency ||
        !categoryId
      ) {
        return res.status(400).json({
          error:
            'description, amount, frequency and categoryId are required.',
        });
      }

      if (
        ![
          'DAILY',
          'WEEKLY',
          'MONTHLY',
          'YEARLY',
        ].includes(frequency)
      ) {
        return res.status(400).json({
          error:
            'Invalid frequency.',
        });
      }

      const nextExecution =
        computeNextExecution(
          frequency,
          dayOfMonth,
          dayOfWeek
        );

      const rule =
        await prisma.recurringRule.create({
          data: {
            description:
              description.trim(),

            amount:
              parseFloat(amount),

            frequency,

            dayOfMonth:
              dayOfMonth
                ? parseInt(
                    dayOfMonth
                  )
                : null,

            dayOfWeek:
              dayOfWeek !==
                undefined &&
              dayOfWeek !== null &&
              dayOfWeek !== ''
                ? parseInt(
                    dayOfWeek
                  )
                : null,

            nextExecution,
            isActive: true,

            userId:
              req.user.id,

            categoryId,
          },

          include: {
            category: true,
          },
        });

      res.status(201).json(rule);
    } catch (error) {
      console.error(
        'Create recurring rule error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to create recurring rule.',
      });
    }
  }
);

app.put(
  '/api/recurring-rules/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const {
        description,
        amount,
        frequency,
        dayOfMonth,
        dayOfWeek,
        categoryId,
        isActive,
      } = req.body;

      const existing =
        await prisma.recurringRule.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Recurring rule not found.',
        });
      }

      const newFrequency =
        frequency ||
        existing.frequency;

      const newDayOfMonth =
        dayOfMonth !== undefined
          ? dayOfMonth
            ? parseInt(
                dayOfMonth
              )
            : null
          : existing.dayOfMonth;

      const newDayOfWeek =
        dayOfWeek !== undefined
          ? dayOfWeek !== null &&
            dayOfWeek !== ''
            ? parseInt(
                dayOfWeek
              )
            : null
          : existing.dayOfWeek;

      const shouldRecompute =
        frequency !== undefined ||
        dayOfMonth !== undefined ||
        dayOfWeek !== undefined;

      const rule =
        await prisma.recurringRule.update({
          where: {
            id: req.params.id,
          },

          data: {
            ...(description && {
              description:
                description.trim(),
            }),

            ...(amount && {
              amount:
                parseFloat(
                  amount
                ),
            }),

            ...(frequency && {
              frequency,
            }),

            ...(dayOfMonth !==
              undefined && {
              dayOfMonth:
                newDayOfMonth,
            }),

            ...(dayOfWeek !==
              undefined && {
              dayOfWeek:
                newDayOfWeek,
            }),

            ...(categoryId && {
              categoryId,
            }),

            ...(isActive !==
              undefined && {
              isActive,
            }),

            ...(shouldRecompute && {
              nextExecution:
                computeNextExecution(
                  newFrequency,
                  newDayOfMonth,
                  newDayOfWeek
                ),
            }),
          },

          include: {
            category: true,
          },
        });

      res.json(rule);
    } catch (error) {
      console.error(
        'Update recurring rule error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to update recurring rule.',
      });
    }
  }
);

app.patch(
  '/api/recurring-rules/:id/toggle',
  authenticateToken,
  async (req, res) => {
    try {
      const existing =
        await prisma.recurringRule.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },
        });

      if (!existing) {
        return res.status(404).json({
          error:
            'Recurring rule not found.',
        });
      }

      const updated =
        await prisma.recurringRule.update({
          where: {
            id: req.params.id,
          },
          data: {
            isActive:
              !existing.isActive,
          },
          include: {
            category: true,
          },
        });

      res.json(updated);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to toggle recurring rule.',
      });
    }
  }
);

app.delete(
  '/api/recurring-rules/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.recurringRule.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message:
          'Recurring rule deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to delete recurring rule.',
      });
    }
  }
);

// ==========================================
// 11. RECURRING CRON
// ==========================================

const processRecurringExpenses =
  async () => {
    console.log(
      '🔄 Running recurring job...'
    );

    const today = new Date();

    today.setHours(
      0,
      0,
      0,
      0
    );

    const rules =
      await prisma.recurringRule.findMany({
        where: {
          isActive: true,

          nextExecution: {
            lte: today,
          },
        },

        include: {
          user: true,
          category: true,
        },
      });

    for (const rule of rules) {
      try {
        const entryType =
          rule.category?.type ===
          'SAVINGS'
            ? 'SAVINGS'
            : 'EXPENSE';

        const rawMerchant =
          normaliseMerchant(
            rule.description
          );

        const normMerchant =
          rawMerchant
            ? await resolveMerchantAlias(
                rule.userId,
                rawMerchant
              )
            : rawMerchant;

        await prisma.expense.create({
          data: {
            amount:
              rule.amount,

            date: today,

            note:
              `${rule.description} ` +
              '(Auto - Recurring)',

            merchant:
              normMerchant,

            isRecurring: true,

            type:
              entryType,

            userId:
              rule.userId,

            categoryId:
              rule.categoryId,
          },
        });

        if (normMerchant) {
          await upsertManagedMerchant(
            rule.userId,
            normMerchant
          );
        }

        let nextExec =
          new Date(today);

        if (
          rule.frequency ===
          'DAILY'
        ) {
          nextExec.setDate(
            today.getDate() + 1
          );
        } else if (
          rule.frequency ===
          'WEEKLY'
        ) {
          nextExec.setDate(
            today.getDate() + 7
          );
        } else if (
          rule.frequency ===
          'MONTHLY'
        ) {
          nextExec.setMonth(
            today.getMonth() + 1
          );

          if (
            rule.dayOfMonth
          ) {
            nextExec.setDate(
              rule.dayOfMonth
            );

            if (
              nextExec.getDate() !==
              rule.dayOfMonth
            ) {
              nextExec.setDate(0);
            }
          }
        } else if (
          rule.frequency ===
          'YEARLY'
        ) {
          nextExec.setFullYear(
            today.getFullYear() +
              1
          );
        }

        await prisma.recurringRule.update({
          where: {
            id: rule.id,
          },
          data: {
            nextExecution:
              nextExec,
          },
        });

        console.log(
          `✅ Auto-created ${entryType} ` +
          `for "${rule.description}"`
        );
      } catch (error) {
        console.error(
          `❌ Failed to process recurring rule ${rule.id}:`,
          error
        );
      }
    }
  };

cron.schedule(
  '30 18 * * *',
  processRecurringExpenses
);

setTimeout(
  processRecurringExpenses,
  10000
);

// ==========================================
// 12. GMAIL
// ==========================================

const oauth2Client =
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

const parseYesBankEmail = (
  subject,
  body
) => {
  const result = {
    amount: null,
    merchant: null,
  };

  let amountMatch =
    body.match(
      /(?:INR|₹)\s*([\d,]+(?:\.\d{2})?)/i
    );

  if (!amountMatch) {
    amountMatch =
      body.match(
        /([\d,]+\.\d{2})\s*(?:has been spent|spent on)/i
      );
  }

  if (!amountMatch) {
    amountMatch =
      subject.match(
        /(?:INR|₹)?\s*([\d,]+(?:\.\d{2})?)/i
      );
  }

  if (amountMatch) {
    result.amount =
      parseFloat(
        amountMatch[1].replace(
          /,/g,
          ''
        )
      );
  }

  let merchantMatch =
    body.match(
      /at\s+([A-Za-z0-9\s\.\-_]+?)(?:\s+on\s+|\s+for\s+|\s*$)/i
    );

  if (!merchantMatch) {
    merchantMatch =
      body.match(
        /at\s+([^\n,]+)/i
      );
  }

  if (!merchantMatch) {
    merchantMatch =
      subject.match(
        /at\s+([A-Za-z0-9\s\.\-_]+)/i
      );
  }

  if (merchantMatch) {
    result.merchant =
      merchantMatch[1].trim();
  }

  return result;
};

const processGmailReceipts =
  async (userId) => {
    console.log(
      `📧 Processing Gmail receipts for user ${userId}`
    );

    const user =
      await prisma.user.findUnique({
        where: {
          id: userId,
        },
      });

    if (!user) {
      return console.log(
        `❌ User ${userId} not found`
      );
    }

    if (
      !user.gmailRefreshToken
    ) {
      return console.log(
        `❌ No Gmail refresh token for user ${userId}`
      );
    }

    oauth2Client.setCredentials({
      refresh_token:
        user.gmailRefreshToken,
    });

    try {
      await oauth2Client.refreshAccessToken();
    } catch (error) {
      return console.error(
        '❌ Failed to refresh access token:',
        error.message
      );
    }

    const gmail =
      google.gmail({
        version: 'v1',
        auth: oauth2Client,
      });

    const sevenDaysAgo =
      new Date();

    sevenDaysAgo.setDate(
      sevenDaysAgo.getDate() - 7
    );

    const query =
      `from:(amazon.in OR amazonpay.in OR ` +
      `swiggy.in OR zomato.com OR uber.com OR ` +
      `flipkart.com OR yesbank.in OR ` +
      `"syes.bank.in" OR "yes.bank.in" OR ` +
      `"yesbank" OR icici.bank.in) ` +
      `after:${Math.floor(
        sevenDaysAgo.getTime() /
          1000
      )}`;

    let messages = [];

    try {
      const response =
        await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50,
        });

      messages =
        response.data.messages ||
        [];
    } catch (error) {
      console.error(
        '❌ Gmail API list error:',
        error.message
      );

      throw error;
    }

    if (
      messages.length === 0
    ) {
      return;
    }

    let defaultCategory;

    try {
      defaultCategory =
        await getUserDefaultCategory(
          userId
        );
    } catch (error) {
      return console.error(
        '❌ Failed to get default category:',
        error.message
      );
    }

    let importedCount = 0;

    for (
      const message of messages
    ) {
      try {
        const msgData =
          await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });

        const payload =
          msgData.data.payload;

        let subject = '';
        let body = '';

        const headers =
          payload.headers;

        headers.forEach(
          (header) => {
            if (
              header.name ===
              'Subject'
            ) {
              subject =
                header.value;
            }
          }
        );

        if (payload.parts) {
          for (
            const part
            of payload.parts
          ) {
            if (
              part.mimeType ===
              'text/plain'
            ) {
              body =
                Buffer.from(
                  part.body.data,
                  'base64'
                ).toString(
                  'utf8'
                );

              break;
            }
          }
        } else if (
          payload.body &&
          payload.body.data
        ) {
          body =
            Buffer.from(
              payload.body.data,
              'base64'
            ).toString('utf8');
        }

        if (
          !body &&
          payload.parts
        ) {
          for (
            const part
            of payload.parts
          ) {
            if (
              part.mimeType ===
              'text/html'
            ) {
              body =
                Buffer.from(
                  part.body.data,
                  'base64'
                )
                  .toString(
                    'utf8'
                  )
                  .replace(
                    /<[^>]*>/g,
                    ' '
                  )
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim();

              break;
            }
          }
        }

        const sender =
          headers.find(
            (header) =>
              header.name ===
              'From'
          )?.value || '';

        if (
          sender.includes(
            'YES BANK'
          ) ||
          sender.includes(
            'yesbank'
          ) ||
          sender.includes(
            'syes.bank.in'
          )
        ) {
          const parsed =
            parseYesBankEmail(
              subject,
              body
            );

          if (
            parsed.amount &&
            parsed.merchant
          ) {
            const existing =
              await prisma.pendingImport.findFirst({
                where: {
                  userId,

                  sourceId:
                    message.id,

                  source:
                    'GMAIL_YESBANK',
                },
              });

            if (!existing) {
              await prisma.pendingImport.create({
                data: {
                  userId,

                  amount:
                    parsed.amount,

                  date:
                    new Date(
                      parseInt(
                        msgData
                          .data
                          .internalDate
                      )
                    ),

                  merchant:
                    parsed.merchant,

                  note:
                    subject,

                  source:
                    'GMAIL_YESBANK',

                  sourceId:
                    message.id,

                  status:
                    'pending',
                },
              });
            }
          }

          continue;
        }

        let amountMatch =
          body.match(
            /(?:Rs|₹|INR)\s*([\d,]+(?:\.\d{2})?)/i
          );

        if (!amountMatch) {
          amountMatch =
            body.match(
              /([\d,]+\.\d{2})\s*(?:was paid|paid|spent)/i
            );
        }

        if (!amountMatch) {
          amountMatch =
            subject.match(
              /(?:Rs|₹|INR)\s*([\d,]+(?:\.\d{2})?)/i
            );
        }

        if (!amountMatch) {
          continue;
        }

        const amount =
          parseFloat(
            amountMatch[1].replace(
              /,/g,
              ''
            )
          );

        const subjectLower =
          subject.toLowerCase();

        const bodyLower =
          body.toLowerCase();

        const skipKeywords = [
          'cashback',
          'refund',
          'delivery',
          'order has been received',
          'delivered',
          'received',
        ];

        if (
          skipKeywords.some(
            (keyword) =>
              subjectLower.includes(
                keyword
              ) ||
              bodyLower.includes(
                keyword
              )
          )
        ) {
          continue;
        }

        const existing =
          await prisma.expense.findFirst({
            where: {
              userId,
              amount,

              note: {
                contains: subject,
              },

              date: {
                gte:
                  sevenDaysAgo,
              },
            },
          });

        if (existing) {
          continue;
        }

        let merchantName =
          'Unknown';

        if (
          sender.includes(
            'amazonpay'
          )
        ) {
          merchantName =
            'Amazon Pay';
        } else if (
          sender.includes(
            'amazon'
          )
        ) {
          merchantName =
            'Amazon';
        } else if (
          sender.includes(
            'swiggy'
          )
        ) {
          merchantName =
            'Swiggy';
        } else if (
          sender.includes(
            'zomato'
          )
        ) {
          merchantName =
            'Zomato';
        } else if (
          sender.includes(
            'uber'
          )
        ) {
          merchantName =
            'Uber';
        } else if (
          sender.includes(
            'flipkart'
          )
        ) {
          merchantName =
            'Flipkart';
        } else if (
          sender.includes(
            'icici'
          )
        ) {
          merchantName =
            'ICICI Bank';
        } else if (
          sender.includes(
            'yesbank'
          )
        ) {
          merchantName =
            'YES Bank';
        }

        const resolvedMerchant =
          await resolveMerchantAlias(
            userId,
            merchantName
          );

        await prisma.expense.create({
          data: {
            amount,

            date:
              new Date(
                parseInt(
                  msgData
                    .data
                    .internalDate
                )
              ),

            note:
              `Auto-import: ${subject}`,

            merchant:
              resolvedMerchant,

            isRecurring: false,
            type: 'EXPENSE',

            userId,

            categoryId:
              defaultCategory.id,
          },
        });

        await upsertManagedMerchant(
          userId,
          resolvedMerchant
        );

        importedCount++;
      } catch (error) {
        console.error(
          `❌ Error processing email ${message.id}:`,
          error.message
        );
      }
    }

    console.log(
      `📊 Imported ${importedCount} new expenses.`
    );
  };

app.get(
  '/api/auth/gmail',
  authenticateToken,
  (req, res) => {
    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type: 'offline',

        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
        ],

        prompt: 'consent',

        state:
          req.user.id,

        redirect_uri:
          process.env
            .GOOGLE_REDIRECT_URI,
      });

    res.json({
      authUrl,
    });
  }
);

app.get(
  '/api/auth/gmail/callback',
  async (req, res) => {
    const {
      code,
      state,
    } = req.query;

    if (!code || !state) {
      return res
        .status(400)
        .send(
          'Missing code or user ID'
        );
    }

    try {
      const {
        tokens,
      } =
        await oauth2Client.getToken(
          code
        );

      await prisma.user.update({
        where: {
          id: state,
        },
        data: {
          gmailRefreshToken:
            tokens.refresh_token,
        },
      });

      res.send(
        'Gmail connected successfully! You can close this tab.'
      );
    } catch (error) {
      console.error(
        'Gmail OAuth error:',
        error
      );

      res.status(500).send(
        'Failed to connect Gmail.'
      );
    }
  }
);

app.get(
  '/api/auth/gmail/status',
  authenticateToken,
  async (req, res) => {
    try {
      const user =
        await prisma.user.findUnique({
          where: {
            id: req.user.id,
          },
          select: {
            gmailRefreshToken:
              true,
          },
        });

      res.json({
        connected:
          !!user?.gmailRefreshToken,
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to check Gmail status',
      });
    }
  }
);

app.post(
  '/api/gmail/sync',
  authenticateToken,
  async (req, res) => {
    try {
      await processGmailReceipts(
        req.user.id
      );

      res.json({
        message:
          'Gmail sync completed successfully!',
      });
    } catch (error) {
      console.error(
        'Manual sync error:',
        error
      );

      res.status(500).json({
        error:
          'Sync failed. Check logs for details.',
      });
    }
  }
);

// ==========================================
// 13. PENDING IMPORTS
// ==========================================

app.get(
  '/api/pending',
  authenticateToken,
  async (req, res) => {
    try {
      const pending =
        await prisma.pendingImport.findMany({
          where: {
            userId: req.user.id,
            status: 'pending',
          },

          orderBy: {
            date: 'desc',
          },

          include: {
            category: true,
          },
        });

      res.json(pending);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to fetch pending imports.',
      });
    }
  }
);

app.put(
  '/api/pending/:id',
  authenticateToken,
  async (req, res) => {
    const {
      amount,
      merchant,
      date,
      note,
      categoryId,
    } = req.body;

    try {
      const pending =
        await prisma.pendingImport.update({
          where: {
            id: req.params.id,
            userId: req.user.id,
          },

          data: {
            amount:
              parseFloat(amount),

            merchant,

            date:
              new Date(date),

            note,

            categoryId:
              categoryId || null,
          },

          include: {
            category: true,
          },
        });

      res.json(pending);
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to update pending import.',
      });
    }
  }
);

app.delete(
  '/api/pending/:id',
  authenticateToken,
  async (req, res) => {
    try {
      await prisma.pendingImport.delete({
        where: {
          id: req.params.id,
          userId: req.user.id,
        },
      });

      res.json({
        message:
          'Pending import deleted.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          'Failed to delete pending import.',
      });
    }
  }
);

app.post(
  '/api/pending/:id/confirm',
  authenticateToken,
  async (req, res) => {
    const {
      categoryId,
    } = req.body;

    try {
      const pending =
        await prisma.pendingImport.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
            status: 'pending',
          },
        });

      if (!pending) {
        return res.status(404).json({
          error:
            'Pending import not found.',
        });
      }

      let finalCategoryId =
        categoryId ||
        pending.categoryId;

      if (!finalCategoryId) {
        const fallback =
          await getUserDefaultCategory(
            req.user.id
          );

        finalCategoryId =
          fallback.id;
      }

      const resolvedMerchant =
        pending.merchant
          ? await resolveMerchantAlias(
              req.user.id,
              pending.merchant
            )
          : null;

      const expense =
        await prisma.expense.create({
          data: {
            amount:
              pending.amount,

            date:
              pending.date,

            note:
              pending.note ||
              pending.merchant,

            merchant:
              resolvedMerchant,

            categoryId:
              finalCategoryId,

            userId:
              req.user.id,

            isRecurring: false,
            type: 'EXPENSE',
          },
        });

      if (resolvedMerchant) {
        await upsertManagedMerchant(
          req.user.id,
          resolvedMerchant
        );
      }

      await prisma.pendingImport.update({
        where: {
          id: pending.id,
        },
        data: {
          status: 'confirmed',
        },
      });

      res.json({
        message:
          'Expense created from pending import.',
        expense,
      });
    } catch (error) {
      console.error(
        'Confirm error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to confirm pending import.',
      });
    }
  }
);

// ==========================================
// 14. PING + START
// ==========================================

app.get(
  '/ping',
  (req, res) =>
    res.status(200).json({
      status: 'ok',
      timestamp:
        new Date().toISOString(),
    })
);

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Email configured for: ${process.env.EMAIL_USER}`
  );

  console.log(
    'Recurring job scheduled for 00:05 IST daily.'
  );
});
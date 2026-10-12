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
const {
  signSessionToken,
  signResetToken,
  isSessionPayload,
  isResetPayload,
  isSessionVersionCurrent,
  decideSession,
  SESSION_DECISION,
  passwordFingerprint,
  fingerprintsMatch,
  validateNewPassword,
  buildResetConsumeArgs,
} = require('./lib/auth-tokens');
const {
  isSupportedFrequency,
  computeNextExecution,
  listDuePeriods,
  periodKey,
} = require('./lib/schedule');
const {
  monthRange,
  monthRangeForInstant,
  appLocalDateString,
  previousMonthLabel,
  shiftMonths,
  isWithin,
  rangeFromQueryParams,
} = require('./lib/dateRange');
const { buildExpenseCsv } = require('./lib/csv');
const {
  planResetRequest,
  planResetDelivery,
} = require('./lib/auth-responses');
const {
  authorizeCategory,
} = require('./lib/authorization');
const {
  buildAmortizationSchedule,
  computePaymentAllocation,
  outstandingBalance,
  remainingTenure,
  prepaymentSavings,
  rateChangeImpact,
  summarizeLoan,
  deriveEmiIfMissing,
  validateLoanInput,
  addMonthsClamped,
  monthsBetween,
  toPaise,
  fromPaise,
  num,
} = require('./lib/loans');

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

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Access denied. No token provided.',
    });
  }

  let payload;

  try {
    payload = jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid or expired token.',
    });
  }

  // P0-2: a password-reset token must never authenticate an API request.
  // Pre-P0-2 a reset link was a fully valid Bearer token for its whole TTL.
  // Legacy session tokens carry no `purpose` claim and are still accepted.
  if (!isSessionPayload(payload)) {
    return res.status(401).json({
      error: 'Invalid or expired token.',
    });
  }

  // P0-2 Phase B: session revocation. A password change increments the user's
  // tokenVersion, so every token issued under an older version is rejected.
  // This is the one place a per-request database read is now required; it is
  // an indexed primary-key lookup selecting a single column.
  let account;

  try {
    account = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { tokenVersion: true },
    });
  } catch (error) {
    // A database failure is NOT an authentication failure: returning 401 here
    // would log every user out during an outage. Fail closed WITHOUT letting the
    // request through, but report it as unavailable.
    console.error(
      'Token-version lookup failed:',
      error
    );
    return res.status(500).json({
      error: 'Authentication temporarily unavailable.',
    });
  }

  // Covers a deleted account, a disabled account (if that column is ever added)
  // and a revoked session, all in one tested decision function.
  const decision = decideSession(
    payload,
    account
  );

  if (decision !== SESSION_DECISION.OK) {
    return res.status(401).json({
      error: 'Invalid or expired token.',
    });
  }

  req.user = payload;
  next();
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
,
  client
) => {
  const db = client || prisma;
  const name = normaliseMerchant(inputName);

  if (!name) {
    return null;
  }

  const match = await db.merchant.findFirst({
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
,
  client
) => {
  const db = client || prisma;
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
    await db.merchant.upsert({
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

/**
 * P0-8: the Prisma-backed lookup behind authorizeCategory. It MUST filter by
 * userId; the helper is what enforces the decision, this is only the query.
 */
const findOwnedCategory = (args) =>
  prisma.category.findFirst({
    where: {
      id: args.id,
      userId: args.userId,
    },
    select: {
      id: true,
      userId: true,
      type: true,
    },
  });

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

    const token = signSessionToken(
      user,
      process.env.JWT_SECRET
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

    const token = signSessionToken(
      user,
      process.env.JWT_SECRET
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

      // P0 (A-2): every outcome maps to one identical public response, so the
      // response cannot reveal whether the address is registered. The decision
      // lives in src/lib/auth-responses.js so it is executable-testable.
      const plan = planResetRequest({
        userExists: Boolean(user),
      });

      if (!plan.shouldSendMail) {
        // No mail is sent; the attempt is logged server-side without the
        // address, and the public response is byte-identical to the success
        // case.
        console.warn(
          'Password reset requested for an unknown email address.'
        );
        return res.json(plan.response);
      }

      // P0-2: typed, short-lived, and bound to the password hash in force at
      // issue time, so the link is spent as soon as the password changes.
      const resetToken = signResetToken(
        user,
        process.env.JWT_SECRET
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
          `This link expires in 15 minutes.</p>`,
      });

      res.json(plan.response);
    } catch (error) {
      // A delivery failure must not distinguish a registered address from an
      // unknown one, so the requester still receives the identical generic
      // response; only the server-side log level changes. No address is logged.
      const outcome = planResetDelivery({
        mailError: error,
      });

      console.error(
        'Password reset email delivery failed:',
        error
      );

      res.json(outcome.response);
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

      // P0-2: password strength was previously not validated at all.
      const passwordError =
        validateNewPassword(newPassword);

      if (passwordError) {
        return res.status(400).json({
          error: passwordError,
        });
      }

      let decoded;

      try {
        decoded = jwt.verify(
          token,
          process.env.JWT_SECRET
        );
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid or expired token.',
        });
      }

      // P0-2: only a token explicitly issued for password reset is accepted
      // here. Pre-P0-2 any valid JWT worked, so a stolen session token could
      // be replayed to overwrite the password.
      if (!isResetPayload(decoded)) {
        return res.status(400).json({
          error: 'Invalid or expired token.',
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, password: true },
      });

      if (!user) {
        return res.status(400).json({
          error: 'Invalid or expired token.',
        });
      }

      // P0-2: the token is bound to the password hash that was in force when
      // it was issued. Once the password changes, outstanding links are spent.
      const currentFingerprint =
        passwordFingerprint(
          user.password,
          process.env.JWT_SECRET
        );

      if (
        !fingerprintsMatch(
          currentFingerprint,
          decoded.pwd
        )
      ) {
        return res.status(400).json({
          error: 'Invalid or expired token.',
        });
      }

      const hashed =
        await bcrypt.hash(
          newPassword,
          10
        );

      // P0-2: single-use is enforced atomically. updateMany() puts the stored
      // digest in the WHERE clause, so UPDATE ... WHERE id = ? AND password = ?
      // can match for exactly one concurrent request; every other sees
      // count === 0 and is rejected as a spent token.
      const consumeArgs =
        buildResetConsumeArgs(
          user.id,
          user.password,
          hashed
        );

      const consumed =
        await prisma.user.updateMany(
          consumeArgs
        );

      if (consumed.count === 0) {
        return res.status(400).json({
          error: 'Invalid or expired token.',
        });
      }

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { requireValue: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { rejectNull: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
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

      // P0-6: RFC 4180 quoting, a formula-injection guard, and
      // application-local calendar dates so auto-created rows are no longer
      // exported one day early. Commas are preserved rather than rewritten into
      // semicolons, and a category name containing a comma can no longer inject
      // an extra column.
      const csv =
        buildExpenseCsv(
          expenses,
          (expense) =>
            appLocalDateString(
              expense.date
            )
        );

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

      // P0-6A: one shared, validated, half-open window for the selected month
      // and for the previous month. Both the database query below and the
      // in-memory filters derive from these objects, so they cannot disagree.
      const window = month
        ? monthRange(month)
        : monthRangeForInstant(new Date());

      if (!window) {
        return res.status(400).json({
          error: 'Invalid month. Expected YYYY-MM.',
        });
      }

      const prevWindow = monthRange(
        previousMonthLabel(window.label)
      );

      // Business logic preserved: the all-time figures remain a rolling
      // 12-month lookback from now. Only the arithmetic is hardened, because
      // setMonth(getMonth() - 12) on 29 February drifts to 1 March.
      const twelveMonthCutoff = shiftMonths(
        new Date(),
        -12
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
              gte: twelveMonthCutoff,
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

        if (isWithin(window, expense.date)) {
          merchant.monthSpent +=
            amount;

          merchant.monthCount += 1;
        }

        if (isWithin(prevWindow, expense.date)) {
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
        month: window.label,
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

      // P0-6: shared validated window; invalid input is a 400.
      if (month) {
        const window = monthRange(month);

        if (!window) {
          return res.status(400).json({
            error: 'Invalid month. Expected YYYY-MM.',
          });
        }

        where.date = {
          gte: window.start,
          lt: window.end,
        };
      } else {
        // P0-6B: validated custom range. A calendar end date is inclusive to the
        // user, so the internal bound becomes the exclusive start of the next
        // day; previously `lte: new Date(endDate)` silently dropped the whole
        // end day. Malformed or impossible dates are a 400, not a 500.
        const custom = rangeFromQueryParams({
          startDate,
          endDate,
        });

        if (!custom.ok) {
          return res.status(400).json({
            error: custom.error,
          });
        }

        if (custom.dateFilter) {
          where.date = custom.dateFilter;
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

      // P0-6: one shared, validated, half-open window. An invalid month is a
      // 400, not a 500 from an Invalid Date, and out-of-range months are
      // rejected instead of silently rolling over.
      const window = month
        ? monthRange(month)
        : monthRangeForInstant(new Date());

      if (!window) {
        return res.status(400).json({
          error: 'Invalid month. Expected YYYY-MM.',
        });
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
              gte: window.start,
              lt: window.end,
            },
          },
        }),

        prisma.expense.findMany({
          where: {
            userId: req.user.id,
            type: 'EXPENSE',
            date: {
              gte: window.start,
              lt: window.end,
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
              gte: window.start,
              lt: window.end,
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
          window.label,

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { requireValue: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { rejectNull: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { requireValue: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-4: one shared allowlist, used identically on create and update.
      if (!isSupportedFrequency(frequency)) {
        return res.status(400).json({
          error: 'Invalid frequency.',
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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId,
        { rejectNull: true }
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-4: PUT previously accepted ANY frequency string, which is how an
      // unsupported value reached the scheduler and duplicated the expense on
      // every run. Validating the resolved value also means a rule can never be
      // saved with an unusable schedule.
      if (!isSupportedFrequency(newFrequency)) {
        return res.status(400).json({
          error: 'Invalid frequency.',
        });
      }

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
  async (options = {}) => {
    // P0-5C.1a: injectable Prisma client and clock so tests can run genuinely
    // independent workers. Defaults preserve production behaviour exactly.
    const db = options.prisma || prisma;
    console.log(
      '🔄 Running recurring job...'
    );

    const today = options.now ? new Date(options.now) : new Date();

    today.setHours(
      0,
      0,
      0,
      0
    );

    const rules =
      await db.recurringRule.findMany({
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

        // P0-5: advance from the rule's OWN nextExecution rather than from
        // "today", and materialise every period that has come due (bounded by
        // the documented catch-up cap) instead of silently dropping them.
        const due = listDuePeriods(
          rule.frequency,
          rule.dayOfMonth,
          rule.dayOfWeek,
          rule.nextExecution,
          today
        );

        // P0-4: an unusable schedule is skipped and reported. Previously an
        // unsupported frequency fell through the scheduler, which left
        // nextExecution at today and re-fired the rule on every run, creating a
        // duplicate expense indefinitely.
        if (due.invalid) {
          console.error(
            `Skipping recurring rule ${rule.id}: unusable schedule ` +
              `(frequency="${rule.frequency}")`
          );
          continue;
        }

        if (due.periods.length === 0) {
          continue;
        }

        const rawMerchant =
          normaliseMerchant(
            rule.description
          );

        const normMerchant =
          rawMerchant
            ? await resolveMerchantAlias(
                rule.userId,
                rawMerchant,
                db
              )
            : rawMerchant;

        // P0-5A: keep the EXACT timestamp read from PostgreSQL for the
        // concurrency claim, and keep the calendar occurrence date separate.
        // Previously the normalised calendar date was used as the claim key, so
        // any stored value that was not already at local midnight never matched:
        // the claim returned 0, nothing was created and the rule never advanced.
        //
        // `expectedStored` is chained: the first iteration claims on the value as
        // read, and each successful claim sets it to the value just written. A
        // row stored under an older convention is therefore converted on its
        // first successful claim, without touching historical financial records.
        let expectedStored = rule.nextExecution;

        for (const period of due.periods) {
          // Advance from the STORED value; computeNextExecution normalises
          // internally, so the resulting calendar date stays correct.
          const nextExec =
            computeNextExecution(
              rule.frequency,
              rule.dayOfMonth,
              rule.dayOfWeek,
              expectedStored
            );

          if (!nextExec) {
            console.error(
              `Skipping recurring rule ${rule.id}: cannot advance past ` +
                `${expectedStored.toISOString()}`
            );
            break;
          }

          // Idempotency across retries AND concurrent executions.
          //
          // updateMany() puts the stored nextExecution in the WHERE clause, so
          // the claim only matches while it still equals the value this worker
          // read. Of two concurrent runs, exactly one claims each period and the
          // other receives count === 0 and skips it.
          //
          // The claim and the expense are written in ONE transaction, so a
          // failure to insert rolls the claim back rather than losing the
          // period. That makes this at-most-once (no duplicates) WITHOUT being
          // at-most-once-and-lossy.
          const created = await db.$transaction(
            async (tx) => {
              const claim =
                await tx.recurringRule.updateMany({
                  where: {
                    id: rule.id,
                    nextExecution: expectedStored,
                    isActive: true,
                  },
                  data: {
                    nextExecution: nextExec,
                  },
                });

              if (claim.count === 0) {
                return null;
              }

              return tx.expense.create({
                data: {
                  amount: rule.amount,

                  // Dated at the period it was DUE, not at the run date, so a
                  // catch-up entry lands in the correct month.
                  date: period,

                  note:
                    `${rule.description} ` +
                    '(Auto - Recurring)',

                  merchant: normMerchant,

                  isRecurring: true,

                  type: entryType,

                  userId: rule.userId,

                  categoryId: rule.categoryId,
                },
              });
            }
          );

          if (created) {
            expectedStored = nextExec;
            console.log(
              `✅ Auto-created ${entryType} ` +
                `for "${rule.description}" (${periodKey(period)})`
            );
          } else {
            // P0-5A diagnostics: never silently treat an unmatched claim as
            // successful processing. Distinguish an expected concurrency
            // conflict from an unexpected timestamp mismatch, and log only
            // identifiers and timestamps - never amounts or other financial
            // detail.
            const current = await db.recurringRule.findUnique({
              where: { id: rule.id },
              select: { nextExecution: true },
            });
            const movedOn =
              current &&
              current.nextExecution.getTime() !== expectedStored.getTime();

            if (movedOn) {
              console.warn(
                `ℹ️ Recurring rule ${rule.id}: occurrence already claimed ` +
                  `(expected ${expectedStored.toISOString()}, stored ` +
                  `${current.nextExecution.toISOString()}).`
              );
            } else {
              console.warn(
                `⚠️ Recurring rule ${rule.id}: claim matched no row while the ` +
                  `stored nextExecution is unchanged ` +
                  `(expected ${expectedStored.toISOString()}) - occurrence NOT ` +
                  `created; likely a timestamp-convention mismatch.`
              );
            }
            // Stop rather than burning through the remaining catch-up periods
            // against a claim that cannot match. The occurrence stays eligible,
            // so a later run retries it safely.
            break;
          }
        }

        if (normMerchant) {
          await upsertManagedMerchant(
            rule.userId,
            normMerchant,
            db
          );
        }

        if (due.hasMore) {
          console.warn(
            `⚠️ Recurring rule ${rule.id} is further behind than the ` +
              `catch-up cap; the remaining periods will be created on the next run.`
          );
        }
      } catch (error) {
        console.error(
          `❌ Failed to process recurring rule ${rule.id}:`,
          error
        );
      }
    }
  };

// P0-7 integration testing: schedulers must not start when the module is merely
// imported by a test, and a test may disable them explicitly. In normal
// operation (node src/server.js) both guards pass and behaviour is unchanged.
const SCHEDULERS_DISABLED = process.env.DISABLE_SCHEDULERS === 'true';

if (!SCHEDULERS_DISABLED) {
  cron.schedule(
    '30 18 * * *',
    processRecurringExpenses
  );

  setTimeout(
    processRecurringExpenses,
    10000
  );
}

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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

      // P0-8: the category must belong to the authenticated user. A foreign id
      // and a nonexistent one both yield the same 400, so the response cannot be
      // used to probe for another user's categories.
      const categoryCheck = await authorizeCategory(
        findOwnedCategory,
        req.user.id,
        categoryId
      );

      if (!categoryCheck.ok) {
        return res
          .status(categoryCheck.status)
          .json({
            error: categoryCheck.error,
          });
      }

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
// 13b. LOANS
// ==========================================
//
// Loan Tracker (P0-9). The mathematics lives in src/lib/loans.js; this section
// is only HTTP plumbing, ownership and persistence.
//
// Ownership rule (the P0-8 lesson): `LoanPayment` carries no `userId`, so every
// payment route resolves the PARENT loan with `{ id, userId: req.user.id }`
// first and only then looks up the payment by `{ id, loanId }`. A payment id on
// its own is never trusted, and a loan id on its own is never trusted either.
//
// Two invariants this section maintains:
//   1. Forecasts are never persisted. Schedules, payoff dates and prepayment
//      savings are computed on demand from src/lib/loans.js.
//   2. `Loan.currentPrincipal` is always RECOMPUTED from the payment history
//      rather than incremented, so it cannot drift away from the ledger.
//
// Decision A (final): recording a loan payment never creates an `Expense` row.
// `LoanPayment` is the single source of truth for actual loan payments.

const LOAN_PAYMENT_KINDS = ['EMI', 'PREPAYMENT', 'PART_PAYMENT', 'ADJUSTMENT'];

const loanNotFound = (res) => res.status(404).json({ error: 'Loan not found.' });

/** Date of the final row of a schedule, or null when there is nothing left to pay. */
const lastScheduleDateOf = (schedule) => {
  const rows = (schedule && schedule.rows) || [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].date) return rows[index].date;
  }
  return null;
};

const paymentNotFound = (res) => res.status(404).json({ error: 'Payment not found.' });

/** Resolve a loan the caller owns. Never trusts a bare id. */
const findOwnedLoan = (userId, loanId) =>
  prisma.loan.findFirst({
    where: { id: loanId, userId },
  });

const decimalToNumber = (value) =>
  value === null || value === undefined ? null : Number(value);

/** Contractual tenure in months when the loan states both dates. */
const contractualMonths = (loan) => {
  const months = monthsBetween(loan.startDate, loan.endDate);
  return months > 0 ? months : null;
};

/** Never expose raw Decimal objects (they serialise as strings). */
const serializeLoan = (loan) => ({
  id: loan.id,
  name: loan.name,
  lender: loan.lender,
  loanType: loan.loanType,
  originalPrincipal: decimalToNumber(loan.originalPrincipal),
  currentPrincipal: decimalToNumber(loan.currentPrincipal),
  interestRate: decimalToNumber(loan.interestRate),
  emiAmount: decimalToNumber(loan.emiAmount),
  startDate: loan.startDate,
  endDate: loan.endDate,
  emiDay: loan.emiDay,
  isActive: loan.isActive,
  paymentAccountId: loan.paymentAccountId,
  createdAt: loan.createdAt,
  updatedAt: loan.updatedAt,
});

const serializePayment = (payment) => ({
  id: payment.id,
  loanId: payment.loanId,
  date: payment.date,
  totalAmount: decimalToNumber(payment.totalAmount),
  principalAmount: decimalToNumber(payment.principalAmount),
  interestAmount: decimalToNumber(payment.interestAmount),
  extraPrincipal: decimalToNumber(payment.extraPrincipal),
  outstandingAfter: decimalToNumber(payment.outstandingAfter),
  note: payment.note,
  createdAt: payment.createdAt,
});

/** An optional paymentAccountId must belong to the caller. */
const ownedAccountExists = async (userId, accountId) => {
  if (!accountId) return true;
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  return Boolean(account);
};

/**
 * Recompute every `outstandingAfter` and the loan's `currentPrincipal` from the
 * immutable ledger, oldest payment first.
 *
 * The starting balance is recovered from the FIRST payment
 * (`outstandingAfter + principal + extra`), which preserves a loan imported
 * mid-term: such a loan opens below its original principal and the ledger anchor
 * must stay there. With no payments at all the loan simply sits at its original
 * principal.
 */
const ledgerAnchorPaise = (loan, orderedPayments) => {
  const first = orderedPayments.length > 0 ? orderedPayments[0] : null;
  if (!first || first.outstandingAfter === null || first.outstandingAfter === undefined) {
    return toPaise(loan.originalPrincipal);
  }
  // outstandingAfter = opening - principal - extra, so this sum IS the opening
  // balance the ledger started from. It is algebraically invariant under
  // resync, which is what makes recomputation safe to repeat.
  return toPaise(first.outstandingAfter) + toPaise(first.principalAmount) + toPaise(first.extraPrincipal);
};

/**
 * The balance immediately BEFORE a payment dated `cutover`.
 *
 * Only payments that precede it may reduce the balance. Subtracting a LATER
 * payment's principal (which `outstandingBalance` does, since it sums the whole
 * history) would compute the opening balance for the wrong point in the ledger
 * and produce a split for an impossible balance.
 *
 * `orderedPayments` must be the FULL ledger, oldest first, INCLUDING `excludeId`.
 * The anchor is read from the first row, and `outstandingAfter + principal +
 * extra` is algebraically invariant under a change to that row's own split, so
 * this stays correct even while the first payment is being edited. Reading the
 * anchor from a list that already had the edited row removed would instead
 * recover the opening balance of whichever row became first — a real defect that
 * produced a split for an impossible balance.
 *
 * @param {object} loan
 * @param {Array} orderedPayments every existing payment, oldest first
 * @param {Date} cutover when the payment being computed takes effect
 * @param {string|null} excludeId a payment to ignore when summing (the row being edited)
 */
const openingBalanceBefore = (loan, orderedPayments, cutover, excludeId = null) => {
  const cutoverMs = new Date(cutover).getTime();
  let reductionPaise = 0;

  for (const payment of orderedPayments) {
    if (excludeId !== null && payment.id === excludeId) continue;
    if (new Date(payment.date).getTime() < cutoverMs) {
      reductionPaise += toPaise(payment.principalAmount) + toPaise(payment.extraPrincipal);
    }
  }

  return fromPaise(Math.max(0, ledgerAnchorPaise(loan, orderedPayments) - reductionPaise));
};

const resyncLoanLedger = async (loan, client = prisma) => {
  const payments = await client.loanPayment.findMany({
    where: { loanId: loan.id },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });

  if (payments.length === 0) {
    const currentPrincipal = Number(loan.originalPrincipal);
    if (toPaise(loan.currentPrincipal) !== toPaise(currentPrincipal)) {
      await client.loan.update({ where: { id: loan.id }, data: { currentPrincipal } });
    }
    return { payments, currentPrincipal };
  }

  let balancePaise = ledgerAnchorPaise(loan, payments);

  for (const payment of payments) {
    balancePaise -= toPaise(payment.principalAmount) + toPaise(payment.extraPrincipal);
    if (balancePaise < 0) balancePaise = 0;
    const outstandingAfter = fromPaise(balancePaise);
    if (toPaise(payment.outstandingAfter) !== toPaise(outstandingAfter)) {
      await client.loanPayment.update({
        where: { id: payment.id },
        data: { outstandingAfter },
      });
      payment.outstandingAfter = outstandingAfter;
    }
  }

  const currentPrincipal = fromPaise(balancePaise);
  if (toPaise(loan.currentPrincipal) !== toPaise(currentPrincipal)) {
    await client.loan.update({ where: { id: loan.id }, data: { currentPrincipal } });
  }

  return { payments, currentPrincipal };
};

/** The next EMI due date, or null when the loan does not state a day. */
const nextEmiDateFor = (loan, payments = []) => {
  if (loan.isActive === false) return null;
  const start = loan.startDate ? new Date(loan.startDate) : null;
  const day = loan.emiDay || (start ? start.getDate() : null);
  if (!day) return null;

  const now = new Date();
  const lastPaid = payments.length ? new Date(payments[payments.length - 1].date) : null;
  const from = lastPaid && lastPaid.getTime() > now.getTime() ? lastPaid : now;

  const lastDayThisMonth = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
  const thisMonth = new Date(from.getFullYear(), from.getMonth(), Math.min(day, lastDayThisMonth));
  if (thisMonth.getTime() > from.getTime()) return thisMonth;
  return addMonthsClamped(thisMonth, 1);
};

/**
 * Attach actual payments to the periods of a lifetime schedule.
 * A row is PAID / PARTIAL / FORECAST, so the UI can style history and forecast
 * differently without a second source of truth.
 */
const annotateSchedule = (rows, payments) => {
  if (rows.length === 0) return [];

  const buckets = rows.map(() => []);
  for (const payment of payments) {
    const when = new Date(payment.date).getTime();
    // A payment belongs to the period it falls INSIDE: the last due date that is
    // not after the payment. A payment made before the first due date (an
    // up-front prepayment) is charged to period 1.
    let index = 0;
    for (let row = 0; row < rows.length; row += 1) {
      if (rows[row].date && new Date(rows[row].date).getTime() <= when) index = row;
    }
    buckets[index].push(payment);
  }

  return rows.map((row, index) => {
    const group = buckets[index];
    if (group.length === 0) {
      return { ...row, status: 'FORECAST', actual: null };
    }

    const sum = (key) => group.reduce((total, p) => total + toPaise(p[key]), 0);
    const actualPrincipal = sum('principalAmount');
    const actualExtra = sum('extraPrincipal');
    const actualInterest = sum('interestAmount');
    const plannedPaise = toPaise(row.principal) + toPaise(row.extraPrincipal);
    const paidPaise = actualPrincipal + actualExtra;

    return {
      ...row,
      status: paidPaise >= plannedPaise && plannedPaise > 0 ? 'PAID' : paidPaise > 0 ? 'PARTIAL' : 'UNPAID',
      actual: {
        totalAmount: fromPaise(sum('totalAmount')),
        principalAmount: fromPaise(actualPrincipal),
        interestAmount: fromPaise(actualInterest),
        extraPrincipal: fromPaise(actualExtra),
        count: group.length,
        date: group[group.length - 1].date,
        paymentIds: group.map((p) => p.id),
      },
    };
  });
};

/** Loan + payments, in the shape every read route returns. */
const loadLoanContext = async (userId, loanId) => {
  const loan = await findOwnedLoan(userId, loanId);
  if (!loan) return null;

  const payments = await prisma.loanPayment.findMany({
    where: { loanId: loan.id },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });

  return { loan, payments };
};

// ---- list ----------------------------------------------------------------

app.get(
  '/api/loans',
  authenticateToken,
  async (req, res) => {
    try {
      const loans = await prisma.loan.findMany({
        where: { userId: req.user.id },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        include: { payments: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] } },
      });

      const activeFilter = req.query.active;
      const filtered = activeFilter === undefined
        ? loans
        : loans.filter((loan) => String(loan.isActive) === String(activeFilter));

      res.json(
        filtered.map((loan) => ({
          ...serializeLoan(loan),
          summary: summarizeLoan(loan, loan.payments),
          nextEmiDate: nextEmiDateFor(loan, loan.payments),
        }))
      );
    } catch (error) {
      console.error('Fetch loans error:', error);
      res.status(500).json({ error: 'Failed to fetch loans.' });
    }
  }
);

// ---- create --------------------------------------------------------------

app.post(
  '/api/loans',
  authenticateToken,
  async (req, res) => {
    try {
      const validation = validateLoanInput(req.body, { requireAll: true });
      if (!validation.ok) {
        return res.status(400).json({ error: validation.errors[0], errors: validation.errors });
      }

      const input = validation.value;

      if (!(await ownedAccountExists(req.user.id, input.paymentAccountId))) {
        return res.status(400).json({ error: 'Payment account not found.' });
      }

      const originalPrincipal = input.originalPrincipal;
      const currentPrincipal =
        input.currentPrincipal === undefined ? originalPrincipal : input.currentPrincipal;

      if (currentPrincipal > originalPrincipal) {
        return res.status(400).json({
          error: 'Current principal cannot exceed the original principal.',
        });
      }

      const interestRate = input.interestRate === undefined ? 0 : input.interestRate;

      // Fill in a missing EMI from the stated tenure, rounding UP so the derived
      // instalment actually clears that tenure instead of landing one period late.
      const emiAmount =
        input.emiAmount === undefined || input.emiAmount === null
          ? deriveEmiIfMissing({
              originalPrincipal,
              interestRate,
              startDate: input.startDate,
              endDate: input.endDate,
            })
          : input.emiAmount;

      // An EMI without an end date still implies one; derive it so the schedule
      // has a contractual tenure to close against.
      let endDate = input.endDate ?? null;
      if (!endDate && input.startDate && emiAmount) {
        const months = remainingTenure(currentPrincipal, interestRate, emiAmount);
        if (months && months > 0) endDate = addMonthsClamped(input.startDate, months);
      }

      const loan = await prisma.loan.create({
        data: {
          name: input.name,
          lender: input.lender ?? null,
          loanType: input.loanType ?? 'HOME_LOAN',
          originalPrincipal,
          currentPrincipal,
          interestRate,
          emiAmount: emiAmount ?? null,
          startDate: input.startDate ?? null,
          endDate,
          emiDay: input.emiDay ?? null,
          isActive: input.isActive === undefined ? true : input.isActive,
          paymentAccountId: input.paymentAccountId ?? null,
          userId: req.user.id,
        },
      });

      res.status(201).json({
        ...serializeLoan(loan),
        summary: summarizeLoan(loan, []),
        nextEmiDate: nextEmiDateFor(loan, []),
      });
    } catch (error) {
      console.error('Create loan error:', error);
      res.status(500).json({ error: 'Failed to create loan.' });
    }
  }
);

// ---- detail --------------------------------------------------------------

app.get(
  '/api/loans/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const context = await loadLoanContext(req.user.id, req.params.id);
      if (!context) return loanNotFound(res);

      const { loan, payments } = context;
      res.json({
        ...serializeLoan(loan),
        summary: summarizeLoan(loan, payments),
        nextEmiDate: nextEmiDateFor(loan, payments),
        payments: payments.map(serializePayment),
      });
    } catch (error) {
      console.error('Fetch loan error:', error);
      res.status(500).json({ error: 'Failed to fetch loan.' });
    }
  }
);

// ---- update --------------------------------------------------------------

app.put(
  '/api/loans/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const existing = await findOwnedLoan(req.user.id, req.params.id);
      if (!existing) return loanNotFound(res);

      const validation = validateLoanInput(req.body, { requireAll: false });
      if (!validation.ok) {
        return res.status(400).json({ error: validation.errors[0], errors: validation.errors });
      }

      const input = validation.value;
      const updates = { ...input };

      if (input.paymentAccountId !== undefined && !(await ownedAccountExists(req.user.id, input.paymentAccountId))) {
        return res.status(400).json({ error: 'Payment account not found.' });
      }

      const nextOriginal =
        input.originalPrincipal === undefined ? Number(existing.originalPrincipal) : input.originalPrincipal;
      const nextRate =
        input.interestRate === undefined ? Number(existing.interestRate ?? 0) : input.interestRate;

      const payments = await prisma.loanPayment.findMany({
        where: { loanId: existing.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      if (input.currentPrincipal !== undefined) {
        updates.currentPrincipal = input.currentPrincipal;
      } else if (payments.length > 0) {
        // History exists: the ledger decides the balance, not the request body.
        updates.currentPrincipal = outstandingBalance(
          { originalPrincipal: nextOriginal },
          payments
        );
      } else if (input.originalPrincipal !== undefined && nextOriginal !== Number(existing.originalPrincipal)) {
        updates.currentPrincipal = nextOriginal;
      }

      if (updates.currentPrincipal !== undefined && updates.currentPrincipal > nextOriginal) {
        return res.status(400).json({
          error: 'Current principal cannot exceed the original principal.',
        });
      }

      // Keep the implied end date in step when the tenure inputs changed.
      if (updates.endDate === undefined && input.startDate !== undefined && !existing.endDate) {
        const emi = input.emiAmount === undefined ? Number(existing.emiAmount ?? 0) : input.emiAmount;
        if (emi > 0 && input.startDate) {
          const months = remainingTenure(updates.currentPrincipal ?? Number(existing.currentPrincipal), nextRate, emi);
          if (months && months > 0) updates.endDate = addMonthsClamped(input.startDate, months);
        }
      }

      const loan = await prisma.loan.update({ where: { id: existing.id }, data: updates });

      res.json({
        ...serializeLoan(loan),
        summary: summarizeLoan(loan, payments),
        nextEmiDate: nextEmiDateFor(loan, payments),
      });
    } catch (error) {
      console.error('Update loan error:', error);
      res.status(500).json({ error: 'Failed to update loan.' });
    }
  }
);

// ---- toggle + delete -----------------------------------------------------

app.patch(
  '/api/loans/:id/toggle',
  authenticateToken,
  async (req, res) => {
    try {
      const existing = await findOwnedLoan(req.user.id, req.params.id);
      if (!existing) return loanNotFound(res);

      const loan = await prisma.loan.update({
        where: { id: existing.id },
        data: { isActive: !existing.isActive },
      });

      const payments = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }],
      });

      res.json({
        ...serializeLoan(loan),
        summary: summarizeLoan(loan, payments),
      });
    } catch (error) {
      console.error('Toggle loan error:', error);
      res.status(500).json({ error: 'Failed to update loan.' });
    }
  }
);

app.delete(
  '/api/loans/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const existing = await findOwnedLoan(req.user.id, req.params.id);
      if (!existing) return loanNotFound(res);

      // LoanPayment has onDelete: Cascade, so the ledger goes with the loan.
      await prisma.loan.delete({ where: { id: existing.id } });

      res.json({ message: 'Loan deleted.', id: existing.id });
    } catch (error) {
      console.error('Delete loan error:', error);
      res.status(500).json({ error: 'Failed to delete loan.' });
    }
  }
);

// ---- payments: history, record, edit, delete -----------------------------

app.get(
  '/api/loans/:id/payments',
  authenticateToken,
  async (req, res) => {
    try {
      const context = await loadLoanContext(req.user.id, req.params.id);
      if (!context) return loanNotFound(res);

      const { loan, payments } = context;
      let totalInterest = 0;
      let totalPrincipal = 0;
      let totalExtra = 0;
      let totalPaid = 0;

      for (const payment of payments) {
        totalInterest += toPaise(payment.interestAmount);
        totalPrincipal += toPaise(payment.principalAmount);
        totalExtra += toPaise(payment.extraPrincipal);
        totalPaid += toPaise(payment.totalAmount);
      }

      res.json({
        loanId: loan.id,
        count: payments.length,
        totals: {
          totalPaid: fromPaise(totalPaid),
          totalPrincipal: fromPaise(totalPrincipal),
          totalExtra: fromPaise(totalExtra),
          totalInterest: fromPaise(totalInterest),
        },
        outstandingPrincipal: outstandingBalance(loan, payments),
        payments: payments.map(serializePayment),
      });
    } catch (error) {
      console.error('Fetch loan payments error:', error);
      res.status(500).json({ error: 'Failed to fetch payment history.' });
    }
  }
);

app.post(
  '/api/loans/:id/payments',
  authenticateToken,
  async (req, res) => {
    try {
      const loan = await findOwnedLoan(req.user.id, req.params.id);
      if (!loan) return loanNotFound(res);

      const body = req.body || {};
      const rawKind = String(body.kind || 'EMI').toUpperCase();
      if (!LOAN_PAYMENT_KINDS.includes(rawKind)) {
        return res.status(400).json({
          error: `Invalid payment kind. Expected one of: ${LOAN_PAYMENT_KINDS.join(', ')}.`,
        });
      }

      const amount = num(body.amount === undefined ? body.totalAmount : body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
      }

      const date = body.date === undefined ? new Date() : new Date(body.date);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Payment date is not a valid date.' });
      }

      const note = body.note === undefined || body.note === null ? null : String(body.note).slice(0, 500);

      const result = await prisma.$transaction(async (db) => {
        const history = await db.loanPayment.findMany({
          where: { loanId: loan.id },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        });

        const opening = openingBalanceBefore(loan, history, date);

        const allocation = computePaymentAllocation({
          openingBalance: opening,
          annualRatePercent: loan.interestRate ?? 0,
          amount,
          // An ADJUSTMENT is a labelled part-payment: principal only, no interest.
          kind: rawKind === 'ADJUSTMENT' ? 'PREPAYMENT' : rawKind,
          note,
          date,
        });

        if (!allocation.ok) return { error: allocation.error };

        let principalAmount = allocation.principalAmount;
        let interestAmount = allocation.interestAmount;
        let extraPrincipal = allocation.extraPrincipal;

        // The user may supply the split explicitly (the checkpoint allows it),
        // but it must reconcile against the total and against the balance.
        const explicitSplit = ['principalAmount', 'interestAmount', 'extraPrincipal'].some(
          (key) => body[key] !== undefined && body[key] !== null
        );

        if (explicitSplit) {
          const p = num(body.principalAmount);
          const i = num(body.interestAmount);
          const e = num(body.extraPrincipal);
          if (![p, i, e].every((value) => Number.isFinite(value) && value >= 0)) {
            return { error: 'Payment split amounts must be non-negative numbers.' };
          }
          // Reject an impossible balance before arguing about the split.
          if (toPaise(p) + toPaise(e) > toPaise(opening)) {
            return { error: 'Payment would drive the outstanding balance below zero.' };
          }
          if (toPaise(p) + toPaise(i) + toPaise(e) !== toPaise(allocation.totalAmount)) {
            return { error: 'The payment split must add up to the total amount.' };
          }
          principalAmount = fromPaise(toPaise(p));
          interestAmount = fromPaise(toPaise(i));
          extraPrincipal = fromPaise(toPaise(e));
        }

        const outstandingAfter = fromPaise(
          Math.max(0, toPaise(opening) - toPaise(principalAmount) - toPaise(extraPrincipal))
        );

        const payment = await db.loanPayment.create({
          data: {
            loanId: loan.id,
            date,
            totalAmount: fromPaise(toPaise(principalAmount) + toPaise(interestAmount) + toPaise(extraPrincipal)),
            principalAmount,
            interestAmount,
            extraPrincipal,
            outstandingAfter,
            note,
          },
        });

        const updatedLoan = await db.loan.update({
          where: { id: loan.id },
          data: {
            currentPrincipal: outstandingAfter,
            // A loan with no stated start date takes it from its first payment.
            ...(loan.startDate ? {} : { startDate: date }),
          },
        });

        return { payment, loan: updatedLoan };
      });

      if (result.error) return res.status(400).json({ error: result.error });

      // A back-dated payment can change the running balance of the rows after it;
      // resync the chain so outstandingAfter and currentPrincipal stay exact.
      await resyncLoanLedger(loan);
      const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
      const payments = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      res.status(201).json({
        payment: serializePayment(payments.find((p) => p.id === result.payment.id) || result.payment),
        loan: serializeLoan(updatedLoan),
        summary: summarizeLoan(updatedLoan, payments),
      });
    } catch (error) {
      console.error('Record loan payment error:', error);
      res.status(500).json({ error: 'Failed to record payment.' });
    }
  }
);

app.put(
  '/api/loans/:id/payments/:paymentId',
  authenticateToken,
  async (req, res) => {
    try {
      const loan = await findOwnedLoan(req.user.id, req.params.id);
      if (!loan) return loanNotFound(res);

      const existing = await prisma.loanPayment.findFirst({
        where: { id: req.params.paymentId, loanId: loan.id },
      });
      if (!existing) return paymentNotFound(res);

      const body = req.body || {};
      const rawKind = body.kind === undefined ? null : String(body.kind).toUpperCase();
      if (rawKind !== null && !LOAN_PAYMENT_KINDS.includes(rawKind)) {
        return res.status(400).json({
          error: `Invalid payment kind. Expected one of: ${LOAN_PAYMENT_KINDS.join(', ')}.`,
        });
      }

      const date = body.date === undefined ? new Date(existing.date) : new Date(body.date);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Payment date is not a valid date.' });
      }

      const amount = num(
        body.amount === undefined ? (body.totalAmount === undefined ? existing.totalAmount : body.totalAmount) : body.amount
      );
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
      }

      const note =
        body.note === undefined
          ? existing.note
          : body.note === null
            ? null
            : String(body.note).slice(0, 500);

      const result = await prisma.$transaction(async (db) => {
        // Re-derive the opening balance WITHOUT this payment's own effect, so
        // editing a row cannot compound itself. The full ledger is still needed
        // to recover the loan's opening anchor.
        const ledger = await db.loanPayment.findMany({
          where: { loanId: loan.id },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        });

        const opening = openingBalanceBefore(loan, ledger, date, existing.id);

        const allocation = computePaymentAllocation({
          openingBalance: opening,
          annualRatePercent: loan.interestRate ?? 0,
          amount,
          kind: (rawKind || 'EMI') === 'ADJUSTMENT' ? 'PREPAYMENT' : rawKind || 'EMI',
          note,
          date,
        });

        if (!allocation.ok) return { error: allocation.error };

        const payment = await db.loanPayment.update({
          where: { id: existing.id },
          data: {
            date,
            totalAmount: allocation.totalAmount,
            principalAmount: allocation.principalAmount,
            interestAmount: allocation.interestAmount,
            extraPrincipal: allocation.extraPrincipal,
            outstandingAfter: allocation.outstandingAfter,
            note,
          },
        });

        return { payment };
      });

      if (result.error) return res.status(400).json({ error: result.error });

      const { currentPrincipal } = await resyncLoanLedger(loan);
      const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
      const payments = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      res.json({
        payment: serializePayment(result.payment),
        loan: serializeLoan(updatedLoan),
        summary: summarizeLoan({ ...updatedLoan, currentPrincipal }, payments),
      });
    } catch (error) {
      console.error('Update loan payment error:', error);
      res.status(500).json({ error: 'Failed to update payment.' });
    }
  }
);

app.delete(
  '/api/loans/:id/payments/:paymentId',
  authenticateToken,
  async (req, res) => {
    try {
      const loan = await findOwnedLoan(req.user.id, req.params.id);
      if (!loan) return loanNotFound(res);

      const existing = await prisma.loanPayment.findFirst({
        where: { id: req.params.paymentId, loanId: loan.id },
      });
      if (!existing) return paymentNotFound(res);

      await prisma.loanPayment.delete({ where: { id: existing.id } });
      await resyncLoanLedger(loan);

      const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
      const payments = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      res.json({
        message: 'Payment deleted.',
        id: existing.id,
        loan: serializeLoan(updatedLoan),
        summary: summarizeLoan(updatedLoan, payments),
      });
    } catch (error) {
      console.error('Delete loan payment error:', error);
      res.status(500).json({ error: 'Failed to delete payment.' });
    }
  }
);

// ---- computed: summary, schedule, simulate, adjust ----------------------

app.get(
  '/api/loans/:id/summary',
  authenticateToken,
  async (req, res) => {
    try {
      const context = await loadLoanContext(req.user.id, req.params.id);
      if (!context) return loanNotFound(res);

      const { loan, payments } = context;
      const summary = summarizeLoan(loan, payments);

      res.json({
        ...summary,
        nextEmiDate: nextEmiDateFor(loan, payments),
        contractualMonths: contractualMonths(loan),
        scheduledEmi: loan.emiAmount === null ? null : Number(loan.emiAmount),
      });
    } catch (error) {
      console.error('Fetch loan summary error:', error);
      res.status(500).json({ error: 'Failed to fetch loan summary.' });
    }
  }
);

app.get(
  '/api/loans/:id/schedule',
  authenticateToken,
  async (req, res) => {
    try {
      const context = await loadLoanContext(req.user.id, req.params.id);
      if (!context) return loanNotFound(res);

      const { loan, payments } = context;
      const rate = Number(loan.interestRate ?? 0);
      const emi = Number(loan.emiAmount ?? 0);
      const outstanding = outstandingBalance(loan, payments);
      const months = contractualMonths(loan);

      // The loan's whole life, with actual payments marked against each period.
      const lifetime = buildAmortizationSchedule({
        principal: Number(loan.originalPrincipal),
        annualRatePercent: rate,
        emi,
        startDate: loan.startDate,
        periods: months,
      });

      // What is still to come, rebuilt from the CURRENT balance so every actual
      // prepayment is already reflected in the projection.
      const remainingMonths = emi > 0 ? remainingTenure(outstanding, rate, emi) : null;
      const projection = emi > 0 && outstanding > 0
        ? buildAmortizationSchedule({
            principal: outstanding,
            annualRatePercent: rate,
            emi,
            startDate: nextEmiDateFor(loan, payments) || new Date(),
            periods: remainingMonths,
          })
        : buildAmortizationSchedule({ principal: 0, annualRatePercent: rate, emi, startDate: null });

      res.json({
        loan: serializeLoan(loan),
        summary: summarizeLoan(loan, payments),
        contractualMonths: months,
        scheduledEmi: loan.emiAmount === null ? null : Number(loan.emiAmount),
        schedule: {
          rows: annotateSchedule(lifetime.rows, payments),
          planned: {
            periods: lifetime.periods,
            totalInterest: lifetime.totalInterest,
            totalPrincipal: lifetime.totalPrincipal,
            totalExtra: lifetime.totalExtra,
            totalPayments: lifetime.totalPayments,
            closesToZero: lifetime.closesToZero,
            amortizes: lifetime.amortizes,
          },
          actualTotals: {
            count: payments.length,
            totalPaid: fromPaise(payments.reduce((total, p) => total + toPaise(p.totalAmount), 0)),
            totalInterest: fromPaise(payments.reduce((total, p) => total + toPaise(p.interestAmount), 0)),
            totalPrincipal: fromPaise(payments.reduce((total, p) => total + toPaise(p.principalAmount), 0)),
            totalExtra: fromPaise(payments.reduce((total, p) => total + toPaise(p.extraPrincipal), 0)),
          },
        },
        projection: {
          fromBalance: outstanding,
          remainingMonths,
          periods: projection.periods,
          totalInterest: projection.totalInterest,
          totalPayments: projection.totalPayments,
          closesToZero: projection.closesToZero,
          amortizes: projection.amortizes,
          estimatedPayoffDate: lastScheduleDateOf(projection),
          rows: projection.rows,
        },
      });
    } catch (error) {
      console.error('Fetch loan schedule error:', error);
      res.status(500).json({ error: 'Failed to fetch amortization schedule.' });
    }
  }
);

app.post(
  '/api/loans/:id/simulate',
  authenticateToken,
  async (req, res) => {
    try {
      const context = await loadLoanContext(req.user.id, req.params.id);
      if (!context) return loanNotFound(res);

      const { loan, payments } = context;
      const body = req.body || {};
      const rate = Number(loan.interestRate ?? 0);
      const emi = Number(loan.emiAmount ?? 0);
      const outstanding = outstandingBalance(loan, payments);

      const extraAmount = num(body.extraAmount);
      const monthlyExtra = num(body.monthlyExtra);
      const keepEmi = body.keepEmi === undefined ? true : Boolean(body.keepEmi);

      if (!Number.isFinite(extraAmount) || extraAmount < 0) {
        return res.status(400).json({ error: 'extraAmount must be a non-negative number.' });
      }
      if (!Number.isFinite(monthlyExtra) || monthlyExtra < 0) {
        return res.status(400).json({ error: 'monthlyExtra must be a non-negative number.' });
      }

      if (emi <= 0) {
        return res.status(400).json({
          error: 'A payoff simulation needs an EMI. Set the loan EMI first.',
        });
      }

      // Decision B: the default scenario keeps the EMI and shortens the tenure.
      const prepayment = prepaymentSavings({
        principal: Number(loan.originalPrincipal),
        annualRatePercent: rate,
        emi,
        startDate: loan.startDate,
        currentBalance: outstanding,
        extraAmount,
        monthlyExtra,
        keepEmi,
        fromDate: nextEmiDateFor(loan, payments) || new Date(),
        periods: remainingTenure(outstanding, rate, emi),
      });

      let rateChange = null;
      if (body.newRate !== undefined && body.newRate !== null && body.newRate !== '') {
        const newRate = num(body.newRate);
        if (!Number.isFinite(newRate) || newRate < 0 || newRate > 100) {
          return res.status(400).json({ error: 'newRate must be between 0 and 100.' });
        }
        rateChange = rateChangeImpact({
          originalPrincipal: Number(loan.originalPrincipal),
          annualRatePercent: rate,
          emi,
          startDate: loan.startDate,
          newRatePercent: newRate,
          fromPeriod: Number(body.fromPeriod ?? payments.length + 1) || payments.length + 1,
        });
        rateChange = {
          newRatePercent: newRate,
          changedFrom: rateChange.changedFrom,
          unaffectedPeriods: rateChange.unaffectedPeriods,
          balanceAtChange: rateChange.balanceAtChange,
          newTotalInterest: rateChange.newTotalInterest,
          totalInterestDelta: rateChange.totalInterestDelta,
          newPayoffDate: rateChange.newPayoffDate,
          monthsDelta: rateChange.monthsDelta,
          emiForSameTenure: rateChange.emiForSameTenure,
          baseline: rateChange.baseline,
          rows: rateChange.rows,
        };
      }

      res.json({
        loan: serializeLoan(loan),
        summary: summarizeLoan(loan, payments),
        input: { extraAmount, monthlyExtra, keepEmi, newRate: body.newRate ?? null },
        prepayment,
        rateChange,
      });
    } catch (error) {
      console.error('Simulate loan error:', error);
      res.status(500).json({ error: 'Failed to simulate the loan.' });
    }
  }
);

app.post(
  '/api/loans/:id/adjust',
  authenticateToken,
  async (req, res) => {
    try {
      const loan = await findOwnedLoan(req.user.id, req.params.id);
      if (!loan) return loanNotFound(res);

      const amount = num(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Adjustment amount must be greater than zero.' });
      }

      const date = req.body?.date === undefined ? new Date() : new Date(req.body.date);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Adjustment date is not a valid date.' });
      }

      const note =
        req.body?.note === undefined || req.body.note === null
          ? 'Manual balance adjustment'
          : String(req.body.note).slice(0, 500);

      const history = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      const opening = openingBalanceBefore(loan, history, date);
      const allocation = computePaymentAllocation({
        openingBalance: opening,
        annualRatePercent: loan.interestRate ?? 0,
        amount,
        kind: 'PREPAYMENT',
        note,
        date,
      });

      if (!allocation.ok) return res.status(400).json({ error: allocation.error });

      const payment = await prisma.loanPayment.create({
        data: {
          loanId: loan.id,
          date,
          totalAmount: allocation.totalAmount,
          principalAmount: allocation.principalAmount,
          interestAmount: allocation.interestAmount,
          extraPrincipal: allocation.extraPrincipal,
          outstandingAfter: allocation.outstandingAfter,
          note,
        },
      });

      await resyncLoanLedger(loan);
      const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
      const payments = await prisma.loanPayment.findMany({
        where: { loanId: loan.id },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      });

      res.status(201).json({
        payment: serializePayment(payments.find((p) => p.id === payment.id) || payment),
        loan: serializeLoan(updatedLoan),
        summary: summarizeLoan(updatedLoan, payments),
      });
    } catch (error) {
      console.error('Adjust loan balance error:', error);
      res.status(500).json({ error: 'Failed to adjust the loan balance.' });
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

// Only bind a port when run directly. Importing the module (integration tests)
// must not open a listener.
const START_SERVER = require.main === module;

if (START_SERVER) {
  app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Email configured for: ${process.env.EMAIL_USER}`
  );

  console.log(
    'Recurring job scheduled daily at 18:30 UTC (00:00 IST).'
  );
  });
}

module.exports = {
  app,
  prisma,
  processRecurringExpenses,
};
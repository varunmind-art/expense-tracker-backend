'use strict';

/**
 * P0-7 — synthetic fixtures for database-backed tests.
 *
 * Every row uses a deterministic id beginning with `p07-`, so fixtures are
 * repeatable and cleanup can delete EXACTLY what the tests created and nothing
 * else. The database is never reset, truncated or dropped.
 *
 * These are fictional records. No production data is read or copied.
 */

const bcrypt = require('bcryptjs');

const PREFIX = 'p07-';
const SYNTHETIC_PASSWORD = 'P07-Synthetic-Passw0rd!';

/** Deterministic identifiers. */
const ID = {
  userA: `${PREFIX}user-a`,
  userB: `${PREFIX}user-b`,
  userDeleted: `${PREFIX}user-deleted`,

  accountA1: `${PREFIX}acct-a1`,
  accountA2: `${PREFIX}acct-a2`,
  accountB1: `${PREFIX}acct-b1`,
  accountToDelete: `${PREFIX}acct-a-delete`,

  catAExpense: `${PREFIX}cat-a-expense`,
  catASavings: `${PREFIX}cat-a-savings`,
  catAOther: `${PREFIX}cat-a-other`,
  catBExpense: `${PREFIX}cat-b-expense`,
  catBSecret: `${PREFIX}cat-b-secret`,
  catAConcurrent: `${PREFIX}cat-a-concurrent`,

  expenseA1: `${PREFIX}exp-a1`,
  expenseA2: `${PREFIX}exp-a2`,
  expenseB1: `${PREFIX}exp-b1`,
  expenseOnDeletedAccount: `${PREFIX}exp-a-deleted-account`,

  incomeA1: `${PREFIX}inc-a1`,
  incomeB1: `${PREFIX}inc-b1`,
  incomeOnDeletedAccount: `${PREFIX}inc-a-deleted-account`,

  budgetA1: `${PREFIX}bud-a1`,
  budgetAOverspent: `${PREFIX}bud-a-overspent`,

  ruleMonthly: `${PREFIX}rule-monthly`,
  ruleMonthly31: `${PREFIX}rule-monthly-31`,
  ruleWeekly: `${PREFIX}rule-weekly`,
  ruleYearly: `${PREFIX}rule-yearly`,
  ruleOverdue: `${PREFIX}rule-overdue`,
  ruleLeap: `${PREFIX}rule-leap`,
}

/** Times are UTC instants chosen so the IST calendar day is unambiguous. */
const T = {
  monthEnd: new Date('2026-03-31T18:29:59.999Z'), // 2026-03-31 23:59:59.999 IST
  monthStart: new Date('2026-03-31T18:30:00.000Z'), // 2026-04-01 00:00 IST
  feb28: new Date('2026-02-28T10:00:00.000Z'),
  leapDay: new Date('2024-02-29T10:00:00.000Z'),
};

const deleteManyScoped = (prisma) => [
  prisma.$executeRawUnsafe(`DELETE FROM "LoanPayment" WHERE "loanId" IN (SELECT id FROM "Loan" WHERE "userId" LIKE '${PREFIX}%')`),
  prisma.$executeRawUnsafe(`DELETE FROM "Loan" WHERE "userId" LIKE '${PREFIX}%'`),
  prisma.pendingImport.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.expense.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.income.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.budget.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.recurringRule.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.merchant.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.account.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.category.deleteMany({ where: { userId: { startsWith: PREFIX } } }),
  prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } }),
];

/** Remove only fixture rows. Safe to call repeatedly. */
const cleanupFixtures = async (prisma) => {
  for (const op of deleteManyScoped(prisma)) {
    await op;
  }
};

/**
 * Create the fixture set. Idempotent because cleanup runs first.
 * @returns {Promise<Record<string, any>>} handles the tests need
 */
const createFixtures = async (prisma) => {
  await cleanupFixtures(prisma);

  const password = await bcrypt.hash(SYNTHETIC_PASSWORD, 10);

  await prisma.user.createMany({
    data: [
      { id: ID.userA, email: 'p07-user-a@example.invalid', password, name: 'Synthetic User A' },
      { id: ID.userB, email: 'p07-user-b@example.invalid', password, name: 'Synthetic User B' },
      { id: ID.userDeleted, email: 'p07-user-deleted@example.invalid', password, name: 'To Be Deleted' },
    ],
  });

  await prisma.account.createMany({
    data: [
      { id: ID.accountA1, name: 'P07 A Bank', type: 'BANK', userId: ID.userA, currency: 'INR' },
      { id: ID.accountA2, name: 'P07 A Wallet', type: 'WALLET', userId: ID.userA, currency: 'INR' },
      { id: ID.accountB1, name: 'P07 B Bank', type: 'BANK', userId: ID.userB, currency: 'INR' },
    ],
  });

  await prisma.category.createMany({
    data: [
      { id: ID.catAExpense, name: 'P07 A Groceries', type: 'EXPENSE', userId: ID.userA, icon: '🛒' },
      { id: ID.catASavings, name: 'P07 A Mutual Funds', type: 'SAVINGS', userId: ID.userA, icon: '📈' },
      { id: ID.catAOther, name: 'P07 A Transport', type: 'EXPENSE', userId: ID.userA, icon: '🚗' },
      { id: ID.catBExpense, name: 'P07 B Groceries', type: 'EXPENSE', userId: ID.userB, icon: '🛒' },
      { id: ID.catBSecret, name: 'P07 B SECRET DINING', type: 'EXPENSE', userId: ID.userB, icon: '🔒' },
    ],
  });

  await prisma.expense.createMany({
    data: [
      { id: ID.expenseA1, amount: '1200.00', date: T.feb28, userId: ID.userA, categoryId: ID.catAExpense, accountId: ID.accountA1, type: 'EXPENSE', merchant: 'P07 A Merchant' },
      { id: ID.expenseA2, amount: '800.00', date: T.monthEnd, userId: ID.userA, categoryId: ID.catAExpense, accountId: ID.accountA1, type: 'EXPENSE' },
      { id: ID.expenseB1, amount: '999.00', date: T.feb28, userId: ID.userB, categoryId: ID.catBExpense, accountId: ID.accountB1, type: 'EXPENSE' },
    ],
  });

  await prisma.income.createMany({
    data: [
      { id: ID.incomeA1, amount: '50000.00', date: T.feb28, userId: ID.userA, source: 'SALARY', accountId: ID.accountA1 },
      { id: ID.incomeB1, amount: '60000.00', date: T.feb28, userId: ID.userB, source: 'SALARY', accountId: ID.accountB1 },
    ],
  });

  await prisma.budget.createMany({
    data: [
      { id: ID.budgetA1, amount: '5000.00', period: 'MONTHLY', userId: ID.userA, categoryId: ID.catAExpense, startDate: T.feb28 },
      { id: ID.budgetAOverspent, amount: '1000.00', period: 'MONTHLY', userId: ID.userA, categoryId: ID.catAOther, startDate: T.feb28 },
    ],
  });

  await prisma.recurringRule.createMany({
    data: [
      { id: ID.ruleMonthly, description: 'P07 monthly 15th', amount: '500.00', frequency: 'MONTHLY', dayOfMonth: 15, nextExecution: new Date('2026-03-15T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catAExpense },
      { id: ID.ruleMonthly31, description: 'P07 monthly 31st', amount: '600.00', frequency: 'MONTHLY', dayOfMonth: 31, nextExecution: new Date('2026-01-31T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catAExpense },
      { id: ID.ruleWeekly, description: 'P07 weekly Monday', amount: '100.00', frequency: 'WEEKLY', dayOfWeek: 1, nextExecution: new Date('2026-03-09T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catAOther },
      { id: ID.ruleYearly, description: 'P07 yearly', amount: '7000.00', frequency: 'YEARLY', nextExecution: new Date('2026-01-10T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catASavings },
      { id: ID.ruleOverdue, description: 'P07 overdue monthly', amount: '250.00', frequency: 'MONTHLY', dayOfMonth: 15, nextExecution: new Date('2026-01-15T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catAExpense },
      { id: ID.ruleLeap, description: 'P07 leap-day yearly', amount: '300.00', frequency: 'YEARLY', nextExecution: new Date('2024-02-29T00:00:00.000Z'), userId: ID.userA, categoryId: ID.catAOther },
    ],
  });

  return { ID, T, PREFIX, SYNTHETIC_PASSWORD };
};

module.exports = {
  PREFIX,
  ID,
  T,
  SYNTHETIC_PASSWORD,
  createFixtures,
  cleanupFixtures,
};

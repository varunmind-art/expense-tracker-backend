-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "disbursedPrincipal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "disbursementComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preEmiActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sanctionedLimit" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "LoanPayment" ADD COLUMN     "allocationVerified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "scheduledDate" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CONFIRMED';

-- CreateTable
CREATE TABLE "LoanDisbursement" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "loanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanDisbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanInterestPosting" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INTEREST',
    "reference" TEXT,
    "note" TEXT,
    "loanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanInterestPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanEmiSchedule" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EMI',
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "paymentAccountId" TEXT,
    "confirmedPaymentId" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "note" TEXT,
    "loanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanEmiSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanDisbursement_loanId_idx" ON "LoanDisbursement"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanDisbursement_loanId_reference_key" ON "LoanDisbursement"("loanId", "reference");

-- CreateIndex
CREATE INDEX "LoanInterestPosting_loanId_idx" ON "LoanInterestPosting"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInterestPosting_loanId_reference_key" ON "LoanInterestPosting"("loanId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "LoanEmiSchedule_confirmedPaymentId_key" ON "LoanEmiSchedule"("confirmedPaymentId");

-- CreateIndex
CREATE INDEX "LoanEmiSchedule_loanId_idx" ON "LoanEmiSchedule"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanEmiSchedule_loanId_sequence_key" ON "LoanEmiSchedule"("loanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "LoanPayment_loanId_externalRef_key" ON "LoanPayment"("loanId", "externalRef");

-- AddForeignKey
ALTER TABLE "LoanDisbursement" ADD CONSTRAINT "LoanDisbursement_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInterestPosting" ADD CONSTRAINT "LoanInterestPosting_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEmiSchedule" ADD CONSTRAINT "LoanEmiSchedule_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEmiSchedule" ADD CONSTRAINT "LoanEmiSchedule_confirmedPaymentId_fkey" FOREIGN KEY ("confirmedPaymentId") REFERENCES "LoanPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEmiSchedule" ADD CONSTRAINT "LoanEmiSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


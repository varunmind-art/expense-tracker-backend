-- CreateTable
CREATE TABLE "LoanRateChange" (
    "id" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "annualRatePercent" DECIMAL(6,3) NOT NULL,
    "note" TEXT,
    "loanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanRateChange_loanId_idx" ON "LoanRateChange"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRateChange_loanId_effectiveDate_key" ON "LoanRateChange"("loanId", "effectiveDate");

-- AddForeignKey
ALTER TABLE "LoanRateChange" ADD CONSTRAINT "LoanRateChange_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


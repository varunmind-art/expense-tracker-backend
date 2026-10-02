# Merchant Tracking — Feature Roadmap

> Saved: October 2026. Refer to this when planning stages beyond the current build.

## 🎯 Core Feature
Add a `merchant` field to every expense entry. Track and display spending per merchant across the app.

---

## ✅ Tier 1 — Delivered in Stage 1 (Current Build)
1. **Merchant Autocomplete** — datalist suggestions from past merchants
2. **Top Merchants Card** — dashboard card (top 5 by spend)
3. **Merchant Filter** — in Expense List, alongside category filter
4. **Auto-Populate from Gmail Imports** — reuse existing merchant detection
5. **Auto-Populate from Recurring Rules** — use rule description as merchant

## ✅ Tier 2 (#6) — Delivered in Stage 1
6. **Merchant Insights Page** — dedicated page with per-merchant totals, counts, avg, trends, primary category

---

## 🔜 Tier 2 — Pending (Medium Value)
7. **Merchant Trends** — ↗️/↘️ vs last month (partially delivered in Insights)
8. **Frequency Tracker** — "12 visits this month, ₹200 avg"
9. **Merchant Aliases** — map "AMZN", "Amazon.in", "Amazon India" to one canonical name
10. **Click to Expand** — Top Merchants card → drawer with last 10 txns

## 🔜 Tier 3 — Advanced (Lower Priority)
11. **Merchant + Category Correlation** — "Amazon → 90% Shopping"
12. **Merchant Frequency Heatmap** — when do I shop here most?
13. **Merchant Blacklist / Avoid Flag** — Swiggy, Zomato warnings
14. **Frequently Bought Together** — low ROI, skip
15. **Merchant Budget** — cap per merchant (e.g., ₹3,000 Swiggy) with alerts
16. **Merchant Recommendation on Autofill** — highlight typical merchants per category

---

## 🏗️ Technical Approach (as implemented)

- Single `merchant String?` field on `Expense` — no separate model
- Endpoints: `/api/merchants` (autocomplete), `/api/merchants/stats` (insights)
- Gmail + Recurring + Pending all populate merchant field
- Category-driven Savings/Expense tagging stays as-is
- Future aliasing: add a `MerchantAlias` table only if duplicates become a problem

---

## 🧠 Design Decisions
- Merchant is optional — existing rows stay null, no data loss
- Trimming whitespace on save; no case normalization (user can pick a style)
- Stats limited to last 12 months for performance
- Trend = "up" if >10% increase vs previous month, "down" if <-10%, else "flat"
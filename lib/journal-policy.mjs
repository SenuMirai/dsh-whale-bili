import { Fault, need } from "./errors.mjs";

export const JOURNAL_DAILY_LIMIT = 2;
const timeZone = "Asia/Shanghai";
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Call inside the same BEGIN IMMEDIATE transaction as Store.note().
// Deriving usage from committed journal rows preserves it across restarts,
// and a rolled-back insert does not consume a separate counter or reservation.
export function journalDailyStatus(store, at = Date.now()) {
  const instant = new Date(at);
  need(Number.isFinite(instant.getTime()), "INVALID_JOURNAL_CLOCK");
  const date = dayFormat.format(instant);
  // Shanghai uses UTC+08:00 for current journal dates. SQLite interprets
  // stored ISO timestamps before applying the offset, including UTC midnight.
  const used = store.db
    .prepare(
      "SELECT count(*) AS n FROM notes WHERE date(created, '+8 hours')=?",
    )
    .get(date).n;
  return {
    date,
    timeZone,
    used,
    limit: JOURNAL_DAILY_LIMIT,
    remaining: Math.max(0, JOURNAL_DAILY_LIMIT - used),
  };
}
export function enforceJournalDailyLimit(store, at = Date.now()) {
  need(store.db.isTransaction === true, "JOURNAL_TRANSACTION_REQUIRED");
  const budget = journalDailyStatus(store, at);
  if (budget.used >= JOURNAL_DAILY_LIMIT)
    throw new Fault(
      "JOURNAL_DAILY_LIMIT",
      "At most two journals may be saved per Asia/Shanghai date. Read existing journals and select meaningful encounters; daily output is optional.",
    );
  return budget;
}

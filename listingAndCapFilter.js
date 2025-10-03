// src/filters/listingAndCapFilter.js
import yahooFinance from 'yahoo-finance2';

const ONE_BILLION = 1_000_000_000n;

// בורסות מאושרות
const APPROVED_EXCHANGES = new Set([
  'NasdaqGS',   // NASDAQ Global Select
  'NasdaqGM',   // NASDAQ Global Market
  'NasdaqCM',   // NASDAQ Capital Market
  'NYSE'        // New York Stock Exchange (הראשית)
  // במכוון לא הוספתי NYSE Arca / American כדי להתרחק מ-ETFs/קרנות
]);

// סוגי נייר רצויים (לא חובה, אבל עוזר לפסול ETFs)
const APPROVED_QUOTE_TYPES = new Set([
  'EQUITY' // מניות
]);

// נירמול טיקר: מסיר $, רווחים, רישיות
function normalizeTicker(t) {
  return String(t || '')
    .trim()
    .replace(/^\$/,'')
    .toUpperCase();
}

// Cache פשוט עם TTL כדי להפחית קריאות
const cache = new Map();
const TTL_MS = 15 * 60 * 1000; // 15 דקות

function getCache(key) {
  const ent = cache.get(key);
  if (!ent) return null;
  if (Date.now() > ent.exp) { cache.delete(key); return null; }
  return ent.val;
}
function setCache(key, val) {
  cache.set(key, { val, exp: Date.now() + TTL_MS });
}

// פונקציית עזר: משיכת נתונים מהירים ל-ticker (exchange + market cap)
async function fetchQuoteCore(ticker) {
  const key = `core:${ticker}`;
  const hit = getCache(key);
  if (hit) return hit;

  // ננסה לקבל גם quoteSummary וגם quote כדי לגבות שדות שונים
  const [quote, summary] = await Promise.allSettled([
    yahooFinance.quote(ticker, { fields: ['marketCap','marketState','quoteType','fullExchangeName','exchange'] }),
    yahooFinance.quoteSummary(ticker, { modules: ['price','summaryDetail','defaultKeyStatistics'] })
  ]);

  let fullExchangeName, exchange, marketCap, quoteType;

  if (quote.status === 'fulfilled' && quote.value) {
    fullExchangeName = quote.value.fullExchangeName || fullExchangeName;
    exchange = quote.value.exchange || exchange;
    marketCap = quote.value.marketCap != null ? BigInt(quote.value.marketCap) : marketCap;
    quoteType = quote.value.quoteType || quoteType;
  }

  if (summary.status === 'fulfilled' && summary.value?.price) {
    const p = summary.value.price;
    fullExchangeName = p.exchangeName || fullExchangeName;
    // marketCap לפעמים כאן בשם marketCap/raw
    if (p.marketCap?.raw != null) {
      marketCap = BigInt(p.marketCap.raw);
    }
    // גיבוי ל-quoteType
    quoteType = p.quoteType || quoteType;
  }

  // גיבוי נוסף ל-marketCap מסיכום סטטיסטיקות
  if (summary.status === 'fulfilled' && summary.value?.defaultKeyStatistics?.enterpriseValue?.raw != null && marketCap == null) {
    // אם אין marketCap, לא נשתמש ב-EV במקום, עדיף לזרוק שגיאה רכה ולפסול
  }

  const res = { fullExchangeName, exchange, marketCap, quoteType };
  setCache(key, res);
  return res;
}

/**
 * בודק שהטיקר נסחר ב-NASDAQ/NYSE ושווי השוק ≥ $1B.
 * @param {string} rawTicker  טיקר (עם/בלי $)
 * @param {object} opts       אופציות: { requireEquity: boolean }
 * @returns {Promise<{ok:boolean, reason?:string, data?:object}>}
 */
export async function passesListingAndCap(rawTicker, opts = {}) {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return { ok: false, reason: 'empty_ticker' };

  let data;
  try {
    data = await fetchQuoteCore(ticker);
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', data: { error: String(e) } };
  }

  const { fullExchangeName, marketCap, quoteType } = data;

  // בדיקת בורסה
  if (!fullExchangeName || !APPROVED_EXCHANGES.has(fullExchangeName)) {
    return { ok: false, reason: 'exchange_not_allowed', data };
  }

  // בדיקת סוג נייר (אופציונלי)
  if (opts.requireEquity) {
    if (!quoteType || !APPROVED_QUOTE_TYPES.has(quoteType)) {
      return { ok: false, reason: 'quote_type_not_equity', data };
    }
  }

  // החרגת ETF מבדיקת שווי שוק (גם אם 0/חסר)
  if (quoteType === 'ETF') {
    return { ok: true, data: { ...data, note: 'etf_bypassed_market_cap' } };
  }

  // בדיקת שווי שוק
  if (marketCap == null) {
    return { ok: false, reason: 'market_cap_missing', data };
  }
  if (BigInt(marketCap) < ONE_BILLION) {
    return { ok: false, reason: 'market_cap_too_small', data: { ...data, threshold: String(ONE_BILLION) } };
  }

  return { ok: true, data };
}

/**
 * בדיקה מרובת טיקרים (נוח לפייפליין חדשות).
 * @param {string[]} tickers
 * @param {object} opts
 * @returns {Promise<Record<string,{ok:boolean,reason?:string,data?:object}>>}
 */
export async function filterTickersByListingAndCap(tickers, opts = {}) {
  const out = {};
  await Promise.all(
    (tickers || []).map(async t => {
      out[t] = await passesListingAndCap(t, opts);
    })
  );
  return out;
}

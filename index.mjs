// index.mjs
import "dotenv/config";
import axios from "axios";
import * as fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

/** ====== קונפיג מה-.env עם ברירות מחדל ====== */
const OPENINSIDER_URL =
  process.env.OPENINSIDER_URL ||
  "http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=730&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&xs=1&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=500&page=1";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}

const MAX_DAYS_FILED = Number(process.env.MAX_DAYS_FILED ?? 3);     // ימים אחורה לפי Filing Date
const MAX_DAYS_TRADE = Number(process.env.MAX_DAYS_TRADE ?? 365);   // ימים אחורה לפי Trade Date
const MIN_PRICE      = Number(process.env.MIN_PRICE ?? 5);          // מינימום מחיר מניה
const MIN_VALUE_K    = Number(process.env.MIN_VALUE_K ?? 0);        // מינימום שווי עסקה באלפי $
const TYPES          = (process.env.TYPES || "P,S")                 // אילו סוגים לכלול: P/S
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const LOG_FILE       = process.env.LOG_FILE || path.resolve("./openinsider.sent.log");

// שליטה בקצב/באטצ'ינג/תצוגה
const EMBED_MODE      = (process.env.EMBED_MODE ?? "1") === "1"; // 1=Embeds חד־שורתיים
const EMBEDS_PER_REQ  = Number(process.env.EMBEDS_PER_REQ ?? 10); // מקס' 10 בדיסקורד
const RATE_LIMIT_MS   = Number(process.env.RATE_LIMIT_MS ?? 750);
const MAX_PER_RUN     = Number(process.env.MAX_PER_RUN ?? 200);

// אופציונלי: בדיקות אוף־ליין מקובץ HTML מקומי
const LOCAL_HTML = process.env.LOCAL_HTML; // למשל: ./openinsider.html

/** ====== Utils ====== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseMoney(str = "") {
  const n = String(str).replace(/[\$,]/g, "");
  const num = Number(n);
  return Number.isFinite(num) ? num : NaN;
}
function parseQty(str = "") {
  const n = String(str).replace(/,/g, "");
  const num = Number(n);
  return Number.isFinite(num) ? num : NaN;
}
function parsePct(str = "") {
  const n = String(str).replace(/[%,]/g, "");
  const num = Number(n);
  return Number.isFinite(num) ? num : NaN;
}
function daysAgoFrom(dateStr) {
  // תומך ב-"YYYY-MM-DD" או "YYYY-MM-DD hh:mm:ss"
  const d = new Date(dateStr.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}
async function loadSent() {
  try {
    const txt = await fs.readFile(LOG_FILE, "utf8");
    return new Set(txt.split("\n").map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
async function appendSent(key) {
  await fs.appendFile(LOG_FILE, key + "\n", "utf8");
}
function makeKey(r) {
  return [
    r.filingDateTime,
    r.ticker,
    r.insiderName,
    r.tradeCode,
    r.price,
    r.qty
  ].join("|");
}

/** ====== פרסינג עמוד התוצאות ====== */
function extractRows(html) {
  const $ = load(html);
  const rows = $("table.tinytable > tbody > tr");
  const out = [];

  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 13) return;

    // 0:X, 1:FilingDate(link), 2:TradeDate, 3:Ticker, 4:Company, 5:Insider, 6:Title,
    // 7:TradeType, 8:Price, 9:Qty, 10:Owned, 11:DeltaOwn, 12:Value, 13..: perf
    const filingDateTime = $(tds[1]).text().trim(); // "YYYY-MM-DD hh:mm:ss"
    const filingLink     = $(tds[1]).find("a").attr("href") || "";
    const tradeDate      = $(tds[2]).text().trim();
    const ticker         = $(tds[3]).text().trim();
    const company        = $(tds[4]).text().trim();
    const insiderName    = $(tds[5]).text().trim();
    const title          = $(tds[6]).text().trim();
    const tradeTypeText  = $(tds[7]).text().trim();  // "P - Purchase", "S - Sale", "S - Sale+OE"
    const priceText      = $(tds[8]).text().trim();  // "$299.42"
    const qtyText        = $(tds[9]).text().trim();  // "-14,000" או "+7,428"
    const ownedText      = $(tds[10]).text().trim();
    const deltaOwnText   = $(tds[11]).text().trim(); // "-12%"
    const valueText      = $(tds[12]).text().trim(); // "-$4,191,935"

    const tradeCode = tradeTypeText.split(/\s*-\s*/)[0].toUpperCase(); // "P" או "S" ...
    const price     = parseMoney(priceText);
    const qty       = parseQty(qtyText);
    const value     = parseMoney(valueText);
    const deltaOwn  = parsePct(deltaOwnText);

    out.push({
      filingDateTime, filingLink, tradeDate, ticker, company,
      insiderName, title, tradeTypeText, tradeCode,
      priceText, qtyText, ownedText, deltaOwnText, valueText,
      price, qty, value, deltaOwn
    });
  });

  return out;
}

/** ====== עיצוב Embed חד־שורתִי + צבע ====== */
function pickColorByTrade(tradeCode) {
  if (tradeCode === "P") return 0x2ecc71; // קנייה
  if (tradeCode === "S") return 0xe74c3c; // מכירה
  return 0x95a5a6; // אחר/נייטרלי
}
function oneLine(r) {
  const isBig = Math.abs(Number.isFinite(r.value) ? r.value : parseMoney(r.valueText)) > 10_000_000;
  const parts = [
    `${r.tradeDate}\n`,
    `**$${r.ticker}  ${r.valueText}  (${r.qtyText} Stocks)**\n`,
    `${r.company}: ${r.priceText}  (${r.tradeTypeText})\n`,
    `${r.insiderName} (Title: ${r.title || "—"})\n`,
    r.filingLink ? `[SEC Form 4 (${r.filingDateTime})](${r.filingLink})` : null
  ].filter(Boolean);

  const line = parts.join("");
  return isBig ? `${line} @insider_trade` : line;
}
function buildEmbed(r) {
  return {
    description: oneLine(r),
    color: pickColorByTrade(r.tradeCode),
  };
}

/** ====== שליחה לדיסקורד (עם 429 Retry) ====== */
async function sendDiscordEmbeds(embeds) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds,
        allowed_mentions: { parse: [] }
      }, { timeout: 15000 });
      return;
    } catch (e) {
      if (e?.response?.status === 429) {
        const retryMs = Math.max(1000, Math.ceil(((e.response.data?.retry_after ?? 2) * 1000)));
        console.warn(`[rate-limit] 429: waiting ${retryMs}ms (attempt ${attempt})`);
        await sleep(retryMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to send embeds after retries");
}
async function sendDiscordText(content) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        content, allowed_mentions: { parse: [] }
      }, { timeout: 15000 });
      return;
    } catch (e) {
      if (e?.response?.status === 429) {
        const retryMs = Math.max(1000, Math.ceil(((e.response.data?.retry_after ?? 2) * 1000)));
        console.warn(`[rate-limit] 429: waiting ${retryMs}ms (attempt ${attempt})`);
        await sleep(retryMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to send text after retries");
}

/** ====== Main ====== */
(async () => {
  // 1) הבא HTML (קובץ מקומי אם קיים; אחרת מהאינטרנט)
  let html;
  if (LOCAL_HTML) {
    html = await fs.readFile(LOCAL_HTML, "utf8");
    console.log(`[local] Loaded HTML from ${LOCAL_HTML}`);
  } else {
    console.log(`[fetch] GET ${OPENINSIDER_URL}`);
    const { data } = await axios.get(OPENINSIDER_URL, {
      headers: {
        "User-Agent": process.env.USER_AGENT || "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
      },
      timeout: 20000
    });
    html = data;
  }

  // 2) פרסינג כל השורות
  const rows = extractRows(html);

  // 3) סינון לפי .env
  const sent = await loadSent();
  const toSend = [];

  for (const r of rows) {
    // סוג עסקה (P/S/…)
    if (TYPES.length && !TYPES.includes(r.tradeCode)) continue;

    // ימים אחורה (Filing & Trade)
    const dFiled = daysAgoFrom(r.filingDateTime);
    const dTrade = daysAgoFrom(r.tradeDate);
    if (!(dFiled <= MAX_DAYS_FILED)) continue;
    if (!(dTrade <= MAX_DAYS_TRADE)) continue;

    // מחיר מינימום
    if (!(Number.isFinite(r.price) && r.price >= MIN_PRICE)) continue;

    // מינימום שווי עסקה באלפי $
    if (Number.isFinite(MIN_VALUE_K) && MIN_VALUE_K > 0) {
      const absVal = Math.abs(r.value);
      if (!(Number.isFinite(absVal) && absVal >= MIN_VALUE_K * 1000)) continue;
    }

    // מניעת כפילויות
    const key = makeKey(r);
    if (sent.has(key)) continue;

    toSend.push({ key, r });
  }
  
  // סדר את התוצאות מהישן לחדש כך שבבודעות החדשות ביותר יפורסמו אחרונות
  toSend.sort((a, b) => {
    const toMs = (x) => {
      const fd = Date.parse((x.r.filingDateTime || "").replace(" ", "T") + "Z");
      const td = Date.parse((x.r.tradeDate || "").replace(" ", "T") + "Z");
      return Number.isFinite(td) ? td : fd; // סדר לפי Trade, ואם חסר – לפי Filing
    };
    return toMs(a) - toMs(b); // ישן -> חדש
  });

  // 4) שליחה + לוג
  const limited = toSend.slice(0, MAX_PER_RUN);
  let sentCount = 0;

  if (EMBED_MODE) {
    for (let i = 0; i < limited.length; i += EMBEDS_PER_REQ) {
      const slice = limited.slice(i, i + EMBEDS_PER_REQ);
      const embeds = slice.map(({ r }) => buildEmbed(r));
      await sendDiscordEmbeds(embeds);
      for (const { key } of slice) {
        await appendSent(key);
        sent.add(key);
        sentCount++;
      }
      await sleep(RATE_LIMIT_MS);
    }
  } else {
    for (const { key, r } of limited) {
      const line = oneLine(r);
      await sendDiscordText(line);
      await appendSent(key);
      sent.add(key);
      sentCount++;
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log(`[done] parsed=${rows.length}, sent=${sentCount}, filters: types=${TYPES.join("+")}, minPrice=${MIN_PRICE}, minValueK=${MIN_VALUE_K}, maxDaysFiled=${MAX_DAYS_FILED}, maxDaysTrade=${MAX_DAYS_TRADE}`);
})().catch(err => {
  console.error("ERROR:", err?.response?.status, err?.response?.statusText, err?.message);
  process.exit(1);
});

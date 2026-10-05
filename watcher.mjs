// 任天堂博物館購票監控:輪詢公開日曆 API,狀態變化時發 Telegram / Email 通知。
// 用法:
//   node watcher.mjs           執行一次檢查(正式模式,供 GitHub Actions 呼叫)
//   node watcher.mjs --dry     只顯示目前狀態與差異,不通知、不寫入狀態檔
//   node watcher.mjs --test    只發送測試通知,不做檢查
//   node watcher.mjs --selftest  驗證比對邏輯(不需要網路)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://museum-tickets.nintendo.com';
const CALENDAR_PAGE = `${BASE_URL}/en/calendar`;
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const flags = new Set(process.argv.slice(2));
const DRY = flags.has('--dry');
const TEST_NOTIFY = flags.has('--test');
const SELFTEST = flags.has('--selftest');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

// 日期一律以日本時間(JST)判斷,和博物館的售票節奏一致
function jstToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function weekdayZh(dateStr) {
  return WEEKDAY_ZH[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

function fmtDate(dateStr) {
  return `${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}(${weekdayZh(dateStr)})`;
}

// state 內每一天的格式:[apply_type, sale_status, open_status, is_temporary_closure]
// apply_type: 2=抽選 3=一般販售|null;sale_status: 1=有票 2=售完|null;open_status: 1=開館 2=休館|null
function isAvailable(entry) {
  return Array.isArray(entry) && entry[0] === 3 && entry[1] === 1 && entry[2] === 1 && entry[3] === 0;
}

function statusLabel(entry) {
  if (entry == null) return '尚未公布';
  if (entry[3] === 1) return '臨時休館';
  if (entry[2] === 2) return '休館(每週二)';
  if (entry[0] === 2) return '抽選申請中(不可直接購買)';
  if (entry[0] === 3) {
    if (entry[1] === 1) return '有票可買';
    if (entry[1] === 2) return '已售完';
  }
  return '狀態不明';
}

async function fetchCalendar(year, month) {
  const url = `${BASE_URL}/en/api/calendar?target_year=${year}&target_month=${month}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'nintendo-museum-ticket-watcher/1.0 (personal use)',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const calendar = json?.data?.calendar;
      if (!calendar || typeof calendar !== 'object') throw new Error('回應格式不如預期');
      return calendar;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`無法取得 ${year}-${String(month).padStart(2, '0')} 日曆:${lastErr.message}`);
}

// 某月所有日期皆無資料時回傳 null(表示該月售票資訊尚未公布)
function compactCalendar(calendar) {
  const hasData = Object.values(calendar).some((v) => v && v.apply_type !== null);
  if (!hasData) return null;
  const out = {};
  for (const [date, v] of Object.entries(calendar)) {
    out[date] = [v.apply_type, v.sale_status, v.open_status, v.is_temporary_closure ? 1 : 0];
  }
  return out;
}

function diffEvents(prevMonths, nextMonths, cfg, todayJst) {
  const events = [];
  for (const [month, days] of Object.entries(nextMonths)) {
    const prevDays = prevMonths ? prevMonths[month] : undefined;
    if (prevDays === undefined) continue; // 新加入監控的月份只建立基準,不通知
    if (prevDays === null && days !== null) {
      events.push({ type: 'month-open', month });
      continue;
    }
    if (!days || !prevDays) continue;
    for (const [date, entry] of Object.entries(days)) {
      if (date <= todayJst) continue; // 過去的日期不可購買,不用通知
      const was = isAvailable(prevDays[date] ?? null);
      const now = isAvailable(entry);
      if (was === now) continue;
      events.push({ type: now ? 'available' : 'soldout', date, isTarget: cfg.targetDates.includes(date) });
    }
  }
  return events.sort((a, b) => (a.date || a.month).localeCompare(b.date || b.month));
}

function buildChangeMessage(events, cfg) {
  const avail = events.filter((e) => e.type === 'available');
  const soldout = events.filter((e) => e.type === 'soldout' && cfg.notifyWhenSoldOutAgain !== false);
  const opened = events.filter((e) => e.type === 'month-open');
  const lines = [];
  if (avail.length) {
    lines.push('【有票了!】下列日期出現可購票狀態:');
    for (const e of avail) lines.push(`- ${fmtDate(e.date)}${e.isTarget ? '  ← 你的目標日期!' : ''}`);
  }
  if (soldout.length) {
    if (lines.length) lines.push('');
    lines.push('【又售完】先前可買的日期已售完:');
    for (const e of soldout) lines.push(`- ${fmtDate(e.date)}`);
  }
  if (opened.length) {
    if (lines.length) lines.push('');
    lines.push('【售票資訊公布】');
    for (const e of opened) lines.push(`- ${e.month} 的日期狀態已可查看`);
  }
  if (!lines.length) return '';
  lines.push('', '購票頁面(登入後盡快結帳):', CALENDAR_PAGE, '釋出的票通常幾分鐘內會被搶完,請立即行動。');
  return lines.join('\n');
}

function buildSubject(events) {
  const avail = events.filter((e) => e.type === 'available');
  if (avail.length) return `【任天堂博物館】有票了!${avail.map((e) => fmtDate(e.date)).join('、')}`;
  const opened = events.filter((e) => e.type === 'month-open');
  if (opened.length) return `【任天堂博物館】${opened.map((e) => e.month).join('、')} 售票資訊公布`;
  return '【任天堂博物館】售票狀態更新';
}

function buildStartupMessage(cfg, months, todayJst) {
  const lines = ['【監控已啟動】任天堂博物館購票監控'];
  lines.push(`監控月份:${cfg.watchMonths.join('、')}`);
  lines.push(`目標日期現況(今日 ${todayJst} JST):`);
  for (const d of cfg.targetDates) {
    const monthKey = d.slice(0, 7);
    const entry = months[monthKey] ? months[monthKey][d] : undefined;
    lines.push(`- ${fmtDate(d)}:${statusLabel(entry ?? null)}`);
  }
  lines.push('', '這些目標日期或監控月份內出現「有票」變化時,會立即通知。');
  lines.push(`購票頁面:${CALENDAR_PAGE}`);
  return lines.join('\n');
}

function getChannels() {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const tgChat = process.env.TELEGRAM_CHAT_ID?.trim();
  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim();
  const mailTo = process.env.MAIL_TO?.trim();

  const telegram = tgToken && tgChat ? { token: tgToken, chatId: tgChat } : null;
  const mail =
    smtpUser && smtpPass && mailTo
      ? {
          host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
          port: Number(process.env.SMTP_PORT || 465),
          user: smtpUser,
          pass: smtpPass,
          to: mailTo,
          from: process.env.MAIL_FROM?.trim() || smtpUser,
        }
      : null;

  if (!telegram && (tgToken || tgChat)) log('警告:Telegram 設定不完整,需要 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID 成對設定');
  if (!mail && (smtpUser || smtpPass || mailTo)) log('警告:Email 設定不完整,需要 SMTP_USER、SMTP_PASS、MAIL_TO 三者齊全');
  return { telegram, mail };
}

async function sendTelegram(cfg, text) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram API 失敗: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
}

async function sendMail(cfg, subject, text) {
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({ from: cfg.from, to: cfg.to, subject, text });
}

async function sendAll(text, subject) {
  const { telegram, mail } = getChannels();
  const results = { telegram: null, mail: null };
  if (DRY) {
    console.log('--- [DRY RUN] 通知內容預覽 ---');
    console.log(`主旨:${subject}`);
    console.log(text);
    console.log('--- [DRY RUN] 結束 ---');
    return results;
  }
  if (telegram) {
    try {
      await sendTelegram(telegram, text);
      results.telegram = true;
      log('Telegram 通知已送出');
    } catch (e) {
      results.telegram = false;
      log('Telegram 通知失敗:', e.message);
    }
  }
  if (mail) {
    try {
      await sendMail(mail, subject, text);
      results.mail = true;
      log('Email 通知已送出');
    } catch (e) {
      results.mail = false;
      log('Email 通知失敗:', e.message);
    }
  }
  return results;
}

function printDryReport(prevState, nextState, cfg, todayJst) {
  console.log(`(dry-run:今日 JST ${todayJst};不發通知、不寫狀態)`);
  for (const [month, days] of Object.entries(nextState.months)) {
    console.log(`\n== ${month} ==`);
    if (!days) {
      console.log('  尚未公布售票資訊');
      continue;
    }
    const avail = [], sold = [], closed = [], lottery = [], other = [];
    for (const [d, e] of Object.entries(days)) {
      if (e[3] === 1 || e[2] === 2) closed.push(d);
      else if (e[0] === 2) lottery.push(d);
      else if (e[0] === 3 && e[1] === 1) avail.push(d);
      else if (e[0] === 3 && e[1] === 2) sold.push(d);
      else other.push(d);
    }
    console.log(`  有票:${avail.length ? avail.map(fmtDate).join('、') : '無'}`);
    console.log(`  售完:${sold.length} 天    休館:${closed.length} 天${closed.length ? `(${closed.map(fmtDate).join('、')})` : ''}`);
    if (lottery.length) console.log(`  抽選中:${lottery.length} 天`);
    if (other.length) console.log(`  其他:${other.map(fmtDate).join('、')}`);
    for (const d of cfg.targetDates.filter((x) => x.startsWith(month))) {
      console.log(`  [目標] ${fmtDate(d)}:${statusLabel(days[d] ?? null)}`);
    }
  }
  console.log('\n== 與上次狀態的差異 ==');
  if (!prevState?.months || !Object.keys(prevState.months).length) {
    console.log('  無先前狀態(首次正式執行時會發送「監控已啟動」通知)');
  } else {
    const events = diffEvents(prevState.months, nextState.months, cfg, todayJst);
    if (!events.length) console.log('  無變化');
    else {
      for (const e of events) {
        console.log(`  ${e.type}${e.date ? ` ${fmtDate(e.date)}` : ` ${e.month}`}${e.isTarget ? ' (目標日期)' : ''}`);
      }
      const text = buildChangeMessage(events, cfg);
      console.log('\n--- 正式執行時會發送的內容 ---');
      console.log(text || '(依設定,不需通知)');
    }
  }
}

function runSelftest() {
  const t = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
    if (!cond) process.exitCode = 1;
  };
  const cfg = { targetDates: ['2026-10-24', '2026-10-25'] };
  const today = '2026-10-05';
  const prev = {
    '2026-10': {
      '2026-10-24': [3, 2, 1, 0],
      '2026-10-25': [3, 1, 1, 0],
      '2026-10-26': [3, 2, 1, 0],
      '2026-10-27': [3, 1, 2, 0],
    },
  };
  const next = {
    '2026-10': {
      '2026-10-24': [3, 1, 1, 0],
      '2026-10-25': [3, 2, 1, 0],
      '2026-10-26': [3, 2, 1, 0],
      '2026-10-27': [3, 1, 2, 0],
    },
    '2026-12': null,
  };
  const ev = diffEvents(prev, next, cfg, today);
  t('偵測售完→有票,且標記為目標日期', ev.some((e) => e.type === 'available' && e.date === '2026-10-24' && e.isTarget));
  t('偵測有票→售完', ev.some((e) => e.type === 'soldout' && e.date === '2026-10-25'));
  t('休館日 ss=1 不算有票', !ev.some((e) => e.date === '2026-10-27'));

  const ev2 = diffEvents({ '2026-12': null }, { '2026-12': { '2026-12-01': [3, 1, 1, 0] } }, cfg, today);
  t('偵測月份首次公布(month-open),不重複逐日通知', ev2.length === 1 && ev2[0].type === 'month-open');

  const ev3 = diffEvents(prev, { '2026-10': { '2026-10-01': [3, 1, 1, 0] } }, cfg, today);
  t('過去的日期不通知', ev3.length === 0);

  const ev4 = diffEvents({ '2026-10': { '2026-10-24': [3, 2, 1, 0] } }, next, cfg, '2026-09-30');
  t('未來的日期正常偵測', ev4.some((e) => e.type === 'available' && e.date === '2026-10-24'));

  const msg = buildChangeMessage(ev, cfg);
  t('訊息包含日期與目標標記', msg.includes('10/24') && msg.includes('目標日期'));

  const msgQuiet = buildChangeMessage([{ type: 'soldout', date: '2026-10-25' }], { ...cfg, notifyWhenSoldOutAgain: false });
  t('關閉「又售完」通知時不產生內容', msgQuiet === '');
}

async function main() {
  if (SELFTEST) return runSelftest();

  const todayJst = jstToday();
  const { telegram, mail } = getChannels();
  if (!DRY && !telegram && !mail) {
    log('錯誤:未設定任何通知管道。請設定 Telegram(TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)或 Email(SMTP_USER/SMTP_PASS/MAIL_TO)。');
    process.exit(1);
  }

  if (TEST_NOTIFY) {
    const text = [
      '【測試通知】任天堂博物館購票監控運作中。',
      `時間:${new Date().toISOString()}`,
      `監控月份:${config.watchMonths.join('、')}`,
      `目標日期:${config.targetDates.join('、')}`,
    ].join('\n');
    const results = await sendAll(text, '【任天堂博物館】監控測試通知');
    process.exit(DRY || Object.values(results).some((v) => v === true) ? 0 : 1);
  }

  let prevState = null;
  try {
    prevState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    prevState = null;
  }

  const nextMonths = {};
  for (const m of config.watchMonths) {
    const [y, mm] = m.split('-').map(Number);
    const calendar = await fetchCalendar(y, mm);
    let compact = compactCalendar(calendar);
    if (compact === null && prevState?.months?.[m]) {
      log(`注意:${m} 暫時回傳無資料,保留先前狀態,避免誤判`);
      compact = prevState.months[m];
    }
    nextMonths[m] = compact;
    log(`已檢查 ${m}:${compact ? `共 ${Object.keys(compact).length} 天資料` : '尚未公布售票資訊'}`);
  }
  const nextState = { months: nextMonths };

  if (DRY) {
    printDryReport(prevState, nextState, config, todayJst);
    return;
  }

  if (!prevState?.months || !Object.keys(prevState.months).length) {
    const text = buildStartupMessage(config, nextMonths, todayJst);
    log('首次執行:建立狀態基準並發送啟動通知');
    const results = await sendAll(text, '【任天堂博物館】票券監控已啟動');
    if (!Object.values(results).some((v) => v === true)) {
      log('啟動通知發送失敗,本次不寫入狀態,下次執行會重試(請檢查通知設定)');
      process.exit(1);
    }
  } else {
    const events = diffEvents(prevState.months, nextMonths, config, todayJst);
    if (!events.length) {
      log('沒有變化');
    } else {
      const text = buildChangeMessage(events, config);
      if (!text) {
        log(`偵測到 ${events.length} 項變化,但依設定不需通知`);
      } else {
        log(`偵測到 ${events.length} 項變化:\n${text}`);
        const results = await sendAll(text, buildSubject(events));
        if (!Object.values(results).some((v) => v === true)) {
          log('所有通知管道皆失敗,保留舊狀態,下次執行會重試');
          process.exit(1);
        }
      }
    }
  }

  fs.writeFileSync(STATE_FILE, `${JSON.stringify(nextState, null, 1)}\n`);
  log(`狀態已更新:${STATE_FILE}`);
}

main().catch((err) => {
  log('執行失敗:', err.stack || err.message);
  process.exit(1);
});

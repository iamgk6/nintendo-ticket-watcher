// 任天堂博物館購票監控:輪詢公開日曆 API,狀態變化時發 Telegram / Email 通知。
// 用法:
//   node watcher.mjs           執行一次檢查(正式模式,供 GitHub Actions 呼叫)
//   node watcher.mjs --loop-min 55   連續監看 55 分鐘:每 60 秒檢查一次(GitHub Actions 用)
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

function numFlag(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
// --loop-min N:連續監看 N 分鐘,每 --interval-sec 秒(預設 60,下限 20)檢查一次;0=只檢查一次
const LOOP_MIN = numFlag(process.argv, '--loop-min', 0);
const INTERVAL_SEC = Math.max(20, numFlag(process.argv, '--interval-sec', 60));

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

// 免登入的時段 API:每個時段的庫存狀態(1=有位 2=剩少量 3=售完)
async function fetchTimeSlots(date) {
  const url = `${BASE_URL}/en/api/ticket/purchase/timeSchedule?target_date=${date}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'nintendo-museum-ticket-watcher/1.0 (personal use)',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ts = json?.data?.timeSchedules;
      if (!ts || typeof ts !== 'object') throw new Error('回應格式不如預期');
      return Object.values(ts).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`無法取得 ${date} 時段資訊:${lastErr.message}`);
}

// 濃縮成「10:00○ 10:30△」;○=有位、△=剩少量,已滿或臨時休館的時段不列出
function formatSlots(slots) {
  const open = slots.filter((s) => !s.isTemporaryClosure && s.displayStockStatus !== 3);
  if (!open.length) return '全部時段已額滿';
  return open.map((s) => `${(s.startTime || '').slice(0, 5)}${s.displayStockStatus === 2 ? '△' : '○'}`).join(' ');
}

function diffEvents(prevMonths, nextMonths, cfg, todayJst) {
  const events = [];
  for (const [month, days] of Object.entries(nextMonths)) {
    const prevDays = prevMonths ? prevMonths[month] : undefined;
    if (prevDays === undefined) continue; // 新加入監控的月份只建立基準,不通知
    if (prevDays === null && days !== null) {
      const availDays = Object.entries(days)
        .filter(([d, e]) => d > todayJst && isAvailable(e))
        .map(([d]) => d);
      events.push({ type: 'month-open', month, availDays });
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
    for (const e of avail) {
      lines.push(`- ${fmtDate(e.date)}${e.isTarget ? '  ← 你的目標日期!' : ''}`);
      if (e.slots === null) lines.push('  時段:查詢失敗,請直接上購票頁面確認');
      else if (Array.isArray(e.slots)) lines.push(`  時段(○有位/△少量,未列出=已滿):${formatSlots(e.slots)}`);
    }
  }
  if (soldout.length) {
    if (lines.length) lines.push('');
    lines.push('【又售完】下列日期又賣完了(不用前往購票):');
    for (const e of soldout) lines.push(`- ${fmtDate(e.date)}`);
  }
  if (opened.length) {
    if (lines.length) lines.push('');
    lines.push('【售票資訊公布】');
    for (const e of opened) {
      const n = e.availDays?.length || 0;
      lines.push(`- ${e.month} 的日期狀態已可查看${n ? `,目前有票 ${n} 天${e.availDays.some((d) => cfg.targetDates.includes(d)) ? '(含你的目標日期!)' : ''}` : ''}`);
      if (n) lines.push(`  ${e.availDays.slice(0, 8).map(fmtDate).join('、')}${n > 8 ? ' …' : ''}`);
    }
  }
  if (!lines.length) return '';
  if (avail.length || opened.some((e) => e.availDays?.length)) {
    lines.push('', '購票頁面(登入後盡快結帳):', CALENDAR_PAGE, '釋出的票通常幾分鐘內會被搶完,請立即行動。');
  } else if (opened.length) {
    lines.push('', `購票頁面:${CALENDAR_PAGE}`, '目前尚無可購買的日期,出現變化會再通知。');
  } else {
    lines.push('', '此為狀態更新,不需前往購票。');
  }
  return lines.join('\n');
}

function buildSubject(events) {
  const avail = events.filter((e) => e.type === 'available');
  if (avail.length) return `【任天堂博物館】有票了!${avail.map((e) => fmtDate(e.date)).join('、')}`;
  const opened = events.filter((e) => e.type === 'month-open');
  if (opened.length) return `【任天堂博物館】${opened.map((e) => e.month).join('、')} 售票資訊公布`;
  return '【任天堂博物館】又售完通知(不需立即行動)';
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

async function printDryReport(prevState, nextState, cfg, todayJst) {
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
      for (const e of events.filter((e) => e.type === 'available')) {
        try {
          e.slots = await fetchTimeSlots(e.date);
        } catch {
          e.slots = null;
        }
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

  const msgSoldout = buildChangeMessage([{ type: 'soldout', date: '2026-10-25' }], cfg);
  t('售完通知不引導去搶票', msgSoldout.includes('不需前往購票') && !msgSoldout.includes('立即行動'));

  const slots = [
    { startTime: '10:00:00', displayStockStatus: 1 },
    { startTime: '10:30:00', displayStockStatus: 2 },
    { startTime: '11:00:00', displayStockStatus: 3 },
    { startTime: '11:30:00', displayStockStatus: 1, isTemporaryClosure: true },
  ];
  t('時段格式:○ 與 △,排除售完/臨時休館', formatSlots(slots) === '10:00○ 10:30△');
  t('時段全滿時顯示提示', formatSlots([{ startTime: '10:00:00', displayStockStatus: 3 }]) === '全部時段已額滿');

  const msgSlots = buildChangeMessage([{ type: 'available', date: '2026-10-24', isTarget: true, slots }], cfg);
  t('有票訊息包含時段資訊', msgSlots.includes('10:00○') && msgSlots.includes('目標日期'));
  const msgSlotsFail = buildChangeMessage([{ type: 'available', date: '2026-10-24', isTarget: true, slots: null }], cfg);
  t('時段查詢失敗時提示改看購票頁', msgSlotsFail.includes('查詢失敗'));

  const ev5 = diffEvents({ '2026-12': null }, { '2026-12': { '2026-12-01': [3, 1, 1, 0], '2026-12-02': [3, 2, 1, 0] } }, cfg, today);
  const msg5 = buildChangeMessage(ev5, cfg);
  t('月份公布時顯示目前有票天數', ev5.length === 1 && ev5[0].availDays?.length === 1 && msg5.includes('目前有票 1 天'));

  t('解析 --loop-min / --interval-sec 參數', numFlag(['--loop-min', '55'], '--loop-min', 0) === 55 && numFlag([], '--loop-min', 0) === 0 && numFlag(['--interval-sec', 'abc'], '--interval-sec', 60) === 60);
}

async function collectMonths(prevState) {
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
  return nextMonths;
}

// 執行一輪檢查;nextState 為 null 表示這輪不寫入狀態(通知未成功,下一輪會重試)
async function checkOnce(prevState) {
  const todayJst = jstToday();
  const nextMonths = await collectMonths(prevState);
  const nextState = { months: nextMonths };

  if (!prevState?.months || !Object.keys(prevState.months).length) {
    const text = buildStartupMessage(config, nextMonths, todayJst);
    log('首次執行:建立狀態基準並發送啟動通知');
    const results = await sendAll(text, '【任天堂博物館】票券監控已啟動');
    if (!Object.values(results).some((v) => v === true)) {
      log('啟動通知發送失敗,本次不寫入狀態,下次執行會重試(請檢查通知設定)');
      return { nextState: null };
    }
    return { nextState };
  }

  const events = diffEvents(prevState.months, nextMonths, config, todayJst);
  if (!events.length) {
    log('沒有變化');
    return { nextState };
  }
  for (const e of events.filter((e) => e.type === 'available')) {
    try {
      e.slots = await fetchTimeSlots(e.date);
    } catch (err) {
      log(`時段查詢失敗 ${e.date}:${err.message}`);
      e.slots = null;
    }
  }
  const text = buildChangeMessage(events, config);
  if (!text) {
    log(`偵測到 ${events.length} 項變化,但依設定不需通知`);
    return { nextState };
  }
  log(`偵測到 ${events.length} 項變化:\n${text}`);
  const results = await sendAll(text, buildSubject(events));
  if (!Object.values(results).some((v) => v === true)) {
    log('所有通知管道皆失敗,保留舊狀態,下次執行會重試');
    return { nextState: null };
  }
  return { nextState };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`);
  log(`狀態已更新:${STATE_FILE}`);
}

async function main() {
  if (SELFTEST) return runSelftest();

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

  if (DRY) {
    const nextMonths = await collectMonths(prevState);
    await printDryReport(prevState, { months: nextMonths }, config, jstToday());
    return;
  }

  if (LOOP_MIN <= 0) {
    const result = await checkOnce(prevState);
    if (!result.nextState) process.exit(1);
    writeState(result.nextState);
    return;
  }

  // 連續監看:GitHub 排程常延遲 10~25 分鐘,用長迴圈把實際檢查間隔壓到約 INTERVAL_SEC 秒
  log(`連續監看模式:每 ${INTERVAL_SEC} 秒檢查一次,持續約 ${LOOP_MIN} 分鐘`);
  const deadline = Date.now() + LOOP_MIN * 60000;
  let rounds = 0;
  while (true) {
    rounds++;
    try {
      const result = await checkOnce(prevState);
      if (result.nextState) {
        if (JSON.stringify(result.nextState) !== JSON.stringify(prevState)) writeState(result.nextState);
        prevState = result.nextState;
      }
    } catch (err) {
      log(`第 ${rounds} 輪檢查失敗(將於下一輪重試):${err.message}`);
    }
    if (Date.now() + INTERVAL_SEC * 1000 > deadline) break;
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
  log(`連續監看結束,共執行 ${rounds} 輪`);
}

main().catch((err) => {
  log('執行失敗:', err.stack || err.message);
  process.exit(1);
});

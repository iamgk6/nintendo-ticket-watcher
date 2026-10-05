# 任天堂博物館購票監控(GitHub Actions 版)

每隔幾分鐘檢查任天堂博物館的售票日曆,當目標日期(10/22-28)或監控月份內出現「有票」狀態時,透過 **Telegram 與 Email** 立即通知你,不用自己一直刷網頁。

程式跑在 GitHub Actions 雲端:**免費、24 小時運作、不佔用你的電腦**。

## 運作原理

- 輪詢售票網站日曆頁使用的公開 API(免登入、免 cookie):
  `https://museum-tickets.nintendo.com/en/api/calendar?target_year=YYYY&target_month=MM`
- 判讀規則:`sale_status` 1=有票 / 2=售完;`open_status` 2=休館(每週二);`apply_type` 2=抽選 / 3=一般販售
- 每次執行與 `state.json`(自動 commit 回 repo)的前次狀態比對,有變化才通知,不會重複洗頻

## 你需要準備

1. **GitHub 帳號**(免費)並建立一個 repo(建議設 **public**:Actions 額度免費且無限;Secrets 不會公開)
2. **Telegram bot**(免費,約 2 分鐘):token + chat id
3. **Gmail 應用程式密碼**(選用,要收 Email 通知才需要)

## 上線步驟

### 1. 上傳程式碼到 GitHub

在 GitHub 建立新 repo 後,在此資料夾執行:

```bash
git init
git add .
git commit -m "init nintendo ticket watcher"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo名稱>.git
git push -u origin main
```

(不熟悉 git 的話,也可以在 repo 頁面選「uploading an existing file」整包拖上去,`.github` 資料夾也會一併上傳)

### 2. 開啟 Actions 寫入權限

Repo → **Settings → Actions → General → Workflow permissions** → 選 **Read and write permissions** → Save。
(程式需要把 `state.json` 寫回 repo 記錄狀態)

### 3. 設定 Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**,加入:

| Name | 值 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather 給的 token |
| `TELEGRAM_CHAT_ID` | 你的 chat id |
| `SMTP_USER` | 你的 Gmail 地址 |
| `SMTP_PASS` | Gmail 應用程式密碼(16 碼) |
| `MAIL_TO` | 收件地址(可多個,逗號分隔) |
| `SMTP_HOST` | 可省略,預設 `smtp.gmail.com` |
| `SMTP_PORT` | 可省略,預設 `465` |
| `MAIL_FROM` | 可省略,預設同 `SMTP_USER` |

只設定 Telegram 或只設定 Email 也可以,至少一組。

### 4. 測試

Repo → **Actions** → 左側選 **Nintendo Museum Ticket Watcher** → **Run workflow** → 勾選 `test` → Run。
若 Telegram / Email 收到測試訊息即完成。之後每 5 分鐘自動檢查,**有變化才會打擾你**。

### Telegram token / chat id 取得方式

1. Telegram 搜尋 **@BotFather** → 傳 `/newbot` → 依指示命名 → 取得 token(形如 `123456789:AA...`)
2. 點開你剛建立的 bot,傳一句「hi」(一定要傳,否則 bot 不能主動密你)
3. 瀏覽器開啟 `https://api.telegram.org/bot<你的TOKEN>/getUpdates`,找到 `"chat":{"id":123456789}` 的數字即為 chat id

### Gmail 應用程式密碼取得方式

1. Google 帳號 → 安全性 → 開啟「兩步驟驗證」
2. 前往 <https://myaccount.google.com/apppasswords> 建立應用程式密碼 → 複製 16 碼(空白可去掉)

## 設定檔(config.json)

| 欄位 | 說明 |
| --- | --- |
| `targetDates` | 目標日期;這些日期出現可購票時,通知會標「你的目標日期!」 |
| `watchMonths` | 監控的月份;這些月份內任何日期的狀態變化都會通知 |
| `notifyWhenSoldOutAgain` | 是否也通知「又售完」,預設 `true` |

## 本機測試(選用)

```bash
npm install
npm run dry        # 顯示目前狀態與差異,不通知、不寫檔
npm run selftest   # 驗證比對邏輯(不需網路)
```

## 注意事項

- GitHub 排程最小間隔 5 分鐘,尖峰時段可能延遲,實際大約 5-20 分鐘一次。
- 通知為「日期」層級;收到後請盡快登入結帳,熱門日期的釋出票通常幾分鐘內被搶完。
- 10/27(週二)為例行休館日,不會有票。
- 本工具只做「通知」,購買請自行手動完成;僅供個人使用。
- 若 60 天完全沒有任何變化,GitHub 可能自動停用排程(每日 heartbeat commit 已盡量避免此情況);收到停用通知時到 Actions 頁面重新啟用即可。

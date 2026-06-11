# Internal AI GUI — Cloudflare Zero Trust AI Portal

企業內部 AI 聊天入口，建構於 Cloudflare Workers 之上：

- **Cloudflare Zero Trust Access** 負責使用者登入驗證（SSO / MFA）
- **Worker 後端** 驗證 Access JWT，依使用者 team 控管可用模型
- **Cloudflare AI Gateway** 統一代理 Workers AI 與第三方模型，記錄含使用者 metadata 的請求 log
- **D1** 儲存稽核紀錄（audit log）與每位使用者各自隔離的對話會話
- **KV** 儲存模型權限政策（team → 可用模型清單）
- 前端為 React SPA，支援串流回覆、多會話、雲端同步、ZTNA 登出

```text
使用者瀏覽器
  -> Cloudflare Zero Trust Access（登入 / MFA）
  -> Worker（React GUI + /api/*）
  -> 驗證 Cf-Access-Jwt-Assertion
  -> AI Gateway（metadata + log）
  -> Workers AI / OpenAI / Anthropic / Google ...
  -> D1（audit log + 使用者會話）
```

---

## 1. 前置需求

| 項目 | 說明 |
|---|---|
| Cloudflare 帳號 | 需可使用 Workers、D1、KV、AI Gateway |
| Zero Trust | 已啟用 Cloudflare Zero Trust（有 team domain，例如 `https://<team>.cloudflareaccess.com`） |
| 網域 | 一個由 Cloudflare 代管的網域，用來綁定正式入口（例如 `ai.example.com`） |
| Node.js | v18 以上（建議 v20+） |
| Wrangler | 隨專案安裝，指令用 `npx wrangler` 即可 |

> 若要使用第三方模型（OpenAI / Anthropic / Google 等），AI Gateway 需設定
> unified billing 或在 Gateway 中存入各 provider 的 API key。
> 只用 Workers AI 模型（`@cf/` 開頭）則不需要。

---

## 2. 建立專案

### 方式 A：從 GitHub clone（已有 repo 時）

```bash
git clone git@github.com:<your-org>/internal-ai-gui.git
cd internal-ai-gui
npm install
```

### 方式 B：從零建立

```bash
npm create cloudflare@latest -- internal-ai-gui --framework=react
cd internal-ai-gui
npm install jose
npm install -D @cloudflare/workers-types
```

然後將本專案的原始檔放入對應位置：

```text
internal-ai-gui/
├── src/
│   ├── workers.ts        # Worker 後端（API + JWT 驗證 + AI Gateway）
│   ├── App.tsx           # React 前端
│   ├── App.css           # 介面樣式
│   └── main.tsx          # React 進入點（cloudflare template 自帶）
├── schema.sql            # D1 稽核表
├── schema-sessions.sql   # D1 使用者會話表
├── wrangler.jsonc        # Worker 設定
└── package.json
```

確認 `src/main.tsx` 有正常載入 App：

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## 3. 建立 Cloudflare 資源

```bash
npx wrangler login

# D1：稽核 + 會話
npx wrangler d1 create internal-ai-audit

# KV：模型權限政策
npx wrangler kv namespace create CONFIG
```

兩個指令會輸出 `database_id` 與 KV `id`，記下來填入下一步的 `wrangler.jsonc`。
若 Wrangler 詢問是否自動寫入設定檔，可以選 yes，但 **D1 binding 名稱務必設為 `DB`**
（程式碼以 `env.DB` 存取；若 Wrangler 自動產生了其他名稱，請手動改回 `DB`）。

---

## 4. 設定 `wrangler.jsonc`

```jsonc
{
  "name": "internal-ai-gui",
  "main": "src/workers.ts",
  "compatibility_date": "2026-06-10",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },

  "ai": { "binding": "AI" },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "internal-ai-audit",
      "database_id": "<你的 D1_DATABASE_ID>",
      "remote": true
    }
  ],

  "kv_namespaces": [
    { "binding": "CONFIG", "id": "<你的 KV_NAMESPACE_ID>" }
  ],

  "vars": {
    "ENVIRONMENT": "prod",
    "AI_GATEWAY_ID": "<你的 AI Gateway 名稱>",
    "CLOUDFLARE_ACCOUNT_ID": "<你的 Account ID>",
    "TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
    "POLICY_AUD": "<Access Application 的 AUD Tag>"
  },

  "observability": { "enabled": true }
}
```

各欄位取得位置：

| 變數 | 哪裡找 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右側欄 / Account Overview |
| `TEAM_DOMAIN` | Zero Trust Dashboard 的 team domain（登入頁網址） |
| `POLICY_AUD` | 第 7 步建立 Access Application 後，在 application 設定中的 **Application Audience (AUD) Tag** |
| `AI_GATEWAY_ID` | 第 6 步建立 AI Gateway 時取的名稱（slug） |

---

## 5. 設定 Secrets

```bash
# Cloudflare API Token，需具 AI Gateway 權限（呼叫第三方模型用）
npx wrangler secret put CLOUDFLARE_API_TOKEN

# 使用者 email 雜湊用的鹽值，自行產生隨機字串：
#   openssl rand -hex 32
npx wrangler secret put USER_HASH_SALT
```

注意事項：

- 兩者都**不可**寫進 `wrangler.jsonc` 的 `vars`、不可進 Git。
- `USER_HASH_SALT` 上線後**不要更換**，否則所有使用者的 `user_hash` 會改變，
  既有會話與稽核紀錄會對不起來。
- 每個環境（staging / prod）使用不同 salt。

---

## 6. 建立 AI Gateway

Cloudflare Dashboard → `AI` → `AI Gateway` → Create Gateway：

1. 取一個名稱（即 `AI_GATEWAY_ID`，例如 `internal-ai`）
2. 啟用 **Logging**（必要，metadata 會出現在這裡）
3. 視需求啟用 Rate limiting / Caching / Guardrails / DLP
4. 若要用第三方模型：設定 unified billing 或存入 provider keys

---

## 7. 建立 Zero Trust Access Application

Zero Trust Dashboard → `Access` → `Applications` → `Add application` → **Self-hosted**：

1. Application domain 填正式入口網域，例如 `ai.example.com`
   （測試期可加一條 `*.workers.dev` 的 hostname，正式上線建議移除）
2. Policy 設定，例如：
   ```text
   Include: Emails ending in @example.com（或 IdP group）
   Require: MFA
   ```
3. 建立後進入 application 設定，複製 **Application Audience (AUD) Tag**，
   填入 `wrangler.jsonc` 的 `POLICY_AUD`

> **重要**：Worker 的 `/api/*` 依賴 Access 注入的 `Cf-Access-Jwt-Assertion` header。
> 沒有被 Access 保護的 hostname（例如裸的 workers.dev）開啟頁面會顯示
> 「需要 Zero Trust 驗證」，這是預期行為。

---

## 8. 初始化 D1 資料表

```bash
npx wrangler d1 execute internal-ai-audit --remote --file=./schema.sql
npx wrangler d1 execute internal-ai-audit --remote --file=./schema-sessions.sql

# 驗證
npx wrangler d1 execute internal-ai-audit --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table';"
# 應看到 ai_audit_logs 與 ai_sessions
```

---

## 9. 寫入模型權限政策（KV）

```bash
npx wrangler kv key put --binding=CONFIG "model_policy" '{
  "default": ["@cf/google/gemma-4-26b-a4b-it"],
  "teams": {
    "internal": [
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/meta/llama-3.1-8b-instruct",
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4"
    ]
  }
}' --remote
```

- `default`：未對應到任何 team 的使用者可用的模型
- `teams.<team>`：各 team 的白名單，`"*"` 代表全部允許
- 日後調整模型**只需更新這個 KV key**，不用重新部署

> team 的判斷邏輯在 `src/workers.ts` 的 `getAccessUser()`，
> 預設以 email 網域結尾判斷，請改成你們的網域：
> ```ts
> team: email.endsWith("@example.com") ? "internal" : "default"
> ```

---

## 10. 建置與部署

```bash
npx wrangler types && npm run build && npx wrangler deploy
```

> 順序很重要：先 `wrangler types`（產生 binding 型別）再 build。
> 之後每次修改 `wrangler.jsonc` 都要重跑 `wrangler types`。

部署完成後，到 Worker 設定綁定正式網域（Custom Domain，例如 `ai.example.com`），
並確認該網域已在第 7 步的 Access Application 涵蓋範圍內。

---

## 11. 驗證清單

| 測試 | 預期結果 |
|---|---|
| 未登入開啟 `ai.example.com` | 被 Zero Trust 登入頁攔下 |
| 登入後開啟頁面 | 側欄底部顯示自己的 email、「Zero Trust 已驗證」綠燈 |
| 選 Workers AI 模型發訊息 | 逐字串流輸出 |
| 選未授權模型（不在 KV 白名單） | 回 403 Model not allowed |
| AI Gateway → Logs | 看得到請求與 metadata（user / team / app / env） |
| D1 查詢 audit | `SELECT created_at, user_email, model, status FROM ai_audit_logs ORDER BY created_at DESC LIMIT 10;` 有資料 |
| 兩個不同帳號各建對話 | 互相看不到對方會話 |
| 同帳號換裝置登入 | 會話同步出現 |
| 點側欄「登出」 | 導向 `/cdn-cgi/access/logout`，重新整理後要求重新登入 |

---

## 12. 常見問題（Troubleshooting）

**Build 報 `Cannot find name 'Fetcher' / 'Ai' / 'D1Database'`**
先跑 `npx wrangler types` 再 build；確認已安裝 `@cloudflare/workers-types`。

**Deploy 報 `assets.directory does not exist`**
代表前一步 `npm run build` 失敗、`dist/` 沒產生。先修 build 錯誤。
建議固定使用 `npx wrangler types && npm run build && npx wrangler deploy` 串接，避免 build 失敗仍繼續部署。

**`/api/me` 回 401 Missing Cloudflare Access JWT**
該 hostname 沒有被 Access Application 保護，或 `TEAM_DOMAIN` / `POLICY_AUD` 填錯。

**某些模型回應卡在打字動畫**
前端已同時相容兩種串流格式（Workers AI 經典 `{response}` 與 OpenAI 相容
`choices[0].delta.content`，並忽略 `delta.reasoning`）。若仍發生，
請強制重新整理（Ctrl+Shift+R）確認瀏覽器沒有吃到舊版 JS。

**第三方模型回錯誤**
確認 `CLOUDFLARE_API_TOKEN` 權限、AI Gateway 的 provider key / unified billing 設定。

**更換 `USER_HASH_SALT` 後會話消失**
預期行為 — user_hash 變了。正式環境請勿更換 salt。

---

## 13. 可調整項目

| 項目 | 位置 |
|---|---|
| 預設模型 | `src/workers.ts` 的 `DEFAULT_MODEL` |
| team 對應規則 | `src/workers.ts` 的 `getAccessUser()` |
| AI Gateway metadata 欄位（email 或 hash） | `src/workers.ts` 的 `handleChat()` 中 `metadata.user`（上限 5 個欄位） |
| 模型白名單 | KV `model_policy`（即時生效） |
| 介面配色 / 字體 | `src/App.css` 的 `:root` CSS 變數 |
| 登出範圍 | `src/App.tsx` 登出按鈕 — 相對路徑為單一應用登出；改成 `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout` 為全域登出 |

---

## 14. 發佈到 GitHub（私有 repo）

### 14.1 確認 `.gitignore`

專案根目錄需有 `.gitignore`（本 repo 已附），至少排除：

```gitignore
node_modules/
dist/
.wrangler/
worker-configuration.d.ts
.env
.env.*
.dev.vars
*.log
.DS_Store
```

**Secrets（`CLOUDFLARE_API_TOKEN`、`USER_HASH_SALT`）由 `wrangler secret put` 存在
Cloudflare，本來就不在任何檔案裡，不會進 Git。**
`wrangler.jsonc` 內的 Account ID、AUD tag、KV/D1 id 不是機密等級資訊，
放在私有 repo 可接受；若要開源公開，建議改用範本檔
（`wrangler.example.jsonc` + 實際檔案加入 `.gitignore`）。

### 14.2 建立私有 repo 並推送

**方式 A — GitHub 網頁**：

1. GitHub → New repository → 名稱 `internal-ai-gui` → Visibility 選 **Private** → Create
2. 本機推送：

```bash
cd internal-ai-gui
git init
git add .
git commit -m "Initial commit: Zero Trust AI GUI on Cloudflare Workers"
git branch -M main
git remote add origin git@github.com:<your-org>/internal-ai-gui.git
git push -u origin main
```

**方式 B — GitHub CLI（gh）**：

```bash
cd internal-ai-gui
git init && git add . && git commit -m "Initial commit"
gh repo create <your-org>/internal-ai-gui --private --source=. --push
```

推送前最後檢查沒有敏感檔案被加入：

```bash
git status
git ls-files | grep -Ei "dev.vars|\.env|secret" || echo "OK: no secret files tracked"
```

### 14.3（可選）Git 自動部署

兩種做法擇一：

**A. Cloudflare Workers Builds（推薦，零設定 CI）**
Cloudflare Dashboard → Workers → 你的 Worker → Settings → Build →
Connect 到 GitHub repo。之後 push 到 main 即自動 build + deploy。
私有 repo 需在連結時授權 Cloudflare GitHub App 存取該 repo。

**B. GitHub Actions**
在 repo Settings → Secrets and variables → Actions 新增
`CLOUDFLARE_API_TOKEN`（需 Workers 部署權限），建立
`.github/workflows/deploy.yml`：

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx wrangler types
      - run: npm run build
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

> 注意：`wrangler secret put` 設定的 runtime secrets 與部署用的
> `CLOUDFLARE_API_TOKEN` 是兩回事；前者已存在 Cloudflare，CI 不需要重設。

---

## 15. 後續擴充建議

- Admin 稽核查詢頁（`/api/audit`，限 admin group）
- AI Gateway Rate limiting / Guardrails / DLP
- Logpush 將 AI Gateway logs 長期保存到 R2
- per-user 每日用量配額
- IdP group claims / SCIM 對應 team，取代 email 網域判斷
- 會話訊息裁切（超過 200KB 上限時自動移除最舊訊息）

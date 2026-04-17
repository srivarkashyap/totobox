# totoboX - Open Source AI API Cost Tracker (VS code Native)

> Real-time cost tracking and analytics for AI APIs. Built with Supabase, Vercel, and VS Code Extension API.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/)

## 📐 Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                        VS Code Extension                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Dashboard   │  │    Logs      │  │  Settings    │     │
│  │   (WebView)  │  │  (WebView)   │  │  (WebView)   │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│         └──────────────────┼──────────────────┘             │
│                            │                                 │
│                    ┌───────▼────────┐                       │
│                    │ Extension Host │                       │
│                    │  (TypeScript)  │                       │
│                    └───────┬────────┘                       │
└────────────────────────────┼──────────────────────────────┘
                             │
                             │ HTTPS
                             │
                    ┌────────▼─────────┐
                    │  Vercel Proxy    │
                    │  (Serverless)    │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐    │    ┌────────▼────────┐
     │   OpenAI API    │    │    │ Anthropic API   │
     └─────────────────┘    │    └─────────────────┘
                            │
                   ┌────────▼────────┐
                   │   Supabase DB   │
                   │  (PostgreSQL)   │
                   └─────────────────┘
```

## 🔄 Request Flow
```
1. User Code (with proxy key)
   ↓
2. Vercel Proxy (/api/proxy)
   ↓ Logs: tokens, cost, latency
   ↓ Stores in Supabase
   ↓
3. AI Provider API (OpenAI/Anthropic)
   ↓
4. Response back to user
   
5. VS Code Extension fetches logs (/api/analytics)
   ↓
6. Displays in Dashboard/Logs tabs
```

## 🗂️ Project Structure
```
totobox/
├── extension/              # VS Code Extension
│   ├── src/
│   │   ├── extension.ts   # Main extension logic
│   │   ├── config/        # Configuration management
│   │   ├── crypto/        # AES-256 encryption
│   │   └── http/          # HTTP client
│   ├── package.json
│   └── tsconfig.json
│
├── api/                   # Vercel Serverless Functions
│   ├── register.ts       # Proxy key generation
│   ├── proxy.ts          # Universal AI proxy
│   ├── analytics.ts      # Usage analytics
│   └── charts.ts         # Chart data aggregation
│
├── supabase/             # Database migrations & types
│   └── migrations/
│
└── README.md
```

## 🛠️ Tech Stack

### Frontend (VS Code Extension)
- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **State Management**: In-memory + VS Code settings
- **Charts**: Custom canvas rendering
- **Security**: AES-256 encryption for API keys

### Backend (Vercel)
- **Runtime**: Node.js (Serverless Functions)
- **Proxy Logic**: Universal AI API router
- **Logging**: Real-time token/cost tracking
- **Database ORM**: Supabase client

### Database (Supabase)
- **Type**: PostgreSQL
- **Tables**: 
  - `api_calls` - Request logs with full details
  - `proxy_keys` - User proxy key mappings
  - `users` - User metadata
- **Features**: Row-level security, real-time subscriptions

## 🚀 Local Development

### Prerequisites
- Node.js 18+
- VS Code
- Supabase account
- Vercel account

### Setup

1. **Clone Repository**
```bash
   git clone https://github.com/YOUR_USERNAME/totobox.git
   cd totobox
```

2. **Setup Backend**
```bash
   cd api
   npm install
   
   # Create .env.local
   echo "SUPABASE_URL=your_url" > .env.local
   echo "SUPABASE_ANON_KEY=your_key" >> .env.local
   
   vercel dev
```

3. **Setup Extension**
```bash
   cd extension
   npm install
   npm run compile
   
   # Open in VS Code
   code .
   # Press F5 to start debugging
```

4. **Setup Database**
   - Go to Supabase dashboard
   - Run migrations in `/supabase/migrations`
   - Tables will be created automatically

## 📊 Database Schema
```sql
-- api_calls table
CREATE TABLE api_calls (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  total_tokens INTEGER,
  cost_usd DECIMAL(10,6),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- proxy_keys table
CREATE TABLE proxy_keys (
  proxy_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 🔒 Security

- **API Keys**: AES-256 encrypted with unique master key per installation
- **Proxy Keys**: One-way mapping, original API key never exposed
- **Database**: Row-level security policies in Supabase
- **Transport**: All requests over HTTPS
- **Storage**: Local encryption using VS Code's secure storage API

## 🧪 Testing
```bash
# Extension tests
cd extension
npm test

# API tests
cd api
npm test

# E2E test with real API call
curl https://totobox.vercel.app/api/proxy \
  -H "Authorization: Bearer totobox_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-3.5-turbo", "messages": [{"role": "user", "content": "test"}]}'
```

## 📈 Performance

- **Proxy Latency**: ~50-100ms overhead
- **Dashboard Load**: <500ms with caching
- **Database Queries**: Indexed for fast lookups
- **Caching**: 10-second analytics cache

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📝 License

MIT License - see [LICENSE](LICENSE)

## 🙏 Credits

Built by [YOUR_NAME]

Special thanks to:
- Supabase team for amazing backend infrastructure
- VS Code team for excellent extension API
- Open source community

---

**Star ⭐ this repo if you find it useful!**
```

---

## 📋 **Quick Checklist Before Shipping:**
```
Extension:
□ Status bar is clickable
□ Compiles without errors
□ 4 screenshots taken and saved
□ Icon created (icon.png)
□ package.json updated
□ Extension README.md ready

Repository:
□ GitHub repo created
□ Root README.md with architecture
□ LICENSE file (MIT)
□ .gitignore configured
□ All code pushed

Marketplace:
□ Publisher account created
□ Extension packaged (vsce package)
□ Ready to publish

require("dotenv").config({ path: "./.env" });
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool, initSchema } = require("./db");
const { sendPasswordResetEmail } = require("./email");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

if (!process.env.OPENROUTER_API_KEY) {
  console.error("❌ OPENROUTER_API_KEY missing");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) console.warn("⚠ JWT_SECRET not set — tokens reset on restart");

const MODELS = [
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-20b:free",
  "stepfun/step-3.5-flash:free",
  "arcee-ai/trinity-large-preview:free",
  "minimax/minimax-m2.5:free",
];

// ── Auth Middleware ──
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── OpenRouter Helpers ──
const getHeaders = () => ({
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  "Content-Type": "application/json",
  "HTTP-Referer": process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost:5000",
  "X-Title": "CodeInsight AI",
});

async function tryModel(model, messages) {
  return axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    { model, stream: true, messages },
    { headers: getHeaders(), responseType: "stream", timeout: 90000, validateStatus: () => true }
  );
}

async function readErrorBody(stream) {
  return new Promise((resolve) => {
    let body = "";
    stream.on("data", (c) => (body += c.toString()));
    stream.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        resolve(parsed.error?.message || "Unknown error");
      } catch { resolve("Unknown error"); }
    });
  });
}

async function streamCompletion(res, messages) {
  let lastError = "All models unavailable";
  for (const model of MODELS) {
    let response;
    try {
      response = await tryModel(model, messages);
    } catch (err) {
      lastError = err.message;
      continue;
    }
    if (response.status === 200) {
      console.log(`✅ Using model: ${model}`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      response.data.on("data", (chunk) => res.write(chunk));
      response.data.on("end", () => res.end());
      response.data.on("error", () => res.end());
      return;
    }
    const errMsg = await readErrorBody(response.data);
    console.error(`❌ ${model} HTTP ${response.status}: ${errMsg}`);
    lastError = errMsg;
    if (response.status !== 429 && response.status !== 400 && response.status !== 503) break;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: {"choices":[{"delta":{"content":"⚠ API Error: ${lastError.replace(/"/g, "'")}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  res.end();
}

// ── Auth Routes ──
app.post("/api/auth/signup", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (username.length < 2) return res.status(400).json({ error: "Username must be at least 2 characters" });
  try {
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username, theme",
      [username.trim(), email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    await pool.query("INSERT INTO user_stats (user_id) VALUES ($1)", [user.id]);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, theme: user.theme } });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [user.id]);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, theme: user.theme } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, email, theme, created_at FROM users WHERE id = $1", [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to get user" });
  }
});

app.put("/api/auth/theme", requireAuth, async (req, res) => {
  const { theme } = req.body;
  if (!["dark", "light"].includes(theme)) return res.status(400).json({ error: "Invalid theme" });
  try {
    await pool.query("UPDATE users SET theme = $1 WHERE id = $2", [theme, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update theme" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    const result = await pool.query("SELECT id, email FROM users WHERE email = $1", [email.toLowerCase()]);
    if (!result.rows.length) {
      return res.json({ success: true, message: "If that email is registered, a reset link has been sent." });
    }
    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 3600000);
    await pool.query("UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3", [token, expiry, user.id]);
    const domain = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost:5000";
    const resetUrl = `${domain}/reset-password.html?token=${token}`;
    const emailResult = await sendPasswordResetEmail(user.email, resetUrl);
    if (emailResult.devMode) {
      return res.json({ success: true, message: "Reset link logged to server console (email not configured).", devMode: true, resetUrl });
    }
    res.json({ success: true, message: "If that email is registered, a reset link has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ error: "Failed to process request" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const result = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()",
      [token]
    );
    if (!result.rows.length) return res.status(400).json({ error: "Invalid or expired reset token" });
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2",
      [hash, result.rows[0].id]
    );
    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    console.error("Reset password error:", err.message);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ── Stats Routes ──
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM user_stats WHERE user_id = $1", [req.userId]);
    if (!result.rows.length) {
      await pool.query("INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.userId]);
      return res.json({ errors_explained: 0, code_analyses: 0, code_reviews: 0, ai_chats: 0 });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});

app.post("/api/stats/:type", requireAuth, async (req, res) => {
  const colMap = { error: "errors_explained", analyze: "code_analyses", review: "code_reviews", chat: "ai_chats" };
  const col = colMap[req.params.type];
  if (!col) return res.status(400).json({ error: "Invalid stat type" });
  try {
    await pool.query(
      `INSERT INTO user_stats (user_id, ${col}) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET ${col} = user_stats.${col} + 1`,
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update stat" });
  }
});

// ── History Routes ──
app.get("/api/history", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, type, input_text, output_text, language, created_at FROM user_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to get history" });
  }
});

app.post("/api/history", requireAuth, async (req, res) => {
  const { type, input, output, language } = req.body;
  if (!type || !input) return res.status(400).json({ error: "Type and input required" });
  try {
    const result = await pool.query(
      "INSERT INTO user_history (user_id, type, input_text, output_text, language) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [req.userId, type, input, output || "", language || null]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: "Failed to save history" });
  }
});

app.delete("/api/history", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM user_history WHERE user_id = $1", [req.userId]);
    await pool.query(
      "UPDATE user_stats SET errors_explained=0, code_analyses=0, code_reviews=0, ai_chats=0 WHERE user_id=$1",
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear history" });
  }
});

app.delete("/api/history/:id", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM user_history WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ── AI Tool Routes (protected) ──
app.post("/api/explain", requireAuth, async (req, res) => {
  const { error } = req.body;
  if (!error) return res.status(400).json({ error: "No input provided" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are an expert programming assistant. Explain this error or code issue in clear, simple language. Provide:\n1. What the error means\n2. Why it happens\n3. How to fix it (with corrected code example)\n\nUse markdown formatting.\n\n**Input:**\n\`\`\`\n${error}\n\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

app.post("/api/analyze", requireAuth, async (req, res) => {
  const { code, language } = req.body;
  if (!code) return res.status(400).json({ error: "No code provided" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `Analyze this ${language || ""} code thoroughly. Structure your response with these sections using markdown:\n\n## ⏱ Time & Space Complexity\nProvide Big O analysis with explanation.\n\n## 🐛 Issues Found\nList bugs, anti-patterns, security issues, or problems.\n\n## ✨ Suggested Improvements\nProvide specific improvements with refactored code examples.\n\n## 📊 Code Quality Score\nRate 1–10 with a brief justification.\n\n\`\`\`${language?.toLowerCase() || ""}\n${code}\n\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    await streamCompletion(res, [
      { role: "system", content: "You are CodeInsight AI, an expert senior software engineer and programming assistant. Help users with code, debugging, system design, algorithms, and best practices. Be concise but thorough. Use markdown with code blocks when providing code examples." },
      ...messages,
    ]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

app.post("/api/review", requireAuth, async (req, res) => {
  const { code, language, context } = req.body;
  if (!code) return res.status(400).json({ error: "No code provided" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are a senior code reviewer. Do a thorough code review of this ${language || ""} code${context ? ` (context: ${context})` : ""}.\n\nProvide feedback in these sections:\n\n## 🔒 Security\n## ⚡ Performance\n## 📐 Architecture & Design\n## 🧹 Code Style & Readability\n## ✅ What's Good\n## 🚀 Priority Action Items\n\n\`\`\`${language?.toLowerCase() || ""}\n${code}\n\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Code Translator ──
app.post("/api/translate", requireAuth, async (req, res) => {
  const { code, from, to } = req.body;
  if (!code || !to) return res.status(400).json({ error: "Code and target language required" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are an expert polyglot programmer who thinks in multiple languages. Translate this ${from || "code"} to idiomatic ${to} — meaning: don't just do a mechanical syntax swap. Use the target language's native patterns, idioms, standard library, conventions, and best practices exactly as a native ${to} developer would write it.

Structure your response as:

## 🔄 Translated ${to} Code
\`\`\`${to.toLowerCase().replace(/\+\+/g, "pp").replace(/\s/g, "")}
[the fully translated, idiomatic ${to} code]
\`\`\`

## 🔁 Key Translation Decisions
Explain 3-5 specific choices you made and why (e.g., what data structures, error handling, or paradigms changed and why they're the right choice in ${to}).

## 🌍 Idiomatic Differences
What fundamentally changes between ${from || "the source language"} and ${to} for this type of code (mindset shift, not just syntax).

Original ${from || "code"}:
\`\`\`
${code}
\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Interview Coach ──
app.post("/api/interview", requireAuth, async (req, res) => {
  const { code, language, level } = req.body;
  if (!code) return res.status(400).json({ error: "Code required" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are a principal engineer at a top-tier tech company conducting a technical interview. Based on this specific ${language || "code"}, generate 5 targeted interview questions that test deep understanding of exactly what this code does, the patterns it uses, and the concepts behind it. Calibrate for ${level || "mid-level"} engineers.

Make questions specific to THIS code — not generic. Reference actual variable names, functions, or logic from the code.

For each question:

### Q[N]: [The question — specific to the code]

**🎯 What this tests:** [skill/concept being evaluated]

**✅ Strong Answer:** [comprehensive model answer an excellent candidate would give]

**⚠️ Red Flag Answer:** [what a weak answer sounds like — helps the user know what to avoid]

**➡️ Follow-up:** [a harder follow-up question to push deeper]

---

Code being interviewed on:
\`\`\`${language?.toLowerCase() || ""}
${code}
\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Job Description Analyzer ──
app.post("/api/jobanalyze", requireAuth, async (req, res) => {
  const { jd, background } = req.body;
  if (!jd) return res.status(400).json({ error: "Job description required" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are a senior technical recruiter and career coach with 15+ years of experience at FAANG and top tech companies. Analyze this job description and give an aspiring candidate a thorough, actionable breakdown.

${background ? `Candidate background: ${background}` : ""}

Job Description:
${jd}

Provide a complete analysis structured as:

## 🎯 Role Snapshot
In 3 sentences: what this role actually does day-to-day, what team they'd join, and the career trajectory.

## 🔑 Must-Have Skills (Non-Negotiable)
List every hard requirement. For each:
- **[Skill]** — Why it matters for this role + how deeply they likely need it (surface/working/deep)

## ⭐ Nice-to-Have Skills
Skills that differentiate candidates but aren't blocking. For each, note if it's becoming a must-have in the industry.

## 📊 Skill Gap Analysis
${background ? "Based on the candidate's background, identify:" : "For a typical junior/mid candidate, identify:"}
- **Strong matches**: what they likely already know
- **Gap areas**: what needs focused preparation
- **Quick wins**: skills that can be learned in 1-2 weeks

## 🗓️ 30-Day Preparation Plan

### Week 1: Foundation
- Day 1-3: [specific tasks]
- Day 4-5: [specific tasks]
- Weekend: [project/practice]

### Week 2: Core Skills
[same structure]

### Week 3: Interview Prep
[same structure]

### Week 4: Polish & Apply
[same structure]

## 💬 Interview Topics to Expect
The 5-7 most likely technical interview topics for this specific role, based on the JD.

## 🚩 Red Flags to Avoid
Common mistakes candidates make when applying to this type of role.

## 💡 Insider Tips
2-3 things that will make a candidate stand out for THIS specific role (not generic advice).`,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Code Simplifier ──
app.post("/api/simplify", requireAuth, async (req, res) => {
  const { code, language, audience } = req.body;
  if (!code) return res.status(400).json({ error: "Code required" });
  const audienceMap = {
    beginner: "a complete beginner who is new to programming — use the simplest possible constructs, avoid jargon, use descriptive names",
    intermediate: "an intermediate developer who knows the basics but may not know advanced patterns or language-specific idioms",
    simplify: "an experienced developer who just wants clean, readable, idiomatic code without clever tricks",
  };
  const audienceDesc = audienceMap[audience] || audienceMap.beginner;
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are an expert teacher and clean code specialist. Simplify and explain this ${language || "code"} for ${audienceDesc}.

## ✨ Simplified Code
Rewrite the code to be as clear and readable as possible. Add explanatory comments on any non-obvious line. Keep the same functionality — just make it easier to understand.

\`\`\`${language?.toLowerCase() || ""}
[simplified version with clear comments on complex parts]
\`\`\`

## 📖 How It Works — Step by Step
Walk through what the code does in numbered plain-English steps. No jargon. Explain it like you're talking to a smart person who just hasn't seen this before.

## 🧩 Concepts & Patterns Used
For each non-trivial concept, pattern, or language feature in the code:
- **[Concept name]**: [1-2 sentence plain-English explanation with an analogy if helpful]

## 💡 Things to Know
Any gotchas, common mistakes with this type of code, or things worth understanding about how it works.

Original code:
\`\`\`${language?.toLowerCase() || ""}
${code}
\`\`\``,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── System Design Practice ──
app.post("/api/sysdesign", requireAuth, async (req, res) => {
  const { topic, level } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic required" });
  try {
    await streamCompletion(res, [{
      role: "user",
      content: `You are a staff engineer at a top tech company conducting a system design interview. Guide the candidate through designing "${topic}" for a ${level || "mid-level"} engineering role.

Structure your response as a complete system design walkthrough:

## 🏗️ System Design: ${topic}

### 📋 Requirements Clarification
List the 5-6 most important clarifying questions you'd ask the interviewer, then answer them with reasonable assumptions.

**Functional Requirements:**
- [Core features the system must support]

**Non-Functional Requirements:**
- Scale: [users, requests/sec, data volume estimates]
- Latency: [acceptable response times]
- Availability: [uptime requirements]
- Consistency: [strong vs eventual]

### 📐 Capacity Estimation
Back-of-envelope calculations:
- **Traffic**: [reads/sec, writes/sec]
- **Storage**: [data size estimates]
- **Bandwidth**: [throughput needs]
- **Memory**: [cache size estimates]

### 🗺️ High-Level Architecture
Describe the major components and how they connect. Include:
- Client layer
- Load balancers / API Gateway
- Application servers
- Databases (primary + replicas)
- Caches
- Message queues (if needed)
- CDN (if needed)

\`\`\`
[ASCII architecture diagram showing component relationships]
\`\`\`

### 🗄️ Database Design
- **Database choice**: SQL vs NoSQL — which and why for this system
- **Schema / Data model**: key tables or document structures
- **Indexes**: which fields to index and why
- **Sharding strategy**: if needed, how to partition data

### ⚡ Deep Dive: Critical Components
Pick the 2-3 most interesting/complex components and explain them in detail:

**[Component 1]:**
- How it works internally
- Why this approach over alternatives
- Failure modes and handling

### 🔧 Key Design Decisions & Tradeoffs
For each major decision, explain the tradeoff:
- **[Decision]**: Chose X over Y because... The tradeoff is...

### 📈 Scaling Strategy
- **Horizontal scaling**: where and how
- **Caching strategy**: what to cache, where, eviction policy
- **Database scaling**: read replicas, sharding, federation
- **Bottlenecks**: identify top 3 and mitigation strategies

### 🚨 Failure Handling & Reliability
- Single points of failure and how to eliminate them
- Data replication strategy
- Circuit breakers and fallbacks
- Monitoring and alerting approach

### 🎤 Interview Tips for This Design
3-4 specific things to mention proactively that impress interviewers for this particular system.`,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Learning Roadmap ──
app.post("/api/roadmap", requireAuth, async (req, res) => {
  const { topic, currentLevel } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic required" });
  try {
    const histResult = await pool.query(
      "SELECT type, input_text, language FROM user_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [req.userId]
    );
    const history = histResult.rows;
    const histContext = history.length > 2
      ? `\nDeveloper's actual coding history shows they work with: ${[...new Set(history.map(h => h.language).filter(Boolean))].join(", ") || "various languages"}.`
      : "";

    await streamCompletion(res, [{
      role: "user",
      content: `You are a senior engineering mentor who creates highly practical, personalized learning roadmaps. Create a detailed step-by-step roadmap for learning "${topic}" for a ${currentLevel || "beginner"} developer.${histContext}

Make this roadmap CONCRETE — not vague advice. Each step must have a clear duration, a specific list of topics, and a hands-on project.

## 🗺️ ${topic} Learning Roadmap
**For:** ${currentLevel || "Beginner"} | **Total Estimated Time:** [X weeks/months]

---

### 📍 Prerequisites
What to know before starting (be honest). If truly none needed, say so.

---

### Step 1 — [Phase Name, e.g. "Core Fundamentals"]
**⏱ Duration:** [e.g. Week 1–2 | ~10 hrs total]
**🎯 Goal:** [One sentence — what you'll be able to do after this step]

**📚 Topics to Cover:**
1. [Topic] — [1-sentence why it matters]
2. [Topic] — [1-sentence why it matters]
3. [Topic] — ...
(4–6 topics per step)

**🛠 Hands-on Project:**
Build [specific mini-project] — [what it practices]

**✅ Ready for next step when:** [specific, testable milestone]

---

### Step 2 — [Phase Name]
**⏱ Duration:** [e.g. Week 3–4 | ~12 hrs total]
[same structure]

---

### Step 3 — [Phase Name]
**⏱ Duration:** [...]
[same structure]

---

### Step 4 — [Phase Name, e.g. "Build Real Things"]
**⏱ Duration:** [...]
[same structure — include at least 1 full project idea with clear scope]

---

### Step 5 — [Advanced / Specialization] *(optional)*
**⏱ Duration:** [...]
[same structure — optional deeper topics for those who want more]

---

### 🧭 Top 3 Pitfalls
The most common mistakes learners make with ${topic} — and exactly how to avoid each one.

---

### ✅ "I Know ${topic}" Milestone
One paragraph: what a person who has completed this roadmap can concretely build or do. Be specific.`,
    }]);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Failed to process" });
    else res.end();
  }
});

// ── Start ──
const PORT = process.env.PORT || 5000;
initSchema().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 CodeInsight AI running at http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error("❌ DB init failed:", err.message);
  process.exit(1);
});

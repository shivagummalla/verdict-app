// ══════════════════════════════════════════════════════
//  VERDICT v2 — Backend
//  npm install && node server.js
//  env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY
// ══════════════════════════════════════════════════════
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Clients ────────────────────────────────────────────
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supabase (optional but recommended — replaces in-memory store)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log('✅ Supabase connected — votes will persist');
} else {
  console.log('⚠️  No Supabase — using in-memory (votes reset on restart)');
}

// ── In-memory fallback ─────────────────────────────────
const memVotes = {}; // { dilemmaId: { a, b } }
let totalVotes = 3100000;

// ── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════════════════
//  POST /api/vote
// ══════════════════════════════════════════════════════
app.post('/api/vote', async (req, res) => {
  const { dilemmaId, choice } = req.body;
  if (!dilemmaId || !['a','b'].includes(choice))
    return res.status(400).json({ error: 'Invalid params' });

  try {
    if (supabase) {
      // Upsert vote count in Supabase
      const { data, error } = await supabase.rpc('increment_vote', {
        p_dilemma_id: dilemmaId,
        p_choice: choice,
      });
      if (error) throw error;
      return res.json({ success: true, ...data });
    }

    // In-memory fallback
    if (!memVotes[dilemmaId]) memVotes[dilemmaId] = { a: 0, b: 0 };
    memVotes[dilemmaId][choice]++;
    totalVotes++;
    const { a, b } = memVotes[dilemmaId];
    const tot = a + b;
    res.json({
      success: true, dilemmaId,
      votesA: a, votesB: b,
      pctA: Math.round(a/tot*100), pctB: Math.round(b/tot*100),
      totalVotes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  POST /api/generate  — AI Dilemma Generator (v2 prompt)
// ══════════════════════════════════════════════════════
app.post('/api/generate', async (req, res) => {
  const { count = 3 } = req.body;

  // ┌─────────────────────────────────────────────────────────┐
  // │  UPGRADED VIRAL PROMPT — tuned for Indian Gen Z (2026)  │
  // └─────────────────────────────────────────────────────────┘
  const SYSTEM = `You are a viral "Would You Rather" content creator who deeply understands
Indian Gen Z culture (ages 18–28) in 2026. You create dilemmas that go viral because they:

RULES FOR VIRAL DILEMMAS:
1. Each dilemma must be GENUINELY HARD — aim for 45–55% splits, never obvious
2. Must be RELATABLE to Indian students, young workers, and urban Gen Z
3. Reference Indian context naturally — money in ₹, desi food, Indian career pressure, etc.
4. The "hook" text is CRITICAL — it's the clickbait that makes someone tap. Examples:
   - "99% of people get this wrong — here's why"
   - "Only 28% chose this. Are you in the minority?"
   - "This one question ended two friendships in testing"
   - "Rich people answer this very differently than students"
   - "Your answer reveals your attachment style"
5. Options must be SHORT — max 8 words each
6. Questions must be SHORT — max 20 words
7. NEVER do politics, religion, caste, or anything that gets banned

CATEGORIES:
- money: Financial dilemmas with ₹ amounts, career trade-offs
- love: Relationship psychology, emotional vs physical attraction  
- career: Job vs passion, fame vs anonymity, hustle culture
- food: Cuisine wars, food restrictions, taste vs health
- chaos: Embarrassing scenarios, social media, privacy
- dark: Existential questions, memory, identity

Return ONLY valid compact JSON (no markdown, no explanation):
{
  "dilemmas": [
    {
      "cat": "chaos",
      "hook": "😱 Only 23% chose this — can you explain it?",
      "hookBg": "rgba(168,85,247,.08)",
      "hookColor": "var(--violet)",
      "q": "Short punchy question here?",
      "a": { "em": "🔥", "txt": "Short option A" },
      "b": { "em": "💀", "txt": "Short option B" },
      "vA": 45000,
      "vB": 48000
    }
  ]
}

hookBg and hookColor must use these CSS vars: --violet, --green, --red, --blue, --amber, --cyan`;

  try {
    const msg = await ai.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Generate ${count} dilemmas. Mix categories. Make each hook genuinely clickbait-worthy. Make each question genuinely difficult to answer. Fresh and culturally relevant for India 2026.`,
      }],
    });

    let raw = msg.content[0].text.trim();
    // strip any accidental markdown
    raw = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    const fresh = parsed.dilemmas.map((d, i) => ({
      ...d,
      id: `ai_${Date.now()}_${i}`,
    }));

    res.json({ success: true, dilemmas: fresh });
  } catch (err) {
    console.error('AI gen error:', err.message);
    res.status(500).json({ error: 'Generation failed', details: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  GET /api/leaderboard  — Most controversial questions
// ══════════════════════════════════════════════════════
app.get('/api/leaderboard', async (req, res) => {
  try {
    if (supabase) {
      const { data } = await supabase
        .from('votes')
        .select('dilemma_id, votes_a, votes_b')
        .order('votes_a + votes_b', { ascending: false })
        .limit(10);
      return res.json({ leaderboard: data || [] });
    }
    const lb = Object.entries(memVotes).map(([id, { a, b }]) => ({
      dilemmaId: id, votesA: a, votesB: b, total: a+b,
      controversy: 1 - Math.abs(a/(a+b) - 0.5)*2,
    })).sort((x,y)=>y.controversy - x.controversy).slice(0,10);
    res.json({ leaderboard: lb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  GET /api/stats
// ══════════════════════════════════════════════════════
app.get('/api/stats', (req, res) => {
  res.json({
    totalVotes,
    activeQuestions: Object.keys(memVotes).length + 7,
    liveVoters: Math.floor(Math.random() * 12000) + 15000,
  });
});

// ══════════════════════════════════════════════════════
//  Serve frontend
// ══════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
  ⚡ VERDICT v2 running at http://localhost:${PORT}
  ══════════════════════════════════════════════
  
  💰 MONETIZATION CHECKLIST:
  
  1. AdSense — add your pub-ID to index.html (3 slots ready)
  2. Supabase — add SUPABASE_URL + SUPABASE_KEY to .env
  3. Deploy → Railway: run "railway up" in this folder
  
  📈 TRAFFIC STRATEGY:
  
  Instagram Reels (best ROI):
  → Record voting + reaction to a controversial result
  → "Only 23% of people chose this 😱" as caption
  → 1-2 Reels/day → expect 1k–50k views each
  
  Reddit:
  → Post dilemma text to r/polls, r/wouldyourather
  → Include link in comments
  
  WhatsApp Broadcast:
  → "Are you in the 28%?" + screenshot + link
  
  ₹ PROJECTED REVENUE (AdSense ₹80-150 RPM):
  10k/day users  → ₹2,400–₹4,500/day
  50k/day users  → ₹12,000–₹22,500/day
  100k/day users → ₹24,000–₹45,000/day
  `);
});

/* ══════════════════════════════════════════════════════
   SUPABASE SETUP SQL (run once in Supabase dashboard)
   
   CREATE TABLE votes (
     dilemma_id TEXT PRIMARY KEY,
     votes_a    INT DEFAULT 0,
     votes_b    INT DEFAULT 0,
     updated_at TIMESTAMPTZ DEFAULT NOW()
   );
   
   CREATE OR REPLACE FUNCTION increment_vote(p_dilemma_id TEXT, p_choice TEXT)
   RETURNS JSON AS $$
   DECLARE result JSON;
   BEGIN
     INSERT INTO votes (dilemma_id, votes_a, votes_b)
     VALUES (p_dilemma_id, 0, 0)
     ON CONFLICT (dilemma_id) DO NOTHING;
     
     IF p_choice = 'a' THEN
       UPDATE votes SET votes_a = votes_a + 1 WHERE dilemma_id = p_dilemma_id;
     ELSE
       UPDATE votes SET votes_b = votes_b + 1 WHERE dilemma_id = p_dilemma_id;
     END IF;
     
     SELECT json_build_object(
       'votesA', votes_a, 'votesB', votes_b,
       'pctA', ROUND(votes_a::numeric/(votes_a+votes_b)*100),
       'pctB', ROUND(votes_b::numeric/(votes_a+votes_b)*100)
     ) INTO result FROM votes WHERE dilemma_id = p_dilemma_id;
     RETURN result;
   END;
   $$ LANGUAGE plpgsql;
══════════════════════════════════════════════════════ */

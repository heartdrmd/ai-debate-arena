require('dotenv').config({ override: true });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // Bypass broken index.js debug code
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config (10MB max, stored in memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Claude API proxy ──────────────────────────────────────────────
app.post('/api/chat/claude', async (req, res) => {
  try {
    const { model, messages, maxTokens, systemPrompt } = req.body;
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens || 1024,
      system: systemPrompt || '',
      messages,
    });
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    res.json({ text, usage: response.usage });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── OpenAI API proxy ──────────────────────────────────────────────
app.post('/api/chat/openai', async (req, res) => {
  try {
    const { model, messages, maxTokens, systemPrompt } = req.body;
    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push(...messages);

    const response = await openai.chat.completions.create({
      model,
      messages: msgs,
      max_completion_tokens: maxTokens || 1024,
    });
    const text = response.choices[0].message.content;
    res.json({ text, usage: response.usage });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Judge endpoint (can use either provider) ──────────────────────
app.post('/api/judge', async (req, res) => {
  try {
    const { provider, model, positionA, positionB, question, previousClaims, maxTokens } = req.body;

    const prevClaimsBlock = previousClaims
      ? `\nPREVIOUS ROUND CLAIMS (for drift detection):\n${JSON.stringify(previousClaims)}\n`
      : '';

    const judgePrompt = `You are an expert debate judge performing a rigorous multi-dimensional evaluation.

QUESTION: ${question}
${prevClaimsBlock}
POSITION A (current round): ${positionA}

POSITION B (current round): ${positionB}

Score EACH side on these dimensions (0-100 each). Be harsh and precise — don't inflate scores:

1. ARGUMENT STRENGTH: Are claims well-supported with reasoning? Or vague/hand-wavy?
2. EVIDENCE QUALITY: Are specific facts, studies, examples cited? Or just opinions?
3. LOGICAL CONSISTENCY: Is the reasoning internally coherent? Any contradictions?
4. NOVEL CONTRIBUTION: Did this round introduce genuinely new ideas? Or recycled old ones?
5. INTELLECTUAL HONESTY: Did they honestly engage with the opponent? Concede valid points?

Then evaluate the DEBATE as a whole:
6. CONVERGENCE: How much do the two positions substantively agree? (not just tone)
7. STALENESS: Are the same arguments being recycled across rounds?

Finally, extract each side's KEY CLAIMS as short bullet points (for tracking drift across rounds).

Respond with EXACTLY this JSON and nothing else:
{
  "scores_a": { "argument": <0-100>, "evidence": <0-100>, "logic": <0-100>, "novelty": <0-100>, "honesty": <0-100> },
  "scores_b": { "argument": <0-100>, "evidence": <0-100>, "logic": <0-100>, "novelty": <0-100>, "honesty": <0-100> },
  "convergence_score": <0-100>,
  "stale": <true if same arguments recycled with no new substance>,
  "claims_a": ["claim 1", "claim 2", "..."],
  "claims_b": ["claim 1", "claim 2", "..."],
  "agreements": ["point both sides now agree on", "..."],
  "remaining_disputes": ["unresolved disagreement", "..."],
  "drift_detected": <true if positions shifted meaningfully from previous round>,
  "summary": "2-3 sentence assessment of this round"
}`;

    let text;
    if (provider === 'anthropic') {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens || 1024,
        system: 'You are a debate judge. Respond only with valid JSON.',
        messages: [{ role: 'user', content: judgePrompt }],
      });
      text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } else {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are a debate judge. Respond only with valid JSON.' },
          { role: 'user', content: judgePrompt },
        ],
        max_completion_tokens: maxTokens || 1024,
      });
      text = response.choices[0].message.content;
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    jsonStr = jsonStr.trim();

    const judgment = JSON.parse(jsonStr);
    res.json(judgment);
  } catch (err) {
    console.error('Judge error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Final summary endpoint ────────────────────────────────────────
app.post('/api/summary', async (req, res) => {
  try {
    const { provider, model, debateHistory, question, maxTokens } = req.body;

    const summaryPrompt = `You just witnessed a complete AI debate. Provide a final verdict.

QUESTION: ${question}

FULL DEBATE TRANSCRIPT:
${debateHistory}

Provide:
1. A brief summary of how the debate evolved
2. Key points both sides agreed on
3. Remaining points of disagreement
4. Which side presented stronger arguments and why
5. A synthesized "best answer" that combines the strongest points from both sides

Format your response clearly with headers.`;

    let text;
    if (provider === 'anthropic') {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens || 2048,
        messages: [{ role: 'user', content: summaryPrompt }],
      });
      text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } else {
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: summaryPrompt }],
        max_completion_tokens: maxTokens || 2048,
      });
      text = response.choices[0].message.content;
    }
    res.json({ text });
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── File upload & text extraction ─────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, mimetype, buffer, size } = req.file;
    let text = '';

    if (mimetype === 'application/pdf') {
      const pdf = await pdfParse(buffer);
      text = pdf.text;
    } else if (mimetype.startsWith('text/') || [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/csv',
    ].includes(mimetype) || originalname.match(/\.(txt|md|csv|json|xml|html|htm|rtf|log)$/i)) {
      text = buffer.toString('utf-8');
    } else {
      // Try to read as text anyway (catches many formats)
      try {
        text = buffer.toString('utf-8');
        // Check if it's actually readable text (not binary garbage)
        const nonPrintable = text.slice(0, 1000).replace(/[\x20-\x7E\t\n\r]/g, '');
        if (nonPrintable.length > text.slice(0, 1000).length * 0.3) {
          return res.status(400).json({ error: 'Unsupported file format. Use PDF, TXT, MD, CSV, or other text files.' });
        }
      } catch {
        return res.status(400).json({ error: 'Could not read file' });
      }
    }

    // Truncate very long documents (keep first ~50k chars to fit in context)
    const maxChars = 50000;
    const truncated = text.length > maxChars;
    if (truncated) text = text.substring(0, maxChars);

    res.json({
      filename: originalname,
      size,
      chars: text.length,
      truncated,
      text,
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Failed to process file: ' + err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚔️  AI Debate Arena running at http://localhost:${PORT}\n`);
});

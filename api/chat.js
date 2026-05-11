// api/chat.js  — Vercel Serverless Function
// Receives question + pre-searched context, calls Claude, returns answer

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey, message, context, history = [] } = req.body;

  if (!apiKey)  return res.status(400).json({ error: 'apiKey is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  const systemPrompt = context
    ? `You are a website assistant. You ONLY answer questions using the website content provided below.

STRICT RULES:
1. Answer ONLY from the WEBSITE CONTENT section. Use no outside knowledge.
2. If the answer is not in the content, say exactly: "This information is not available in the provided website data."
3. Content marked [SUBJECTIVE] may reflect opinions or marketing — note this when relevant.
4. Content marked [FACTUAL] is reliable data.
5. When possible, mention which page your answer comes from.
6. Be concise and accurate.

WEBSITE CONTENT:
${context}

--- END OF WEBSITE CONTENT ---`
    : `You are a website assistant. No website has been crawled yet. 
Tell the user they need to add and crawl a website first before you can answer questions about it.
Do not answer from general knowledge.`;

  // Build message array (last N turns)
  const messages = [
    ...history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      const msg = err?.error?.message || claudeRes.statusText;
      if (claudeRes.status === 401) {
        return res.status(401).json({ error: 'Invalid API key. Check Settings.' });
      }
      return res.status(claudeRes.status).json({ error: `Claude API: ${msg}` });
    }

    const data = await claudeRes.json();
    const reply = data.content?.map(b => b.text || '').join('').trim()
      || 'No response received.';

    return res.status(200).json({ reply });

  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}

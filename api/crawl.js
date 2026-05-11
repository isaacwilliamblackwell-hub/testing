// api/crawl.js  — Vercel Serverless Function
// Crawls a website via BFS, streams progress as newline-delimited JSON

export const config = { maxDuration: 60 }; // 60s max on Vercel hobby

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, depth = 2, maxPages = 40, apiKey } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

  // Set up streaming response (newline-delimited JSON)
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const parsed = new URL(url);
    const baseDomain = parsed.hostname;

    const visited = new Set();
    const queue = [{ url: normalizeUrl(url), depth: 0 }];
    const pages = [];
    let processed = 0;

    while (queue.length > 0 && pages.length < maxPages) {
      const { url: current, depth: d } = queue.shift();

      if (visited.has(current)) continue;
      visited.add(current);

      send({ type: 'progress', pct: Math.round((pages.length / maxPages) * 90), text: `Crawling: ${current}` });

      const page = await fetchPage(current);
      if (!page) continue;

      pages.push({
        url: current,
        title: page.title,
        text: page.text,
        type: classifyContent(page.text),
      });

      processed++;

      // Enqueue internal links if not at max depth
      if (d < depth) {
        const links = extractLinks(page.html, current, baseDomain);
        for (const link of links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: d + 1 });
          }
        }
      }

      // Small delay to be polite
      await sleep(250);
    }

    send({ type: 'done', pages });

  } catch (err) {
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
}

// ── Fetch & Parse ──────────────────────────────────────────────────────
async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteAI-Crawler/1.0)',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;

    const html = await res.text();
    const title = extractTitle(html);
    const text = extractText(html);

    if (text.length < 80) return null;

    return { html, title, text };
  } catch {
    return null;
  }
}

// ── HTML Parsing ───────────────────────────────────────────────────────
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : 'Untitled';
}

function extractText(html) {
  let text = html;
  // Remove noise blocks
  text = text.replace(/<(script|style|noscript|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Block-level → newline
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|td|th|br)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // Collapse whitespace
  text = text.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  return text.slice(0, 8000); // cap per-page
}

function extractLinks(html, baseUrl, baseDomain) {
  const links = [];
  const hrefRe = /<a[^>]+href=["']([^"'#?][^"']*)["'][^>]*>/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], baseUrl);
      if (resolved.hostname !== baseDomain) continue;
      if (!['http:', 'https:'].includes(resolved.protocol)) continue;
      // Strip fragment and tracking params
      resolved.hash = '';
      ['utm_source','utm_medium','utm_campaign','fbclid','gclid'].forEach(p => resolved.searchParams.delete(p));
      const clean = resolved.toString().replace(/\/$/, '');
      if (clean) links.push(clean);
    } catch { /* skip bad URLs */ }
  }
  return [...new Set(links)];
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// ── Content Classifier ─────────────────────────────────────────────────
function classifyContent(text) {
  const lower = text.toLowerCase();
  const subjectiveKw = ['best','amazing','incredible','revolutionary','world-class',
    'we believe','our vision','proud','excited','passionate','love','opinion','feel',
    'should','must','industry-leading','exceptional','unparalleled'];
  const factualKw = ['defined as','refers to','according to','data shows','research',
    'study','report','percent','%','founded','established','located','headquarters',
    'employees','specification','requires','supports','compatible','price','total'];

  let sScore = subjectiveKw.filter(k => lower.includes(k)).length;
  let fScore = factualKw.filter(k => lower.includes(k)).length;

  if (sScore > fScore + 2) return 'subjective';
  if (fScore > sScore + 2) return 'factual';
  return 'mixed';
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

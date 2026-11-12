export const BLOCKED_TERMS = ['casino', 'gambling', 'guaranteed returns', 'investment opportunity', 'nsfw', 'porn'];

const decodeEntities = (text) =>
  text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 32));

/** Pulls the visible text (title, meta description/keywords, body text) out of an HTML document. */
export function extractHtmlText(html) {
  const pick = (re) => re.exec(html)?.[1] ?? '';
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((tag) => tag[0])
    .filter((tag) => /\b(?:name|property)\s*=\s*["'](?:description|keywords|og:title|og:description)["']/i.test(tag))
    .map((tag) => /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag))
    .map((match) => match?.[1] ?? match?.[2] ?? '');
  const body = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities([title, ...metas, body].join(' ')).replace(/\s+/g, ' ').trim();
}

function buildPageText(build) {
  if (!build?.ok || !build.headBuffer?.length) return null;
  const head = build.headBuffer.subarray(0, 512).toString('utf8');
  const looksHtml = build.contentType === 'text/html' || /^\s*(?:<!doctype html|<html)/i.test(head);
  if (looksHtml) return { kind: 'html', text: extractHtmlText(build.headBuffer.toString('utf8')) };
  if (build.contentType === 'application/json' || build.contentType.endsWith('+json')) return { kind: 'json', text: build.headBuffer.toString('utf8') };
  return null;
}

/**
 * Keyword policy scan over the game metadata and, when the build URL serves text,
 * over the text extracted from the build page itself. `build` is the shared `fetchBuild` result.
 */
export function contentPolicy(game, build) {
  const metadata = `${game.title ?? ''} ${game.blurb ?? ''} ${game.description ?? ''}`.toLowerCase();
  const metadataHits = BLOCKED_TERMS.filter((term) => metadata.includes(term));
  const page = buildPageText(build);
  const pageHits = page ? BLOCKED_TERMS.filter((term) => page.text.toLowerCase().includes(term)) : [];
  const terms = [...new Set([...metadataHits, ...pageHits])];
  const evidence = { classifier: 'keyword-v1', buildPageScanned: Boolean(page) };
  if (page) evidence.buildPageKind = page.kind;
  if (terms.length) {
    const sources = [metadataHits.length ? 'metadata' : null, pageHits.length ? 'build_page' : null].filter(Boolean);
    return { name: 'content_policy', status: 'flagged', evidence: { ...evidence, terms, sources, reason: `blocked terms found in ${sources.join(' and ')}: ${terms.join(', ')}` } };
  }
  return { name: 'content_policy', status: 'passed', evidence };
}

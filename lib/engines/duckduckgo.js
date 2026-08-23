/**
 * DuckDuckGo web-search adapter — self-contained plain-JavaScript ESM port of
 * oh-my-pi's `web/search/providers/duckduckgo.ts` (MIT licensed).
 *
 * Strategy (unchanged from upstream): POST the query to DuckDuckGo's no-JS
 * HTML frontend (`https://html.duckduckgo.com/html/`) and scrape the static
 * results page. The Instant Answer API was rejected upstream because it only
 * covers Wikipedia/Wolfram-style topics. Requests MUST carry browser-like
 * navigation headers AND go through Node's global fetch (undici TLS
 * fingerprint) — curl-style clients receive 403 from this frontend.
 *
 * Only Node builtins + global fetch are used; no imports from other project
 * files (small helpers are duplicated rather than shared).
 *
 * Live-tested deviation from upstream (documented): POST stays the primary
 * transport, but when it fails at the HTTP layer the module automatically
 * retries once via the GET variant of the same frontend, which some throttle
 * states keep serving after rejecting form posts.
 *
 * @param {object} p
 * @param {string} p.query            plain query string (operators like site:/OR/- pass through)
 * @param {number} [p.limit=10]       max results (clamp 1..20)
 * @param {'day'|'week'|'month'|'year'} [p.recency]
 * @param {number} [p.timeoutMs]      hard timeout for the whole engine call (default 25000)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{engine: string, sources: Array<{title:string, url:string, snippet?:string, publishedAt?:string}>}>}
 * @throws Error with a descriptive message (mentions DuckDuckGo) when blocked/failed
 */
export async function searchDuckDuckGo(p) {
	const query = typeof p?.query === "string" ? p.query.trim() : "";
	if (!query) throw new Error("duckduckgo: a non-empty query string is required");

	const numResults = clampNumResults(p.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(p.signal, p.timeoutMs);

	let form = new URLSearchParams({ q: query, kl: "us-en" });
	const df = RECENCY_TO_DDG_DF[p.recency];
	if (df) form.set("df", df);
	// Match real browser form submission (upstream comment: b: "" comes from the
	// browser fetch template).
	form.set("b", "");

	const sources = [];
	const seen = new Set();

	try {
		while (form && sources.length < numResults) {
			const html = await callDuckDuckGoHtml(form, signal);
			const sourceCount = sources.length;
			for (const result of parseHtmlResults(html)) {
				if (seen.has(result.url)) continue;
				seen.add(result.url);
				const source = { title: result.title, url: result.url };
				if (result.snippet) source.snippet = result.snippet;
				if (result.publishedDate) source.publishedAt = result.publishedDate;
				sources.push(source);
				if (sources.length >= numResults) break;
			}

			// Stop when a page yields nothing new (empty result set, exhausted
			// depth) instead of looping on repeated results.
			if (sources.length === sourceCount) break;
			form = parseContinuationForm(html);
		}
	} catch (error) {
		throw normalizeError(error);
	}

	return { engine: "duckduckgo", sources };
}

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 25_000;

/** Recency → DDG `df` form param (single letters; absent = unfiltered). */
const RECENCY_TO_DDG_DF = { day: "d", week: "w", month: "m", year: "y" };

/**
 * Static desktop-Mac-Chrome navigation fingerprint — self-contained stand-in
 * for oh-my-pi's randomized HeaderGenerator output (its deterministic
 * fallback profile). Without these headers the HTML frontend answers 403 to
 * non-browser clients. Accept-Encoding is intentionally left to undici so it
 * manages compression/decompression itself.
 */
const BROWSER_NAVIGATION_HEADERS = Object.freeze({
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
});

/**
 * Compose a caller-supplied signal with a hard timeout so the outbound
 * fetch() is guaranteed to settle within `ms` even if cancellation fails to
 * propagate to the transport (port of upstream withHardTimeout).
 */
function withHardTimeout(signal, ms = DEFAULT_TIMEOUT_MS) {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Clamp a result count to [1, max], defaulting when absent/NaN (upstream clampNumResults). */
function clampNumResults(value, defaultVal, maxVal) {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

/**
 * Decode an HTML-encoded fragment lifted from DDG markup. Strips inline tags
 * (the results page wraps query terms in `<b>`), unescapes the small set of
 * named entities DDG emits, and normalises whitespace. (Verbatim port.)
 */
function decodeHtmlText(value) {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a DDG result href back to the underlying target URL. DDG routes
 * outbound clicks through `//duckduckgo.com/l/?uddg=<encoded>`; unwrap it.
 * Handles redirect wrappers, protocol-relative links, and absolute URLs.
 * (Verbatim port.)
 */
function unwrapResultUrl(href) {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
	if (wrapMatch) {
		try {
			return decodeURIComponent(wrapMatch[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
	return undefined;
}

/**
 * Lift a result row's publication timestamp from DDG markup. Recent DDG HTML
 * renders it as a bare `<span>&nbsp; &nbsp; 2026-07-30T20:19:00…</span>`
 * inside `result__extras__url`; restrict the scan to that container so a
 * date-shaped value in a snippet is not misattributed. (Verbatim port.)
 */
function extractPublishedDate(block) {
	const extrasUrl = /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
	if (!extrasUrl) return undefined;
	for (const match of extrasUrl.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
		const text = decodeHtmlText(match[1]);
		if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
	}
	return undefined;
}

/**
 * Walk the HTML page and pull out result blocks in document order. Each
 * result lives in a `<div class="result …">` container with
 * `<a class="result__a">` for the title link and an optional sibling
 * `<a|div|span class="result__snippet">`. Sponsored placements, missing
 * snippets, and the trailing pagination row are tolerated. (Verbatim port.)
 */
function parseHtmlResults(html) {
	const results = [];
	const blockRe =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockRe)) {
		const block = match[1];
		const title = titleRe.exec(block);
		if (!title) continue;
		const url = unwrapResultUrl(title[1]);
		if (!url) continue;
		const titleText = decodeHtmlText(title[2]);
		if (!titleText) continue;
		const snippet = snippetRe.exec(block);
		const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
		results.push({
			title: titleText,
			url,
			snippet: snippetText || undefined,
			publishedDate: extractPublishedDate(block),
		});
	}
	return results;
}

/**
 * Extract the hidden fields from DDG's next-page form (needs both `s` and
 * `vqd`). Attribute order varies across responses, so each input tag is
 * parsed independently. (Port of upstream parseContinuationForm.)
 */
function parseContinuationForm(html) {
	for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
		const form = new URLSearchParams();
		for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
			const input = inputMatch[0];
			const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
			if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
		}
		if (form.has("s") && form.has("vqd")) return form;
	}
	return undefined;
}

/**
 * `true` when the returned page is the bot-challenge modal instead of real
 * results. DDG mixes status codes (200 vs 202) on these, so the body check is
 * the reliable signal. (Verbatim port.)
 */
function isAnomalyResponse(html) {
	return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/**
 * Compact provider-tagged HTTP error mapping for quota/auth signals (port of
 * upstream classifyProviderHttpError). Returns null for unmapped statuses.
 */
function classifyHttpError(status, body) {
	const creditPattern = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;
	if (creditPattern.test(body)) return new Error("duckduckgo: credits exhausted");
	if (status === 402) return new Error("duckduckgo: 402 credits exhausted");
	if (status === 401) return new Error("duckduckgo: 401 unauthorized");
	if (status === 403) return new Error("duckduckgo: 403 forbidden");
	return null;
}

/**
 * One request to the HTML frontend plus its response checks (status
 * classification, bot-challenge detection). Shared by the POST and GET paths.
 */
async function fetchDuckDuckGoHtml(url, init, signal) {
	let response;
	try {
		response = await fetch(url, { redirect: "follow", signal, ...init });
	} catch (error) {
		// Network-layer failure (DNS, TLS, socket reset): rethrow through the
		// shared normalizer so the message always identifies the engine.
		throw error instanceof Error ? error : new Error(String(error));
	}

	const body = await response.text();
	const status = response.status;
	if (status < 200 || status >= 300) {
		const classified = classifyHttpError(status, body);
		if (classified) throw classified;
		throw new Error(`DuckDuckGo HTML error (${status})`);
	}

	if (isAnomalyResponse(body)) {
		throw new Error(
			"DuckDuckGo blocked the request with a bot-detection challenge (429-style throttle). " +
				"DuckDuckGo rate-limits automated HTML searches from datacenter/shared-egress IPs; " +
				"retry later or configure an alternative provider.",
		);
	}

	return body;
}

function isAbortLike(error) {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function callDuckDuckGoHtml(form, signal) {
	try {
		return await fetchDuckDuckGoHtml(DUCKDUCKGO_HTML_URL, {
			method: "POST",
			body: form.toString(),
			headers: {
				...BROWSER_NAVIGATION_HEADERS,
				Referer: "https://html.duckduckgo.com/",
				"Sec-Fetch-Site": "same-origin",
				"Content-Type": "application/x-www-form-urlencoded",
			},
		}, signal);
	} catch (error) {
		// Aborts propagate untouched; an already-served challenge page is final.
		if (isAbortLike(error) || isAnomalyMessage(error)) throw error;
		// Live-tested fallback: some throttle states reject the POST endpoint
		// while the GET variant of the same frontend keeps serving results.
		return await fetchDuckDuckGoHtml(`${DUCKDUCKGO_HTML_URL}?${form}`, {
			headers: {
				...BROWSER_NAVIGATION_HEADERS,
				Referer: "https://html.duckduckgo.com/",
				"Sec-Fetch-Site": "same-origin",
			},
		}, signal);
	}
}

/** Recognize the anomaly-challenge error thrown by fetchDuckDuckGoHtml. */
function isAnomalyMessage(error) {
	return error instanceof Error && error.message.includes("bot-detection challenge");
}

/** Ensure thrown errors mention the engine and surface abort/timeout clearly. */
function normalizeError(error) {
	const raw = error instanceof Error ? error : new Error(String(error));
	if (raw.name === "AbortError" || raw.name === "TimeoutError") {
		const err = new Error(
			raw.name === "TimeoutError"
				? "DuckDuckGo search timed out before completing"
				: "DuckDuckGo search was aborted before completing",
		);
		err.name = raw.name;
		err.cause = raw;
		return err;
	}
	if (/duckduckgo/i.test(raw.message)) return raw;
	const wrapped = new Error(`duckduckgo: ${raw.message}`);
	wrapped.cause = raw;
	return wrapped;
}

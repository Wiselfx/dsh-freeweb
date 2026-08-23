/**
 * Startpage web-search adapter — self-contained plain-JavaScript ESM port of
 * oh-my-pi's `web/search/providers/startpage.ts` (MIT licensed).
 *
 * Strategy (unchanged from upstream): Startpage proxies Google's index behind
 * a privacy frontend and serves fully server-rendered result pages. Its bot
 * defense keys on requests that skip the homepage handshake — the search form
 * carries a session token (`sc`) plus sibling hidden inputs, and posting with
 * a stale/absent token 302s to the `/en/errors/` CAPTCHA shell. The robust
 * flow is the same dance a real browser performs: GET the homepage, lift the
 * form's hidden inputs (regex-parsed here — no DOM library), POST them back
 * with the query. If the token lift fails, degrade to a tokenless GET.
 *
 * Only Node builtins + global fetch are used; no imports from other project
 * files (the HTML entity decoder is duplicated rather than shared).
 *
 * Live-test deviation from upstream (documented): this deployment fronts the
 * homepage with an Anubis proof-of-work gate (`anubis_challenge` JSON +
 * `/.within.website/x/cmd/anubis/api/pass-challenge`). A real browser solves
 * the SHA-256 challenge in JS and is admitted with a clearance cookie, so the
 * module replicates exactly that dance with node:crypto before lifting the
 * form's hidden inputs.
 *
 * @param {object} p
 * @param {string} p.query            plain query string (operators like site:/OR/- pass through)
 * @param {number} [p.limit=10]       max results (clamp 1..20)
 * @param {'day'|'week'|'month'|'year'} [p.recency]
 * @param {number} [p.timeoutMs]      hard timeout for the whole engine call (default 25000)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{engine: string, sources: Array<{title:string, url:string, snippet?:string}>}>}
 * @throws Error with a descriptive message (mentions Startpage) when blocked/failed
 */
import { createHash } from "node:crypto";

/** Execute a Startpage web search via the homepage-token form flow. */
export async function searchStartpage(p) {
	const query = typeof p?.query === "string" ? p.query.trim() : "";
	if (!query) throw new Error("startpage: a non-empty query string is required");

	const numResults = clampNumResults(p.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const signal = withHardTimeout(p.signal, p.timeoutMs);

	// Per-call cookie jar: fetch() does not persist cookies, but Startpage's
	// bot defense pairs the lifted form token with session cookies issued
	// during the homepage handshake / Anubis proof-of-work pass.
	const jar = new Map();

	try {
		let formInputs = await liftHomepageFormInputs(jar, signal);
		const html = await callStartpageHtml(query, RECENCY_TO_STARTPAGE_WITH_DATE[p.recency], formInputs, jar, signal);
		const sources = [];
		const seen = new Set();
		for (const result of parseHtmlResults(html)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			const source = { title: result.title, url: result.url };
			if (result.snippet) source.snippet = result.snippet;
			sources.push(source);
			if (sources.length >= numResults) break;
		}
		return { engine: "startpage", sources };
	} catch (error) {
		throw normalizeError(error);
	}
}

const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 25_000;

/** Recency → Startpage `with_date` param (single letters; absent = unfiltered). */
const RECENCY_TO_STARTPAGE_WITH_DATE = { day: "d", week: "w", month: "m", year: "y" };

/**
 * Static desktop-Mac-Chrome navigation fingerprint — self-contained stand-in
 * for oh-my-pi's randomized HeaderGenerator output (its deterministic
 * fallback profile). Accept-Encoding is intentionally left to undici so it
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
 * fetch() is guaranteed to settle within `ms` (port of upstream
 * withHardTimeout).
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
 * Decode an HTML-encoded fragment lifted from page markup (duplicate of the
 * shared scraper decoder; strips inline tags, unescapes common named entities,
 * normalises whitespace).
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

/** Collapse whitespace in extracted text. */
function normalizeText(value) {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * `true` when Startpage answered with its CAPTCHA/error shell instead of
 * results. Rejected requests 302 to `/en/errors/` (legacy: `/sp/captcha`), a
 * Gatsby SPA whose chunk map names the captcha page components; the body
 * marker matters because mocked fetch responses carry no final URL. A bare
 * "captcha" substring is deliberately not used — result snippets for
 * captcha-related queries would false-positive. (Port of upstream
 * isChallengeResponse.)
 */
function isChallengeResponse(finalUrl, html) {
	if (/\/(?:errors|captcha)\//.test(finalUrl) || finalUrl.includes("/sp/captcha")) return true;
	return html.includes("component---src-pages-captcha") || html.includes("/sp/captcha");
}

/** Read a double- or single-quoted attribute value out of one tag string. */
function attrValue(tag, name) {
	const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
	return re.exec(tag)?.[2];
}

/** Class attribute value of a tag, as an exact class-token list. */
function classTokens(tag) {
	const cls = attrValue(tag, "class");
	return cls ? cls.split(/\s+/).filter(Boolean) : [];
}

/**
 * Lift the hidden inputs from the homepage's `/sp/search` form. Returns
 * `undefined` when the form or its `sc` anti-bot token cannot be found so the
 * caller can degrade to a tokenless GET instead of posting a doomed form.
 * DOM-free port of upstream parseSearchFormInputs (querySelector replaced by
 * a form scan whose action matches /sp/search, then per-input parsing because
 * attribute order varies).
 */
function parseSearchFormInputs(html) {
	for (const formMatch of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
		const action = attrValue(formMatch[1], "action");
		if (!action || !/^https?:\/\/(?:www\.)?startpage\.com\/sp\/search\/?(?:[?#].*)?$/i.test(action)) continue;
		const inputs = {};
		for (const inputMatch of formMatch[2].matchAll(/<input\b[^>]*>/gi)) {
			const input = inputMatch[0];
			const type = (attrValue(input, "type") ?? "").toLowerCase();
			if (type !== "hidden") continue;
			const name = attrValue(input, "name");
			if (!name) continue;
			const value = attrValue(input, "value");
			inputs[decodeHtmlText(name)] = value !== undefined ? decodeHtmlText(value) : "";
		}
		if (inputs.sc) return inputs;
	}
	return undefined;
}

/** Accept only http(s) result targets that point away from Startpage itself. */
function sanitizeResultUrl(href) {
	if (!href) return undefined;
	let url;
	try {
		url = new URL(href, STARTPAGE_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
	return url.href;
}

/**
 * Walk the server-rendered results page in document order — DOM-free port of
 * upstream parseHtmlResults (`div.result` containers holding `a.result-link`
 * title anchors with an `h2`/`h3` heading, optional `p.description` snippet;
 * direct hrefs, no redirect wrappers). Class matching compares whole class
 * tokens, so the offscreen adblock-honeypot div (`class="a-bg-result"`) is
 * ignored exactly like upstream's CSS `div.result` selector, and slicing
 * between consecutive qualifying containers naturally excludes sponsored
 * placements rendered outside `div.result`.
 */
function parseHtmlResults(html) {
	const results = [];
	// Collect opening tags of div containers whose class list contains the
	// exact token "result", then slice each block up to the next one.
	const openTags = [];
	for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
		if (!classTokens(match[0]).includes("result")) continue;
		openTags.push({ tag: match[0], index: match.index });
	}
	for (let i = 0; i < openTags.length; i++) {
		const start = openTags[i].index + openTags[i].tag.length;
		const end = i + 1 < openTags.length ? openTags[i + 1].index : html.length;
		const block = html.slice(start, end);

		// Title anchor: first <a> whose class tokens include "result-link".
		let anchorInner;
		let href;
		for (const anchorMatch of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
			if (!classTokens(anchorMatch[1]).includes("result-link")) continue;
			href = attrValue(anchorMatch[1], "href");
			anchorInner = anchorMatch[2];
			break;
		}
		if (href === undefined) continue;
		const url = sanitizeResultUrl(href);
		if (!url) continue;

		// Title: h2/h3 inside the anchor, falling back to the anchor text.
		const heading = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(anchorInner ?? "");
		const title = normalizeText(decodeHtmlText(heading ? heading[1] : anchorInner ?? ""));
		if (!title) continue;

		// Snippet: first <p> whose class tokens include "description".
		let snippet;
		for (const pMatch of block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
			if (!classTokens(pMatch[1]).includes("description")) continue;
			snippet = normalizeText(decodeHtmlText(pMatch[2]));
			break;
		}
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

/**
 * Merge one response's Set-Cookie headers into the per-call cookie jar.
 */
function mergeSetCookies(jar, response) {
	for (const cookie of response.headers.getSetCookie?.() ?? []) {
		const pair = cookie.split(";")[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}

/** Serialize the cookie jar for an outgoing Cookie header ("" when empty). */
function cookieHeader(jar) {
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Issue a request while reading/writing the per-call cookie jar. */
async function jarFetch(url, init, jar) {
	const cookie = cookieHeader(jar);
	const response = await fetch(url, {
		...init,
		headers: { ...(init?.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
	});
	try {
		mergeSetCookies(jar, response);
	} catch {
		// getSetCookie unavailable or malformed headers — proceed cookieless.
	}
	return response;
}

/**
 * Extract the JSON payload of `<script id="…">` metadata blocks emitted by
 * the Anubis gate.
 */
function parseJsonScript(html, id) {
	const match = new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`, "i").exec(html);
	if (!match) return undefined;
	try {
		return JSON.parse(match[1].trim());
	} catch {
		return undefined;
	}
}

/**
 * Solve the Anubis proof-of-work exactly like its own worker script does:
 * find nonce ≥ 0 such that hex(sha256(randomData + nonce)) starts with
 * `difficulty` leading zero characters. Difficulty is expressed in hex digits
 * (the reference worker checks whole zero bytes plus a nibble for odd values,
 * which is equivalent). Difficulty 4 averages ~65k hashes — milliseconds on
 * V8 via node:crypto.
 */
function solveAnubisChallenge(rules, challenge) {
	const difficulty = Number(rules?.difficulty);
	const data = String(challenge?.randomData ?? "");
	if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32 || !data) {
		throw new Error("Startpage anti-bot challenge (Anubis) has an unsupported shape");
	}
	const prefix = "0".repeat(difficulty);
	const maxNonce = 2 ** 28; // guard against pathological difficulties
	let nonce = 0;
	for (;; nonce++) {
		const hash = createHash("sha256").update(data + nonce).digest("hex");
		if (hash.startsWith(prefix)) return { hash, nonce };
		if (nonce > maxNonce) break;
	}
	throw new Error("Startpage anti-bot challenge (Anubis) exceeded the proof-of-work budget");
}

/**
 * Pass the Anubis gate: solve the embedded challenge, then hit
 * `/…/anubis/api/pass-challenge?id&response&nonce&redir&elapsedTime`
 * (redirect kept manual) and collect the clearance cookie into the jar.
 */
async function passAnubisChallenge(homeUrl, html, jar, signal) {
	const payload = parseJsonScript(html, "anubis_challenge");
	const basePrefix = parseJsonScript(html, "anubis_base_prefix") ?? "";
	if (!payload?.challenge || !payload?.rules) throw new Error("Startpage served an unreadable anti-bot challenge page");
	const issuedAt = Date.now();
	const { hash, nonce } = solveAnubisChallenge(payload.rules, payload.challenge);
	const params = new URLSearchParams({
		id: String(payload.challenge.id ?? ""),
		response: hash,
		nonce: String(nonce),
		redir: homeUrl,
		elapsedTime: String(Math.max(Date.now() - issuedAt, 1)),
	});
	// An empty base_prefix ("") means "same origin"; a non-empty one is a path.
	const origin = new URL(homeUrl).origin;
	const response = await jarFetch(`${origin}${typeof basePrefix === "string" ? basePrefix : ""}/.within.website/x/cmd/anubis/api/pass-challenge?${params}`, {
		redirect: "manual",
		headers: { ...BROWSER_NAVIGATION_HEADERS, Referer: homeUrl },
		signal,
	}, jar);
	await response.arrayBuffer().catch(() => {});
}

/** `true` when the body is an Anubis challenge shell rather than real content. */
function isAnubisChallenge(html) {
	return html.includes('id="anubis_challenge"');
}

/**
 * Fetch the homepage (passing any Anubis gate) and lift the search form's
 * hidden inputs. Best effort: any failure (network, non-OK status, challenge
 * shell that will not clear, markup drift) yields `undefined` and the caller
 * falls back to a tokenless direct GET. Abort errors propagate. (Extended
 * port of upstream fetchFormInputs.)
 */
async function liftHomepageFormInputs(jar, signal) {
	let html;
	try {
		let response = await jarFetch(STARTPAGE_HOME_URL, {
			headers: { ...BROWSER_NAVIGATION_HEADERS },
			redirect: "follow",
			signal,
		}, jar);
		html = await response.text();
		if (response.status >= 200 && response.status < 300 && isAnubisChallenge(html)) {
			// Browser-equivalent recovery: solve the PoW, replay with clearance.
			await passAnubisChallenge(response.url || STARTPAGE_HOME_URL, html, jar, signal);
			response = await jarFetch(STARTPAGE_HOME_URL, {
				headers: { ...BROWSER_NAVIGATION_HEADERS },
				redirect: "follow",
				signal,
			}, jar);
			html = await response.text();
			if (isAnubisChallenge(html)) return undefined;
		}
		if (response.status < 200 || response.status >= 300) return undefined;
		if (isChallengeResponse(response.url || STARTPAGE_HOME_URL, html)) return undefined;
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
	return parseSearchFormInputs(html);
}

async function callStartpageHtml(query, withDate, formInputs, jar, signal) {
	let response;
	if (formInputs) {
		const form = new URLSearchParams(formInputs);
		form.set("query", query);
		if (withDate) form.set("with_date", withDate);
		response = await jarFetch(STARTPAGE_SEARCH_URL, {
			method: "POST",
			body: form.toString(),
			headers: {
				...BROWSER_NAVIGATION_HEADERS,
				Referer: STARTPAGE_HOME_URL,
				"Sec-Fetch-Site": "same-origin",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			redirect: "follow",
			signal,
		}, jar);
	} else {
		const url = new URL(STARTPAGE_SEARCH_URL);
		url.searchParams.set("query", query);
		if (withDate) url.searchParams.set("with_date", withDate);
		response = await jarFetch(url.href, {
			headers: {
				...BROWSER_NAVIGATION_HEADERS,
				Referer: STARTPAGE_HOME_URL,
				"Sec-Fetch-Site": "same-origin",
			},
			redirect: "follow",
			signal,
		}, jar);
	}

	const html = await response.text();
	const finalUrl = response.url || STARTPAGE_SEARCH_URL;
	if (isAnubisChallenge(html)) {
		throw new Error(
			"Startpage served an Anubis proof-of-work challenge on the search request " +
				"(homepage clearance did not carry over); retry later or use another provider.",
		);
	}
	if (isChallengeResponse(finalUrl, html)) {
		throw new Error(
			"Startpage blocked the request with a CAPTCHA challenge (429-style throttle). " +
				"Startpage rate-limits automated searches from datacenter/shared-egress IPs; " +
				"try another provider such as DuckDuckGo or Mojeek, or retry later.",
		);
	}
	if (response.status < 200 || response.status >= 300) {
		const status = response.status;
		const creditPattern = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;
		if (creditPattern.test(html)) throw new Error("startpage: credits exhausted");
		if (status === 402) throw new Error("startpage: 402 credits exhausted");
		if (status === 401) throw new Error("startpage: 401 unauthorized");
		if (status === 403) throw new Error("startpage: 403 forbidden");
		throw new Error(`Startpage HTML error (${status})`);
	}
	return html;
}

/** Ensure thrown errors mention the engine and surface abort/timeout clearly. */
function normalizeError(error) {
	const raw = error instanceof Error ? error : new Error(String(error));
	if (raw.name === "AbortError" || raw.name === "TimeoutError") {
		const err = new Error(
			raw.name === "TimeoutError"
				? "Startpage search timed out before completing"
				: "Startpage search was aborted before completing",
		);
		err.name = raw.name;
		err.cause = raw;
		return err;
	}
	if (/startpage/i.test(raw.message)) return raw;
	const wrapped = new Error(`startpage: ${raw.message}`);
	wrapped.cause = raw;
	return wrapped;
}

/**
 * Structured web-search query parsing.
 *
 * Agents habitually embed Google-style directives in search queries —
 * `site:`, `before:`/`after:`, `inurl:`, `filetype:`, quoted phrases, `OR`
 * groups, `-exclusions` — regardless of whether the backing engine parses
 * them. This module turns a raw query into a {@link StructuredQuery} so each
 * provider can:
 *
 * 1. map constraints onto native API parameters where they exist (Perplexity
 *    `search_domain_filter`, Tavily `include_domains`, Exa date bounds, …),
 * 2. rebuild a query string containing only the syntax the target engine
 *    understands ({@link formatQuery}), and
 * 3. post-filter returned sources leniently ({@link applyQueryConstraints}):
 *    a constraint dimension that would eliminate every result is dropped and
 *    reported rather than returning nothing.
 *
 * Plain-modern-JS (ESM) port of the MIT-licensed TypeScript original
 * (`packages/coding-agent/src/web/search/query.ts`); runtime behavior is
 * preserved verbatim.
 */

/**
 * One free-text token of the query (everything that is not a recognized directive).
 *
 * @typedef {object} QueryTerm
 * @property {string} text Term text without quotes or operator prefixes.
 * @property {boolean} [phrase] Quoted exact phrase (`"like this"`) or verbatim-required (`+term`).
 * @property {boolean} [negated] Excluded via `-term` or `NOT term`.
 * @property {number} [group] OR-group id. Terms sharing an id are alternatives (`a OR b`);
 *   terms without a group are implicitly AND-ed. Groups are always contiguous runs in
 *   {@link StructuredQuery#terms}.
 */

/**
 * A raw query decomposed into free text plus every recognized constraint.
 *
 * All list fields are always present (possibly empty) so consumers can map
 * over them without null checks. Values are stored as typed by the user
 * except for normalization noted per field.
 *
 * @typedef {object} StructuredQuery
 * @property {string} raw Original query string, verbatim.
 * @property {string} text Free-text remainder with all recognized directives removed; phrases
 *   stay quoted, exclusions keep `-`, OR groups keep `OR`. Empty when the query was directives
 *   only — use {@link formatQuery} for a never-empty engine query.
 * @property {QueryTerm[]} terms Ordered free-text terms (phrases, exclusions, OR groups).
 * @property {string[]} sites `site:`/`domain:`/`host:` includes — any-of. Lowercased, scheme
 *   stripped, may carry a path (`github.com/anthropics`).
 * @property {string[]} excludedSites `-site:` exclusions, same normalization as {@link StructuredQuery#sites}.
 * @property {string[]} inUrl `inurl:`/`url:`/`allinurl:` substrings — all must appear in the URL.
 * @property {string[]} excludedInUrl `-inurl:` substrings — none may appear in the URL.
 * @property {string[]} inTitle `intitle:`/`title:`/`allintitle:` substrings — all must appear in the title.
 * @property {string[]} excludedInTitle `-intitle:` substrings — none may appear in the title.
 * @property {string[]} inText `intext:`/`inbody:`/`inanchor:`/`allintext:` body substrings.
 *   Not post-filterable (snippets are partial); query-building only.
 * @property {string[]} excludedInText `-intext:` body exclusions. Query-building only.
 * @property {string[]} filetypes `filetype:`/`ext:` extensions — any-of. Lowercased, no leading dot.
 * @property {string[]} excludedFiletypes `-filetype:`/`-ext:` extensions — none may match.
 * @property {string} [after] Inclusive lower publish-date bound from `after:`/`since:`, ISO `YYYY-MM-DD`.
 * @property {string} [before] Exclusive upper publish-date bound from `before:`/`until:`, ISO `YYYY-MM-DD`.
 * @property {string} [lang] Language code from `lang:`/`language:`, lowercased (e.g. `en`, `en-us`).
 * @property {boolean} hasDirectives True when any directive or boolean operator was recognized.
 * @property {boolean} hasConstraints True when any post-filterable constraint is set
 *   (sites, url/title terms, filetypes, date bounds).
 */

/**
 * Query-syntax capabilities of a target engine, used by {@link formatQuery}
 * to decide which parsed features are re-emitted as query text. Everything
 * defaults to `false`: the zero-value produces plain keywords suitable for
 * natural-language APIs.
 *
 * @typedef {object} QuerySyntax
 * @property {boolean} [phrases] Emit `"quoted phrases"`.
 * @property {boolean} [negation] Emit `-term` exclusions (negated terms are dropped otherwise).
 * @property {boolean} [or] Emit `OR` between alternatives (groups are flattened to keywords otherwise).
 * @property {boolean} [site] Emit `site:`/`-site:`.
 * @property {boolean} [inUrl] Emit `inurl:`/`-inurl:`.
 * @property {boolean} [inTitle] Emit `intitle:`/`-intitle:`.
 * @property {boolean} [inText] Emit `intext:`/`-intext:`.
 * @property {boolean} [filetype] Emit `filetype:`/`-filetype:`.
 * @property {boolean} [dateRange] Emit `before:`/`after:` ISO date bounds.
 */

/** Full Google-style syntax: engines that parse the classic operator set (Google, Startpage, Ecosia, Brave, Kagi, Mojeek, SearXNG…). */
export const GOOGLE_QUERY_SYNTAX = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	inUrl: true,
	inTitle: true,
	inText: true,
	filetype: true,
	dateRange: true,
};

/**
 * Minimal shape of a search result source consumed by this module
 * (`url`/`title` for matching, `ageSeconds`/`publishedDate` for date bounds).
 *
 * @typedef {object} SearchSource
 * @property {string} url Result URL.
 * @property {string} [title] Result title.
 * @property {number} [ageSeconds] Engine-reported age of the result in seconds.
 * @property {string} [publishedDate] Publish date: ISO timestamp or relative (`"3 days ago"`).
 */

/**
 * Result of {@link applyQueryConstraints}.
 *
 * @typedef {object} ConstraintFilterResult
 * @property {SearchSource[]} sources Sources surviving the lenient filter — never empty when
 *   the input was non-empty.
 * @property {string[]} dropped Directive renderings (`site:arxiv.org`, `before:2024-01-01`, …)
 *   of the constraint dimensions that matched zero sources and were therefore relaxed instead
 *   of enforced.
 */

const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i;

/**
 * @typedef {object} RawToken
 * @property {string} text
 * @property {boolean} quoted Entire token was a quoted phrase.
 * @property {boolean} [quotedValue] Directive value was quoted (`intitle:"a b"`).
 */

function isQuote(ch) {
	return ch === '"' || ch === "\u201c" || ch === "\u201d";
}

/** Unicode-aware whitespace (agents paste NBSP and friends). */
const WHITESPACE = /\s/;

/** Split a raw query into whitespace-delimited tokens, honoring quoted spans and standalone parens. */
function tokenize(raw) {
	const tokens = [];
	const n = raw.length;
	let i = 0;
	while (i < n) {
		const ch = raw[i];
		if (WHITESPACE.test(ch)) {
			i++;
			continue;
		}
		if (isQuote(ch)) {
			let j = i + 1;
			let buf = "";
			while (j < n && !isQuote(raw[j])) {
				buf += raw[j];
				j++;
			}
			if (buf.trim().length > 0) tokens.push({ text: buf.trim(), quoted: true });
			i = j + 1;
			continue;
		}
		// Bare word; a quote directly after `name:` swallows the quoted span
		// into the same token (`intitle:"budget tips"`).
		let buf = "";
		let quotedValue = false;
		while (i < n && !WHITESPACE.test(raw[i])) {
			const c = raw[i];
			if (isQuote(c) && buf.endsWith(":")) {
				let j = i + 1;
				while (j < n && !isQuote(raw[j])) {
					buf += raw[j];
					j++;
				}
				quotedValue = true;
				i = j + 1;
				continue;
			}
			if (isQuote(c)) break; // `foo"bar` — stop the word, let the quote start a phrase
			buf += c;
			i++;
		}
		if (buf.length > 0) tokens.push({ text: buf, quoted: false, quotedValue });
	}
	return splitParens(tokens);
}

/**
 * Split leading `(` and unbalanced trailing `)` into standalone tokens so
 * `(react OR vue)` parses while `site:wikipedia.org/Foo_(bar)` stays whole.
 */
function splitParens(tokens) {
	const out = [];
	for (const tok of tokens) {
		if (tok.quoted || tok.quotedValue) {
			out.push(tok);
			continue;
		}
		let text = tok.text;
		while (text.startsWith("(")) {
			out.push({ text: "(", quoted: false });
			text = text.slice(1);
		}
		let trailing = 0;
		while (text.endsWith(")")) {
			// Only strip parens that do not close an opener inside the word.
			const body = text.slice(0, -1);
			let depth = 0;
			for (const c of body) {
				if (c === "(") depth++;
				else if (c === ")") depth--;
			}
			if (depth > 0) break;
			text = body;
			trailing++;
		}
		if (text.length > 0) out.push({ text, quoted: false });
		for (let k = 0; k < trailing; k++) out.push({ text: ")", quoted: false });
	}
	return out;
}

/** Convert year/month/day parts to a validated ISO date, or undefined. */
function isoDate(year, month, day) {
	if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse a `before:`/`after:` value into ISO `YYYY-MM-DD`.
 * Accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (also `/` and `.` separators) and
 * `MM/DD/YYYY` (day-first assumed when the first field exceeds 12).
 * Bare years/months resolve to the first day of the period, matching
 * Google's `after:2024` ≙ `after:2024-01-01` semantics.
 */
export function parseDateValue(value) {
	const t = value.trim();
	let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t);
	if (m) return isoDate(Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1);
	m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
	if (m) {
		let month = Number(m[1]);
		let day = Number(m[2]);
		if (month > 12 && day <= 12) [month, day] = [day, month];
		return isoDate(Number(m[3]), month, day);
	}
	return undefined;
}

/** Lowercase a `site:` value and strip scheme, `*.` wildcard, and trailing slash/dot. */
function normalizeSite(value) {
	let site = value.trim().toLowerCase();
	site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	if (site.startsWith("*.")) site = site.slice(2);
	site = site.replace(/[/.]+$/, "");
	return site;
}

/** Directive names mapped to their canonical field. */
const DIRECTIVE_FIELDS = {
	site: "site",
	domain: "site",
	host: "site",
	inurl: "inUrl",
	url: "inUrl",
	intitle: "inTitle",
	title: "inTitle",
	intext: "inText",
	inbody: "inText",
	inanchor: "inText",
	filetype: "filetype",
	ext: "filetype",
	before: "before",
	until: "before",
	after: "after",
	since: "after",
	lang: "lang",
	language: "lang",
};

/** `allin*:` directives that capture every following plain term. */
const ALL_MODES = {
	allintitle: "inTitle",
	allinurl: "inUrl",
	allintext: "inText",
};

/** True for operator/paren tokens and recognized directives — anything a bare `name:` must not adopt as its value. */
function isReservedToken(text) {
	if (
		text === "(" ||
		text === ")" ||
		text === "OR" ||
		text === "AND" ||
		text === "NOT" ||
		text === "|" ||
		text === "||" ||
		text === "&&" ||
		text === "!"
	) {
		return true;
	}
	const m = DIRECTIVE_PATTERN.exec(text);
	if (!m) return false;
	const name = m[2].toLowerCase();
	return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined;
}

/**
 * Parse a raw query into a {@link StructuredQuery}.
 *
 * Lenient by construction: unknown `name:value` tokens (URLs, `C:\paths`,
 * `TS2345:`, jargon) stay in the free text verbatim, and a directive with an
 * unparseable value (`before:someday`) degrades to a plain term instead of
 * being dropped.
 */
export function parseSearchQuery(raw) {
	const q = {
		raw,
		text: "",
		terms: [],
		sites: [],
		excludedSites: [],
		inUrl: [],
		excludedInUrl: [],
		inTitle: [],
		excludedInTitle: [],
		inText: [],
		excludedInText: [],
		filetypes: [],
		excludedFiletypes: [],
		hasDirectives: false,
		hasConstraints: false,
	};

	const tokens = tokenize(raw);
	let negateNext = false;
	let orPending = false;
	let lastWasTerm = false;
	let groupSeq = 0;
	let allMode;

	const pushConstraint = (field, value, negated) => {
		q.hasDirectives = true;
		orPending = false;
		lastWasTerm = false;
		const v = value.trim();
		if (!v) return;
		switch (field) {
			case "site": {
				const site = normalizeSite(v);
				if (site) (negated ? q.excludedSites : q.sites).push(site);
				break;
			}
			case "inUrl":
				(negated ? q.excludedInUrl : q.inUrl).push(v);
				break;
			case "inTitle":
				(negated ? q.excludedInTitle : q.inTitle).push(v);
				break;
			case "inText":
				(negated ? q.excludedInText : q.inText).push(v);
				break;
			case "filetype": {
				const ext = v.toLowerCase().replace(/^\.+/, "");
				if (ext) (negated ? q.excludedFiletypes : q.filetypes).push(ext);
				break;
			}
		}
	};

	const pushTerm = (text, phrase) => {
		const negated = negateNext;
		negateNext = false;
		if (allMode && !negated) {
			pushConstraint(allMode, text, false);
			return;
		}
		if (allMode && negated) {
			pushConstraint(allMode, text, true);
			return;
		}
		const term = { text };
		if (phrase) term.phrase = true;
		if (negated) term.negated = true;
		if (orPending && lastWasTerm) {
			const prev = q.terms[q.terms.length - 1];
			if (prev) {
				prev.group ??= ++groupSeq;
				term.group = prev.group;
			}
		}
		orPending = false;
		lastWasTerm = true;
		q.terms.push(term);
	};

	for (let idx = 0; idx < tokens.length; idx++) {
		const tok = tokens[idx];

		if (tok.quoted) {
			pushTerm(tok.text, true);
			continue;
		}

		// Boolean operators and grouping parens.
		if (tok.text === "(" || tok.text === ")") continue;
		if (tok.text === "OR" || tok.text === "|" || tok.text === "||") {
			orPending = true;
			q.hasDirectives = true;
			continue;
		}
		if (tok.text === "AND" || tok.text === "&&") {
			q.hasDirectives = true;
			continue;
		}
		if (tok.text === "NOT" || tok.text === "!") {
			negateNext = true;
			q.hasDirectives = true;
			continue;
		}
		if (tok.text === "-" || tok.text === "+") {
			// The tokenizer splits `-"exact phrase"` into `-` + phrase; carry the negation over.
			if (tok.text === "-" && tokens[idx + 1]?.quoted) negateNext = true;
			continue;
		}

		const match = DIRECTIVE_PATTERN.exec(tok.text);
		const name = match?.[2].toLowerCase();
		const allMatch = name ? ALL_MODES[name] : undefined;
		const field = name ? DIRECTIVE_FIELDS[name] : undefined;

		if (match && allMatch) {
			allMode = allMatch;
			q.hasDirectives = true;
			// `allintitle:budget tips` — inline value plus every following term.
			const inline = match[3].trim();
			if (inline) pushConstraint(allMatch, inline, match[1] === "-");
			orPending = false;
			lastWasTerm = false;
			continue;
		}

		if (match && field) {
			let value = match[3].trim();
			// `site: example.com` — lenient: adopt the next plain token as the value.
			if (!value) {
				const next = tokens[idx + 1];
				if (next && (next.quoted || !isReservedToken(next.text))) {
					value = next.text.trim();
					idx++;
				}
			}
			if (!value) {
				q.hasDirectives = true;
				continue;
			}
			const negated = match[1] === "-" || negateNext;
			negateNext = false;
			switch (field) {
				case "before":
				case "after": {
					const iso = parseDateValue(value);
					if (!iso) {
						pushTerm(tok.text, false);
						continue;
					}
					if (field === "before") q.before = iso;
					else q.after = iso;
					q.hasDirectives = true;
					orPending = false;
					lastWasTerm = false;
					break;
				}
				case "lang":
					q.lang = value.toLowerCase();
					q.hasDirectives = true;
					orPending = false;
					lastWasTerm = false;
					break;
				default:
					pushConstraint(field, value, negated);
			}
			continue;
		}

		// Plain term with optional +/- prefix.
		let text = tok.text;
		if (text.startsWith("-") && text.length > 1) {
			negateNext = true;
			q.hasDirectives = true;
			text = text.replace(/^-+/, "");
			if (!text) continue;
			// `-site:x` arrives pre-split only when written `- site:x`; re-check directive.
			const negMatch = DIRECTIVE_PATTERN.exec(text);
			const negName = negMatch?.[2].toLowerCase();
			const negField = negName ? DIRECTIVE_FIELDS[negName] : undefined;
			if (negMatch && negField && negField !== "before" && negField !== "after" && negField !== "lang") {
				negateNext = false;
				pushConstraint(negField, negMatch[3].trim(), true);
				continue;
			}
			pushTerm(text, false);
			continue;
		}
		if (text.startsWith("+") && text.length > 1) {
			// Legacy Google `+term`: verbatim/required — treat as an exact phrase.
			pushTerm(text.slice(1), true);
			q.hasDirectives = true;
			continue;
		}
		pushTerm(text, false);
	}

	q.text = renderTerms(q.terms, { phrases: true, negation: true, or: true });
	q.hasConstraints =
		q.sites.length > 0 ||
		q.excludedSites.length > 0 ||
		q.inUrl.length > 0 ||
		q.excludedInUrl.length > 0 ||
		q.inTitle.length > 0 ||
		q.excludedInTitle.length > 0 ||
		q.filetypes.length > 0 ||
		q.excludedFiletypes.length > 0 ||
		q.before !== undefined ||
		q.after !== undefined;
	return q;
}

/** Quote a directive value when it contains whitespace. */
function quoteValue(value) {
	return /\s/.test(value) ? `"${value}"` : value;
}

/** Render the free-text terms per the target syntax. */
function renderTerms(terms, syntax) {
	const parts = [];
	for (let i = 0; i < terms.length; i++) {
		const term = terms[i];
		if (term.group !== undefined && syntax.or) {
			const members = [];
			let j = i;
			for (; j < terms.length && terms[j].group === term.group; j++) {
				const rendered = renderTerm(terms[j], syntax);
				if (rendered) members.push(rendered);
			}
			i = j - 1;
			if (members.length > 1) parts.push(`(${members.join(" OR ")})`);
			else if (members.length === 1) parts.push(members[0]);
			continue;
		}
		const rendered = renderTerm(term, syntax);
		if (rendered) parts.push(rendered);
	}
	return parts.join(" ");
}

function renderTerm(term, syntax) {
	if (term.negated && !syntax.negation) return undefined;
	const body = term.phrase && syntax.phrases ? `"${term.text}"` : term.text;
	return term.negated ? `-${body}` : body;
}

/**
 * Rebuild a query string for an engine with the given {@link QuerySyntax}.
 *
 * Constraints whose syntax the engine lacks are omitted (the caller maps
 * them onto API parameters or relies on {@link applyQueryConstraints}).
 * Never returns an empty string for a non-empty input: a directives-only
 * query falls back to the constraint values as keywords, then to `raw` — an
 * engine searching *something* beats an empty-query error.
 */
export function formatQuery(q, syntax = {}) {
	const parts = [];
	const text = renderTerms(q.terms, syntax);
	if (text) parts.push(text);

	if (syntax.site) {
		if (q.sites.length > 1 && syntax.or) parts.push(`(${q.sites.map(s => `site:${s}`).join(" OR ")})`);
		else parts.push(...q.sites.map(s => `site:${s}`));
		parts.push(...q.excludedSites.map(s => `-site:${s}`));
	}
	if (syntax.inUrl) {
		parts.push(...q.inUrl.map(v => `inurl:${quoteValue(v)}`));
		parts.push(...q.excludedInUrl.map(v => `-inurl:${quoteValue(v)}`));
	}
	if (syntax.inTitle) {
		parts.push(...q.inTitle.map(v => `intitle:${quoteValue(v)}`));
		parts.push(...q.excludedInTitle.map(v => `-intitle:${quoteValue(v)}`));
	}
	if (syntax.inText) {
		parts.push(...q.inText.map(v => `intext:${quoteValue(v)}`));
		parts.push(...q.excludedInText.map(v => `-intext:${quoteValue(v)}`));
	}
	if (syntax.filetype) {
		if (q.filetypes.length > 1 && syntax.or) parts.push(`(${q.filetypes.map(f => `filetype:${f}`).join(" OR ")})`);
		else parts.push(...q.filetypes.map(f => `filetype:${f}`));
		parts.push(...q.excludedFiletypes.map(f => `-filetype:${f}`));
	}
	if (syntax.dateRange) {
		if (q.after) parts.push(`after:${q.after}`);
		if (q.before) parts.push(`before:${q.before}`);
	}

	let result = parts.join(" ").trim();
	if (!result) {
		// Directives-only query and no directive syntax: search the constraint
		// values as plain keywords so the engine still gets a meaningful query.
		const fallback = [...q.sites, ...q.inTitle, ...q.inUrl, ...q.inText, ...q.filetypes];
		result = fallback.join(" ").trim();
	}
	return result || q.raw.trim();
}

/**
 * Build the engine query for a credential-free HTML engine (Google,
 * Startpage, DuckDuckGo, Ecosia, Mojeek, SearXNG, and the Public Web
 * fan-out over them).
 *
 * Canonicalizes directives via {@link formatQuery} with the engine's
 * {@link QuerySyntax} (default: full Google syntax), after demoting the
 * operators that zero-match across the scraper set: engines only match
 * `site:` against a bare domain (a path yields zero results everywhere),
 * and DuckDuckGo ignores `inurl:` entirely — so either operator silently
 * empties the result set. The raw URL as a plain term matches fine, so
 * bare-domain `site:` filters are kept while path-carrying `site:` and all
 * `inurl:` values become plain keywords; the demotion is structural (before
 * formatting), so OR-grouped and quoted directives are covered. Negated
 * forms (`-site:`, `-inurl:`) pass through untouched — demoting them would
 * invert an exclusion into a search term; the pipeline post-filter
 * ({@link applyQueryConstraints}) enforces every demoted or unsupported
 * constraint on the returned sources. Directive-free queries pass through
 * byte-identical.
 */
export function formatScraperQuery(query, parsedQuery, syntax = GOOGLE_QUERY_SYNTAX) {
	const parsed = parsedQuery ?? parseSearchQuery(query);
	if (!parsed.hasDirectives) return query;
	const demoted = [...parsed.sites.filter(site => site.includes("/")), ...parsed.inUrl];
	const downgraded = {
		...parsed,
		sites: parsed.sites.filter(site => !site.includes("/")),
		inUrl: [],
		terms: [...parsed.terms, ...demoted.map(text => ({ text }))],
	};
	return formatQuery(downgraded, syntax);
}

/** Hostname (lowercased) and pathname of a URL, or undefined when unparsable. */
function hostAndPath(url) {
	try {
		const u = new URL(url);
		return { host: u.hostname.toLowerCase(), path: u.pathname };
	} catch {
		return undefined;
	}
}

/**
 * `site:` matcher: exact host or subdomain of `site`; when `site` carries a
 * path (`github.com/anthropics`), the URL path must start with it.
 */
export function matchesSite(url, site) {
	const parsed = hostAndPath(url);
	if (!parsed) return false;
	const slash = site.indexOf("/");
	const siteHost = slash === -1 ? site : site.slice(0, slash);
	const sitePath = slash === -1 ? "" : site.slice(slash);
	if (parsed.host !== siteHost && !parsed.host.endsWith(`.${siteHost}`)) return false;
	if (sitePath && !parsed.path.toLowerCase().startsWith(sitePath.toLowerCase())) return false;
	return true;
}

/** `filetype:` matcher: URL pathname ends with `.ext`. */
function matchesFiletype(url, ext) {
	const parsed = hostAndPath(url);
	if (!parsed) return false;
	return parsed.path.toLowerCase().endsWith(`.${ext}`);
}

const RELATIVE_AGE_PATTERN = /^(\d+)\s*(minute|min|hour|hr|day|week|month|mo|year|yr|[mhdwy])s?\s+ago$/i;

const RELATIVE_UNIT_SECONDS = {
	m: 60,
	min: 60,
	minute: 60,
	h: 3600,
	hr: 3600,
	hour: 3600,
	d: 86_400,
	day: 86_400,
	w: 604_800,
	week: 604_800,
	mo: 2_592_000,
	month: 2_592_000,
	y: 31_536_000,
	yr: 31_536_000,
	year: 31_536_000,
};

/** Best-effort publish time (ms epoch) of a source from `ageSeconds`, ISO, or relative dates. */
function sourceTime(source) {
	if (typeof source.ageSeconds === "number" && Number.isFinite(source.ageSeconds)) {
		return Date.now() - source.ageSeconds * 1000;
	}
	if (!source.publishedDate) return undefined;
	const rel = RELATIVE_AGE_PATTERN.exec(source.publishedDate.trim());
	if (rel) {
		const seconds = Number(rel[1]) * (RELATIVE_UNIT_SECONDS[rel[2].toLowerCase()] ?? 0);
		return seconds > 0 ? Date.now() - seconds * 1000 : undefined;
	}
	const parsed = Date.parse(source.publishedDate);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Strict per-source constraint check: every filterable dimension of `q` must
 * pass. Sources without a resolvable date pass date bounds (a missing date
 * is not proof of violation). For custom provider flows; the standard path
 * is {@link applyQueryConstraints}.
 */
export function matchesQueryConstraints(source, q) {
	for (const dim of constraintDimensions(q)) {
		if (!dim.pred(source)) return false;
	}
	return true;
}

/**
 * @typedef {object} ConstraintDimension
 * @property {string} label Directive rendering for relaxation notes (`site:arxiv.org`).
 * @property {(source: SearchSource) => boolean} pred
 */

function constraintDimensions(q) {
	const dims = [];
	const lower = s => (s ?? "").toLowerCase();

	if (q.sites.length > 0) {
		dims.push({
			label: q.sites.map(s => `site:${s}`).join(" OR "),
			pred: src => q.sites.some(site => matchesSite(src.url, site)),
		});
	}
	if (q.excludedSites.length > 0) {
		dims.push({
			label: q.excludedSites.map(s => `-site:${s}`).join(" "),
			pred: src => !q.excludedSites.some(site => matchesSite(src.url, site)),
		});
	}
	if (q.inUrl.length > 0) {
		dims.push({
			label: q.inUrl.map(v => `inurl:${v}`).join(" "),
			pred: src => q.inUrl.every(v => lower(src.url).includes(v.toLowerCase())),
		});
	}
	if (q.excludedInUrl.length > 0) {
		dims.push({
			label: q.excludedInUrl.map(v => `-inurl:${v}`).join(" "),
			pred: src => !q.excludedInUrl.some(v => lower(src.url).includes(v.toLowerCase())),
		});
	}
	if (q.inTitle.length > 0) {
		dims.push({
			label: q.inTitle.map(v => `intitle:${v}`).join(" "),
			pred: src => q.inTitle.every(v => lower(src.title).includes(v.toLowerCase())),
		});
	}
	if (q.excludedInTitle.length > 0) {
		dims.push({
			label: q.excludedInTitle.map(v => `-intitle:${v}`).join(" "),
			pred: src => !q.excludedInTitle.some(v => lower(src.title).includes(v.toLowerCase())),
		});
	}
	if (q.filetypes.length > 0) {
		dims.push({
			label: q.filetypes.map(f => `filetype:${f}`).join(" OR "),
			pred: src => q.filetypes.some(ext => matchesFiletype(src.url, ext)),
		});
	}
	if (q.excludedFiletypes.length > 0) {
		dims.push({
			label: q.excludedFiletypes.map(f => `-filetype:${f}`).join(" "),
			pred: src => !q.excludedFiletypes.some(ext => matchesFiletype(src.url, ext)),
		});
	}
	if (q.after !== undefined || q.before !== undefined) {
		const afterMs = q.after !== undefined ? Date.parse(q.after) : undefined;
		const beforeMs = q.before !== undefined ? Date.parse(q.before) : undefined;
		const label = [q.after ? `after:${q.after}` : "", q.before ? `before:${q.before}` : ""].filter(Boolean).join(" ");
		dims.push({
			label,
			pred: src => {
				const time = sourceTime(src);
				if (time === undefined) return true; // undated → cannot prove violation
				if (afterMs !== undefined && time < afterMs) return false;
				if (beforeMs !== undefined && time >= beforeMs) return false;
				return true;
			},
		});
	}
	return dims;
}

/**
 * Lenient post-filter: applies each constraint dimension of `q` in turn,
 * skipping (and reporting) any dimension that would eliminate every
 * remaining source. Guarantees a non-empty result for a non-empty input, so
 * a mis-scoped directive degrades to unfiltered results plus a note instead
 * of a dead search.
 */
export function applyQueryConstraints(sources, q) {
	let current = [...sources];
	const dropped = [];
	if (current.length === 0) return { sources: current, dropped };
	for (const dim of constraintDimensions(q)) {
		const kept = current.filter(dim.pred);
		if (kept.length > 0) current = kept;
		else dropped.push(dim.label);
	}
	return { sources: current, dropped };
}

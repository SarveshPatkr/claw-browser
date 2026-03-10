#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const defaultCdpPort = process.env.BROWSER_CDP_PORT || '19222';
const endpoint = process.env.BROWSER_CDP_URL || `http://127.0.0.1:${defaultCdpPort}`;
const endpointBase = endpoint.replace(/\/$/, '');
const browserApiKey = process.env.BROWSER_API_KEY || '';
let outputPrefs = { outputJson: false, compactJson: false };
let runtimeInteractionMap = {
	byId: new Map(),
	orderedInteractiveIds: [],
	inputIds: new Set()
};

async function sleep(ms) {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function fetchJsonWithRetry(url, options = {}, retryOptions = {}) {
	const attempts = Number.isInteger(retryOptions.attempts) ? retryOptions.attempts : 8;
	const baseDelayMs = Number.isInteger(retryOptions.baseDelayMs) ? retryOptions.baseDelayMs : 200;
	let lastErr = null;

	const headers = { ...options.headers };
	if (browserApiKey) {
		headers['Authorization'] = `Bearer ${browserApiKey}`;
	}
	options = { ...options, headers };

	for (let i = 1; i <= attempts; i += 1) {
		try {
			const response = await fetch(url, options);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return await response.json();
		} catch (err) {
			lastErr = err;
			if (i < attempts) {
				const delay = Math.min(baseDelayMs * i, 1200);
				await sleep(delay);
			}
		}
	}

	const details = String(lastErr?.cause?.message || lastErr?.message || lastErr || 'unknown error');
	throw new Error(`Request failed after ${attempts} attempts: ${details}`);
}

function printUsage() {
	console.log(`Usage:
  browser-cmd tabs (alias: ls)                                         # List all open tabs
  browser-cmd new [url] (alias: nw)                                    # Create a new tab with optional URL
  browser-cmd <command> --tab <id> [args]                              # Run command on a specific tab

Commands requiring --tab:
  browser-cmd open <url> (alias: op)                                   # Navigate current tab to a URL
  browser-cmd state (alias: st)                                        # Get elements and page content
                    [--offset <n>] [--limit <n>]                       # Paginate through extracted items
                    [--focus <sectionId>]                              # Show only one specific section
  browser-cmd click <target> (alias: clk)                              # Click element (index, ID, or selector)
  browser-cmd input <target> <text> (alias: in)                        # Type text into input (index, ID, or selector)
  browser-cmd upload <target> <filePath>                               # Upload file to element
  browser-cmd query <css> [field] [--all]                              # Extract specific element data
  browser-cmd grant <origin> <perms>                                   # Grant permissions (camera, mic, etc.)
  browser-cmd sheet-export [path]                                      # Export Google Sheet to CSV/TSV
  browser-cmd sheet-preview                                            # Preview Google Sheet rows in console
  browser-cmd type <text>                                              # Direct keyboard typing at focus
  browser-cmd keys <KeyOrChord> [target] (alias: key)                  # Press keys/chords, optionally after focusing target
  browser-cmd scroll <up|down> [amount]                                # Scroll the page vertically
  browser-cmd back                                                     # Go back in browser history
  browser-cmd reload                                                   # Reload the current page
  browser-cmd screenshot [path] [--stdout] (alias: scr)                # Capture page image
  browser-cmd eval <javascript>                                        # Run JS code in the page context

Examples:
  browser-cmd ls
  browser-cmd nw https://example.com
  browser-cmd st --tab A1B2C
  browser-cmd st --limit 10 --tab A1B2C
  browser-cmd clk 4 --tab A1B2C
  browser-cmd clk EE6MNOT --tab A1B2C
  browser-cmd click --id EE6MNOT --tab A1B2C
  browser-cmd in 2 "hello" --tab A1B2C
  browser-cmd input E6RU6IB "test message" --tab A1B2C
  browser-cmd key enter E6RU6IB --tab A1B2C
  browser-cmd keys ctrl+enter --tab A1B2C
  browser-cmd scr --stdout --tab A1B2C

Query examples (get element content by CSS selector):
  browser-cmd query "#content" --tab A1B2C                              # Get text from #content element
  browser-cmd query "#content" html --tab A1B2C                         # Get innerHTML of #content
  browser-cmd query "a" --all --tab A1B2C                              # Get all links
  browser-cmd query "p" --all --tab A1B2C                              # Get all paragraphs
  browser-cmd query ".classname" --all --tab A1B2C                     # Get all elements with class
  browser-cmd query "img" src --all --tab A1B2C                        # Get src attribute of all images

Eval examples (run JavaScript):
  browser-cmd eval "document.title" --tab A1B2C                         # Get page title
  browser-cmd eval "document.querySelector('#content').innerText" --tab A1B2C  # Get element text
  browser-cmd eval "location.href" --tab A1B2C                          # Get current URL
  browser-cmd eval "Array.from(document.querySelectorAll('a')).map(a=>a.href)" --tab A1B2C  # Get all links
`);
}

function printJson(value, compactJson = false) {
	console.log(JSON.stringify(value, null, compactJson ? 0 : 2));
}

function printResult(payload, prefs = outputPrefs) {
	if (prefs.outputJson) {
		if (typeof payload === 'string') {
			printJson({ message: payload }, prefs.compactJson);
			return;
		}
		printJson(payload, prefs.compactJson);
		return;
	}

	if (typeof payload === 'string') {
		console.log(payload);
		return;
	}

	printJson(payload, false);
}

function toKeyChord(raw) {
	return raw
		.split('+')
		.map((part) => {
			const p = part.trim();
			if (!p) return p;
			const lower = p.toLowerCase();
			if (lower === 'ctrl' || lower === 'control') return 'Control';
			if (lower === 'cmd' || lower === 'meta') return 'Meta';
			if (lower === 'alt' || lower === 'option') return 'Alt';
			if (lower === 'shift') return 'Shift';
			if (lower === 'esc') return 'Escape';
			if (lower === 'enter' || lower === 'return') return 'Enter';
			if (lower === 'space') return 'Space';
			if (p.length === 1) return p;
			return p[0].toUpperCase() + p.slice(1);
		})
		.join('+');
}

function parseCliArgs(argv) {
	const out = {
		tabId: process.env.BROWSER_CMD_TAB_ID || '',
		positional: [],
		outputJson: false,
		compactJson: false,
		agentMode: false
	};
	let commandSeen = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === '--tab') {
			out.tabId = argv[i + 1] || '';
			i += 1;
			continue;
		}
		if (arg.startsWith('--tab=')) {
			out.tabId = arg.slice('--tab='.length);
			continue;
		}

		commandSeen = true;
		out.positional.push(arg);
	}

	if (!out.outputJson) {
		out.compactJson = false;
	}

	return out;
}

function normalizeElementId(raw) {
	return String(raw || '').trim().toUpperCase();
}

function normalizeIdToken(raw) {
	return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function hashToShortId(raw) {
	const input = String(raw || '');
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36).toUpperCase().padStart(5, '0').slice(-5);
}

function buildTabIdView(rawTabs) {
	const used = new Set();
	const byShortId = new Map();
	const byFullId = new Map();

	const tabs = rawTabs.map((tab, idx) => {
		const token = normalizeIdToken(tab.id);
		const candidates = [];
		if (token.length >= 5) {
			candidates.push(token.slice(0, 5));
			candidates.push(`${token.slice(0, 4)}${token.slice(-1)}`);
			candidates.push(`${token.slice(0, 3)}${token.slice(-2)}`);
			candidates.push(`${token.slice(0, 2)}${token.slice(-3)}`);
			candidates.push(`${token.slice(0, 1)}${token.slice(-4)}`);
			candidates.push(token.slice(-5));
		} else {
			candidates.push(token.padEnd(5, 'X').slice(0, 5));
		}
		candidates.push(hashToShortId(`${token}-${idx}`));

		const uniqueCandidates = [...new Set(candidates)];
		let shortId = uniqueCandidates.find((candidate) => !used.has(candidate));

		if (!shortId) {
			const base = hashToShortId(`${tab.id}-${idx}`);
			const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
			shortId = base;
			for (const ch of chars) {
				const candidate = `${base.slice(0, 4)}${ch}`;
				if (!used.has(candidate)) {
					shortId = candidate;
					break;
				}
			}
		}

		used.add(shortId);
		byShortId.set(shortId.toUpperCase(), tab.id);
		byFullId.set(String(tab.id).toUpperCase(), tab.id);

		return {
			id: shortId,
			title: tab.title || '',
			url: tab.url || ''
		};
	});

	return { tabs, byShortId, byFullId };
}

async function listTabs() {
	let data;
	try {
		data = await fetchJsonWithRetry(`${endpointBase}/json/list`, {}, {
			attempts: 8,
			baseDelayMs: 200
		});
	} catch (err) {
		throw new Error(`Unable to reach CDP list endpoint: ${String(err.message || err)}`);
	}

	const rawTabs = data
		.filter((t) => t.type === 'page')
		.map((t) => ({
			id: t.id,
			title: t.title || '',
			url: t.url || ''
		}));

	return buildTabIdView(rawTabs);
}

function resolveTabId(tabId, byShortId, byFullId) {
	const wanted = String(tabId || '').trim().toUpperCase();
	if (!wanted) return '';
	if (byShortId.has(wanted)) return byShortId.get(wanted);
	if (byFullId.has(wanted)) return byFullId.get(wanted);
	return '';
}

function printTabRequirement(tabs, prefs = outputPrefs) {
	printResult({
		message: 'Pass --tab <id> to interact with that tab.',
		tabs
	}, prefs);
}

async function createTab(url) {
	const targetUrl = url || 'about:blank';
	const data = await fetchJsonWithRetry(
		`${endpointBase}/json/new?${encodeURIComponent(targetUrl)}`,
		{ method: 'PUT' },
		{ attempts: 5, baseDelayMs: 250 }
	);
	return {
		id: data.id,
		title: data.title || '',
		url: data.url || targetUrl
	};
}

async function getPageByTabId(browser, tabId) {
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			let cdpSession;
			try {
				cdpSession = await context.newCDPSession(page);
				const { targetInfo } = await cdpSession.send('Target.getTargetInfo');
				if (targetInfo?.targetId === tabId) {
					return page;
				}
			} catch {
				// ignore transient target/session errors
			} finally {
				if (cdpSession) {
					await cdpSession.detach().catch(() => { });
				}
			}
		}
	}

	return null;
}

async function settlePage(page) {
	await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
}

async function withContextRetry(page, fn) {
	try {
		return await fn();
	} catch (err) {
		const msg = String(err?.message || err);
		if (!msg.includes('Execution context was destroyed')) throw err;
		await settlePage(page);
		return fn();
	}
}

async function getState(page, options = {}) {
	const normalized = {
		includeClickable: options.includeClickable !== false,
		includeInputs: options.includeInputs !== false,
		includeText: options.includeText !== false,
		includeSemantic: options.includeSemantic !== false,
		maxRecords: options.maxRecords || 500,
		showDetails: options.showDetails === true
	};

	return withContextRetry(page, () => page.evaluate((cfg) => {
		const normalize = (v) => {
			if (!v) return '';
			return String(v)
				.replace(/[\u200B-\u200D\uFEFF]/g, '')
				.replace(/[\uFE00-\uFE0F]/g, '')
				.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
				.replace(/(\d{4,})(\p{L})/gu, '$1 $2')
				.replace(/\s+/g, ' ')
				.trim();
		};

		const clip = (v, max = 240) => {
			const s = String(v || '');
			return s.length > max ? `${s.slice(0, max)}...` : s;
		};

		const dedupe = (items) => {
			const out = [];
			const seen = new Set();
			for (const raw of items || []) {
				const value = clip(normalize(raw));
				if (!value) continue;
				const key = value.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(value);
			}
			return out;
		};

		const cssEscape = (value) => {
			if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
			return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
		};

		const selectorFor = (el) => {
			if (!el || el.nodeType !== 1) return '';
			if (el.id) return `#${cssEscape(el.id)}`;
			const parts = [];
			let curr = el;
			while (curr && curr.nodeType === 1 && parts.length < 6) {
				let part = curr.tagName.toLowerCase();
				const cls = Array.from(curr.classList || []).filter((c) => !c.includes(':')).slice(0, 2);
				if (cls.length) part += `.${cls.map(cssEscape).join('.')}`;
				const parent = curr.parentElement;
				if (parent) {
					const siblings = Array.from(parent.children).filter((s) => s.tagName === curr.tagName);
					if (siblings.length > 1) {
						const idx = siblings.indexOf(curr);
						if (idx >= 0) part += `:nth-of-type(${idx + 1})`;
					}
				}
				parts.unshift(part);
				if (curr.id) break;
				curr = curr.parentElement;
			}
			return parts.join(' > ');
		};

		const hashString = (raw) => {
			let h = 2166136261;
			const s = String(raw || '');
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return (h >>> 0).toString(36).toUpperCase().padStart(6, '0').slice(-6);
		};

		const idMap = new WeakMap();
		const idCounts = new Map();
		const getId = (el) => {
			if (idMap.has(el)) return idMap.get(el);
			const seed = [
				el.tagName,
				el.id || '',
				el.getAttribute('name') || '',
				el.getAttribute('role') || '',
				selectorFor(el)
			].join('|');
			const base = `E${hashString(seed)}`;
			const count = idCounts.get(base) || 0;
			idCounts.set(base, count + 1);
			const id = count > 0 ? `${base}_${count}` : base;
			idMap.set(el, id);
			return id;
		};

		const getRect = (el) => {
			const rect = el.getBoundingClientRect();
			return {
				x: Math.round(rect.left + rect.width / 2),
				y: Math.round(rect.top + rect.height / 2),
				width: Math.round(rect.width),
				height: Math.round(rect.height)
			};
		};

		// 1) classify + visibility filter helpers
		const isVisible = (el) => {
			if (!el || el.nodeType !== 1) return false;
			if (el.tagName === 'HTML' || el.tagName === 'BODY') return true;
			const style = window.getComputedStyle(el);
			if (style.display === 'none') return false;
			if (style.visibility === 'hidden') return false;
			if (style.opacity === '0') return false;
			if (el.getAttribute('aria-hidden') === 'true') return false;
			const rect = el.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) return false;
			return true;
		};

		const classify = (el) => {
			const tag = el.tagName.toLowerCase();
			if (['script', 'style', 'noscript', 'meta', 'template'].includes(tag)) {
				return { category: 'ignore', isInteractive: false, isBoundary: false, isContent: false };
			}

			const role = (el.getAttribute('role') || '').toLowerCase();
			const style = window.getComputedStyle(el);
			const hasClick = el.hasAttribute('onclick') || typeof el.onclick === 'function';

			const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'details', 'summary'];
			const interactiveRoles = ['button', 'link', 'tab', 'checkbox', 'menuitem', 'radio', 'switch', 'textbox', 'combobox', 'listbox', 'option', 'gridcell'];
			const isInteractive = interactiveTags.includes(tag)
				|| interactiveRoles.includes(role)
				|| hasClick
				|| el.isContentEditable
				|| (el.tabIndex >= 0 && !['html', 'body'].includes(tag));

			const isScrollable = ['auto', 'scroll'].includes(style.overflowY)
				|| ['auto', 'scroll'].includes(style.overflowX);
			const boundaryTags = ['nav', 'main', 'section', 'article', 'header', 'footer', 'aside', 'form', 'table', 'ul', 'ol', 'li'];
			const boundaryRoles = ['navigation', 'main', 'region', 'dialog', 'list', 'grid', 'tabpanel', 'tree', 'complementary', 'banner', 'contentinfo', 'form'];
			const isBoundary = boundaryTags.includes(tag) || boundaryRoles.includes(role) || isScrollable;

			const contentTags = ['img', 'svg', 'video', 'canvas', 'audio'];
			const isHeading = /^h[1-6]$/.test(tag);
			const isContent = contentTags.includes(tag) || isHeading || tag === 'p' || role === 'img';

			let category = 'structural';
			if (isInteractive) category = 'interactive';
			else if (isBoundary) category = 'boundary';
			else if (isContent) category = 'content';

			return { category, isInteractive, isBoundary, isContent };
		};

		const getReferencedText = (idsAttr) => {
			const ids = String(idsAttr || '').trim().split(/\s+/).filter(Boolean);
			const out = [];
			for (const id of ids) {
				const ref = document.getElementById(id);
				if (!ref) continue;
				const txt = normalize(ref.innerText || ref.textContent || '');
				if (txt) out.push(txt);
			}
			return out;
		};

		const readPseudoContent = (el, pseudo) => {
			try {
				const content = window.getComputedStyle(el, pseudo).content;
				if (!content || content === 'none') return '';
				return normalize(String(content).replace(/^["']|["']$/g, ''));
			} catch {
				return '';
			}
		};

		const getElementText = (el) => {
			const texts = [];

			// Accessibility-first priority
			const ariaLabel = el.getAttribute('aria-label') || '';
			if (ariaLabel) texts.push(ariaLabel);

			texts.push(...getReferencedText(el.getAttribute('aria-labelledby')));

			const ariaDescription = el.getAttribute('aria-description') || '';
			if (ariaDescription) texts.push(ariaDescription);

			texts.push(...getReferencedText(el.getAttribute('aria-describedby')));

			const placeholder = el.getAttribute('placeholder') || '';
			if (placeholder) texts.push(placeholder);

			const title = el.getAttribute('title') || '';
			if (title) texts.push(title);

			const alt = el.getAttribute('alt') || '';
			if (alt) texts.push(alt);

			if (typeof el.value === 'string' && el.value.trim()) texts.push(el.value);

			const dataAttrSignal = /(label|name|title|placeholder|text|plain|desc|content)/i;
			const dataAttrs = (el.getAttributeNames ? el.getAttributeNames() : [])
				.filter((name) => name.startsWith('data-'))
				.sort();
			for (const attr of dataAttrs) {
				if (!dataAttrSignal.test(attr)) continue;
				const value = el.getAttribute(attr) || '';
				if (value) texts.push(value);
			}

			for (const child of Array.from(el.childNodes)) {
				if (child.nodeType === Node.TEXT_NODE) {
					const txt = normalize(child.textContent || '');
					if (txt) texts.push(txt);
				}
			}

			const beforeText = readPseudoContent(el, '::before');
			if (beforeText) texts.push(beforeText);
			const afterText = readPseudoContent(el, '::after');
			if (afterText) texts.push(afterText);

			return dedupe(texts);
		};

		// 2) buildRawTree
		function buildRawTree(el) {
			if (!isVisible(el)) {
				const visibleChildren = [];
				for (const child of Array.from(el.children)) {
					const c = buildRawTree(child);
					if (c) visibleChildren.push(c);
				}
				if (visibleChildren.length === 0) return null;
				if (visibleChildren.length === 1) return visibleChildren[0];
				return {
					tag: 'div',
					role: '',
					category: 'structural',
					id: null,
					labels: [],
					inputValue: '',
					isInputLike: false,
					rect: getRect(el),
					selector: '',
					isInteractive: false,
					isBoundary: false,
					isContent: false,
					isMedia: false,
					children: visibleChildren
				};
			}
			const info = classify(el);
			if (info.category === 'ignore') return null;
			const tag = el.tagName.toLowerCase();
			const role = (el.getAttribute('role') || '').toLowerCase();
			const inputLikeRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
			const isInputLike = ['input', 'textarea', 'select'].includes(tag) || el.isContentEditable || inputLikeRoles.has(role);

			let inputValue = '';
			if (isInputLike) {
				if (tag === 'select') {
					if (typeof el.value === 'string' && el.value.trim()) {
						inputValue = normalize(el.value);
					} else if (el.selectedOptions && el.selectedOptions.length > 0) {
						inputValue = normalize(el.selectedOptions[0].textContent || '');
					}
				} else if (el.isContentEditable || inputLikeRoles.has(role)) {
					inputValue = normalize(el.innerText || el.textContent || '');
				} else if (typeof el.value === 'string') {
					inputValue = normalize(el.value);
				}
			}

			const node = {
				tag,
				role: el.getAttribute('role') || '',
				category: info.category,
				id: info.isInteractive ? getId(el) : null,
				labels: getElementText(el),
				inputValue,
				isInputLike,
				rect: getRect(el),
				selector: selectorFor(el),
				isInteractive: info.isInteractive,
				isBoundary: info.isBoundary,
				isContent: info.isContent,
				isMedia: info.isContent,
				children: []
			};

			for (const child of Array.from(el.children)) {
				const c = buildRawTree(child);
				if (c) node.children.push(c);
			}

			return node;
		}

		// 3) collapse
		function collapse(node) {
			if (!node) return null;
			const children = (node.children || []).map(collapse).filter(Boolean);
			const isStructural = node.category === 'structural'
				&& (node.labels || []).length === 0
				&& !node.role
				&& !node.id;
			if (isStructural && children.length === 1) return children[0];
			node.children = children;
			return node;
		}

		// 4) detectPatterns
		function fingerprint(node) {
			const t = node.labels && node.labels.length > 0 ? 'T' : '';
			const i = node.isInteractive ? 'I' : '';
			const m = node.isContent || node.isMedia ? 'M' : '';
			const c = node.children && node.children.length > 0 ? 'C' : '';
			return t + i + m + c;
		}

		function similarity(a, b) {
			const aa = String(a || '');
			const bb = String(b || '');
			const total = Math.max(aa.length, bb.length);
			if (total === 0) return 1;
			let match = 0;
			for (let i = 0; i < total; i++) {
				if (aa[i] === bb[i]) match += 1;
			}
			return match / total;
		}

		function detectPatterns(children) {
			const fp = children.map(fingerprint);
			const groups = [];
			for (let unit = 1; unit <= 4; unit++) {
				for (let start = 0; start <= fp.length - unit * 2; start++) {
					let count = 1;
					let pos = start + unit;
					while (pos + unit <= fp.length) {
						let ok = true;
						for (let i = 0; i < unit; i++) {
							if (similarity(fp[start + i], fp[pos + i]) < 0.75) {
								ok = false;
								break;
							}
						}
						if (!ok) break;
						count += 1;
						pos += unit;
					}
					if (count >= 3) {
						groups.push({ start, unit, count, span: unit * count });
					}
				}
			}
			return groups;
		}

		// 5) convertToList + tree application
		function convertToList(children, group) {
			const items = [];
			for (let i = 0; i < group.count; i++) {
				const start = group.start + i * group.unit;
				const unitNodes = children.slice(start, start + group.unit);
				items.push({
					tag: 'item',
					role: '',
					category: 'boundary',
					id: null,
					labels: [],
					inputValue: '',
					isInputLike: false,
					rect: unitNodes[0]?.rect || null,
					selector: '',
					isInteractive: false,
					isBoundary: true,
					isContent: false,
					children: unitNodes
				});
			}
			return {
				tag: 'list',
				role: '',
				category: 'boundary',
				id: null,
				labels: [],
				inputValue: '',
				isInputLike: false,
				rect: items[0]?.rect || null,
				selector: '',
				isInteractive: false,
				isBoundary: true,
				isContent: false,
				children: items
			};
		}

		function applyRepeatedPatterns(node) {
			if (!node) return null;
			node.children = (node.children || []).map(applyRepeatedPatterns).filter(Boolean);
			const children = node.children || [];
			if (children.length < 3) return node;

			const groups = detectPatterns(children);
			if (!groups.length) return node;

			const bestByStart = new Map();
			for (const group of groups) {
				const prev = bestByStart.get(group.start);
				const better = !prev
					|| group.span > prev.span
					|| (group.span === prev.span && group.unit < prev.unit)
					|| (group.span === prev.span && group.unit === prev.unit && group.count > prev.count);
				if (better) bestByStart.set(group.start, group);
			}

			const rewritten = [];
			let idx = 0;
			while (idx < children.length) {
				const group = bestByStart.get(idx);
				if (group && idx + group.span <= children.length) {
					rewritten.push(convertToList(children, group));
					idx += group.span;
				} else {
					rewritten.push(children[idx]);
					idx += 1;
				}
			}
			node.children = rewritten;
			return node;
		}

		const rawRoot = buildRawTree(document.body || document.documentElement);
		const collapsedRoot = collapse(rawRoot);
		const semanticTree = applyRepeatedPatterns(collapsedRoot);

		return {
			url: window.location.href,
			title: document.title,
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight,
				scrollX: window.scrollX,
				scrollY: window.scrollY
			},
			tree: semanticTree
		};
	}, normalized));
}

function parseIndex(value) {
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`Invalid index: ${value}`);
	}
	return n;
}

function parseTargetArg(args, commandName) {
	if (!args.length) {
		throw new Error(
			`${commandName} requires <index|--id <elementId>|--selector <cssSelector>>`
		);
	}

	const first = args[0];

	if (first === '--id') {
		const id = normalizeElementId(args[1]);
		if (!id) throw new Error(`${commandName} missing value for --id`);
		return { target: { kind: 'id', value: id }, consumed: 2 };
	}

	if (first.startsWith('--id=')) {
		const id = normalizeElementId(first.slice('--id='.length));
		if (!id) throw new Error(`${commandName} missing value for --id`);
		return { target: { kind: 'id', value: id }, consumed: 1 };
	}

	if (first === '--selector') {
		const selector = args[1] || '';
		if (!selector) throw new Error(`${commandName} missing value for --selector`);
		return { target: { kind: 'selector', value: selector }, consumed: 2 };
	}

	if (first.startsWith('--selector=')) {
		const selector = first.slice('--selector='.length);
		if (!selector) throw new Error(`${commandName} missing value for --selector`);
		return { target: { kind: 'selector', value: selector }, consumed: 1 };
	}

	try {
		return { target: { kind: 'index', value: parseIndex(first) }, consumed: 1 };
	} catch {
		// Positional non-numeric targets default to element IDs.
		// Selector-like tokens can still be passed positionally for convenience.
		const looksLikeSelector = /[#.:[\]>*+~]/.test(first) || first.startsWith('//');
		if (looksLikeSelector) {
			return { target: { kind: 'selector', value: first }, consumed: 1 };
		}
		const id = normalizeElementId(first);
		if (!id) throw new Error(`${commandName} invalid target: ${first}`);
		return { target: { kind: 'id', value: id }, consumed: 1 };
	}
}

function parseScreenshotArgs(args) {
	let outputPath = '';
	let toStdout = false;

	for (const arg of args) {
		if (arg === '--stdout') {
			toStdout = true;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown screenshot option: ${arg}`);
		}
		if (!outputPath) {
			outputPath = arg;
			continue;
		}
		throw new Error('screenshot accepts at most one path argument');
	}

	return {
		toStdout,
		outputPath: outputPath || `screenshot-${Date.now()}.png`
	};
}

function parseQueryArgs(args) {
	const selector = args[0] || '';
	if (!selector) {
		throw new Error('query requires <cssSelector>');
	}

	let field = 'text';
	let all = false;

	for (let i = 1; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--all') {
			all = true;
			continue;
		}
		if (arg === '--field') {
			const value = args[i + 1] || '';
			if (!value) throw new Error('query --field requires a value');
			field = value;
			i += 1;
			continue;
		}
		if (arg.startsWith('--field=')) {
			field = arg.slice('--field='.length);
			if (!field) throw new Error('query --field requires a value');
			continue;
		}
		if (arg === '--attr') {
			const name = args[i + 1] || '';
			if (!name) throw new Error('query --attr requires a value');
			field = `attr:${name}`;
			i += 1;
			continue;
		}
		if (arg.startsWith('--attr=')) {
			const name = arg.slice('--attr='.length);
			if (!name) throw new Error('query --attr requires a value');
			field = `attr:${name}`;
			continue;
		}
		if (!arg.startsWith('--') && field === 'text') {
			field = arg;
			continue;
		}
		throw new Error(`Unknown query option: ${arg}`);
	}

	return { selector, field, all };
}

function parsePositiveInt(value, label) {
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return n;
}

function parseStateArgs(args, agentMode = false) {
	const out = agentMode
		? {
			includeClickable: true,
			includeInputs: true,
			includeText: false,
			maxClickable: 160,
			maxInputs: 60,
			maxText: 120,
			includeSemantic: true,
			maxBlocks: 120,
			maxRecords: 140,
			maxLandmarks: 16,
			hierarchyMode: 'summary',
			showDetails: false,
			includeRaw: false,
			focus: '',
			includeAll: false,
			offset: 0,
			limit: Number.POSITIVE_INFINITY
		}
		: {
			includeClickable: true,
			includeInputs: true,
			includeText: false,
			maxClickable: 220,
			maxInputs: 90,
			maxText: 160,
			includeSemantic: true,
			maxBlocks: 180,
			maxRecords: 220,
			maxLandmarks: 18,
			hierarchyMode: 'summary',
			showDetails: false,
			includeRaw: false,
			focus: '',
			includeAll: false,
			offset: 0,
			limit: Number.POSITIVE_INFINITY
		};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];

		if (arg === '--offset') {
			out.offset = parsePositiveInt(args[i + 1], 'state --offset');
			i += 1;
			continue;
		}
		if (arg.startsWith('--offset=')) {
			out.offset = parsePositiveInt(arg.slice('--offset='.length), 'state --offset');
			continue;
		}
		if (arg === '--limit') {
			out.limit = parsePositiveInt(args[i + 1], 'state --limit');
			i += 1;
			continue;
		}
		if (arg.startsWith('--limit=')) {
			out.limit = parsePositiveInt(arg.slice('--limit='.length), 'state --limit');
			continue;
		}

		if (arg === '--hier' || arg === '--tree') {
			out.hierarchyMode = 'summary';
			continue;
		}
		if (arg === '--hier=summary' || arg === '--tree=summary') {
			out.hierarchyMode = 'summary';
			continue;
		}
		if (arg === '--hier=full' || arg === '--tree=full') {
			out.hierarchyMode = 'full';
			continue;
		}
		if (arg === '--no-hier') {
			out.hierarchyMode = 'none';
			continue;
		}
		if (arg === '--focus') {
			const value = String(args[i + 1] || '').trim();
			if (!value) throw new Error('state --focus requires a value');
			out.focus = value;
			i += 1;
			continue;
		}
		if (arg.startsWith('--focus=')) {
			const value = String(arg.slice('--focus='.length) || '').trim();
			if (!value) throw new Error('state --focus requires a value');
			out.focus = value;
			continue;
		}
		throw new Error(`Unknown state option: ${arg}`);
	}

	if (!out.includeClickable && !out.includeInputs && !out.includeText) {
		throw new Error('state output would be empty; include at least one section');
	}

	if (out.hierarchyMode === 'none' && !out.includeRaw) {
		out.includeRaw = true;
	}

	return out;
}

function flattenTree(node, acc = []) {
	if (!node) return acc;
	if (node.id || node.sectionId) acc.push(node);
	(node.children || []).forEach(child => flattenTree(child, acc));
	return acc;
}

function resetRuntimeInteractionMap() {
	runtimeInteractionMap = {
		byId: new Map(),
		orderedInteractiveIds: [],
		inputIds: new Set()
	};
}

function registerRuntimeTarget(id, data) {
	const key = normalizeElementId(id);
	if (!key) return;
	if (!runtimeInteractionMap.byId.has(key)) {
		runtimeInteractionMap.orderedInteractiveIds.push(key);
	}
	const existing = runtimeInteractionMap.byId.get(key) || {};
	runtimeInteractionMap.byId.set(key, {
		selector: data.selector || existing.selector || '',
		rect: data.rect || existing.rect || null,
		isInput: data.isInput === true || existing.isInput === true
	});
	if (data.isInput === true) {
		runtimeInteractionMap.inputIds.add(key);
	}
}

function buildStatePayload(state, stateOptions) {
	const sourceTree = state.tree || { tag: 'body', children: [] };
	resetRuntimeInteractionMap();

	let sectionCounter = 0;
	const normalizeText = (v) => String(v || '')
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
		.replace(/[\uFE00-\uFE0F]/g, '')
		.replace(/\u00AD/g, '')
		.replace(/(\d{4,})(\p{L})/gu, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim();

	const parseBracketPrefixedLabel = (value) => {
		const raw = normalizeText(value);
		const m = raw.match(/^\[(.*?)\]\s*(.*?):\s*$/);
		if (!m) return null;
		const prefix = normalizeText(m[1]);
		const label = normalizeText(m[2]);
		if (!prefix && !label) return null;
		return { raw, prefix, label };
	};

	const collapseContainedTexts = (arr) => {
		const list = [...arr];
		const out = [];
		for (let i = 0; i < list.length; i += 1) {
			const t = list[i];
			const key = t.toLowerCase();
			const isTiny = t.length < 4;
			const looksCompactNumeric = /\d/.test(t) && t.length <= 18;
			let contained = false;
			if (!isTiny && !looksCompactNumeric) {
				for (let j = 0; j < list.length; j += 1) {
					if (i === j) continue;
					const other = list[j];
					if (other.length <= t.length + 6) continue;
					if (other.toLowerCase().includes(key)) {
						contained = true;
						break;
					}
				}
			}
			if (!contained) out.push(t);
		}
		return out;
	};

	const dedupeTexts = (arr) => {
		const out = [];
		const seen = new Set();
		for (const raw of arr || []) {
			const value = normalizeText(raw);
			if (!value) continue;
			const key = value.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(value);
		}
		return collapseContainedTexts(out);
	};

	const enrichTexts = (arr) => {
		const base = dedupeTexts(arr);
		const withoutMeta = [];
		const metaParts = [];
		for (const value of base) {
			const meta = parseBracketPrefixedLabel(value);
			if (meta) {
				if (meta.label) metaParts.push(meta.label);
				if (meta.prefix) metaParts.push(meta.prefix);
			} else {
				withoutMeta.push(value);
			}
		}
		return dedupeTexts([...metaParts, ...withoutMeta]);
	};

	// 6) collectSubtreeText
	function collectSubtreeText(node, depth = 0, options = {}) {
		if (!node || depth > 10) return [];
		let texts = [...(node.labels || [])];
		const includeInteractive = options.includeInteractive === true;
		for (const child of (node.children || [])) {
			if (child.isInteractive && !includeInteractive) continue;
			if (child.isBoundary) continue;
			texts = texts.concat(collectSubtreeText(child, depth + 1, options));
		}
		return enrichTexts(texts);
	}

	// 7) transform
	function transform(node, parentIsBoundary = false) {
		if (!node) return null;
		const result = {};

			if (node.isBoundary && !parentIsBoundary) {
				sectionCounter += 1;
				result.sectionId = `S${sectionCounter}`;
			}

		if (node.isInteractive) {
			result.id = normalizeElementId(node.id);
			const keepWithoutTextTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'option', 'summary', 'details']);
			const children = node.children || [];
			const directInteractiveChildCount = children.filter((c) => c && c.isInteractive).length;
			const includeInteractiveDescendants = !keepWithoutTextTags.has(node.tag) && directInteractiveChildCount <= 1;
			const text = collectSubtreeText(node, 0, { includeInteractive: includeInteractiveDescendants });
			if (text.length > 0) result.text = text;
			result.__meta = { rect: node.rect || null };
			const inputRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
			const isInput = node.isInputLike === true
				|| node.tag === 'input'
				|| node.tag === 'textarea'
				|| node.tag === 'select'
				|| inputRoles.has(String(node.role || '').toLowerCase());
			if (isInput) {
				result.type = 'input';
				const content = normalizeText(node.inputValue || '');
				if (content) {
					result.content = content;
					if (Array.isArray(result.text)) {
						const contentKey = content.toLowerCase();
						result.text = result.text.filter((t) => normalizeText(t).toLowerCase() !== contentKey);
						if (result.text.length === 0) delete result.text;
					}
				}
			}

				const countSubtreeNodes = (n, limit = 120) => {
				let count = 0;
				const stack = [n];
				while (stack.length && count < limit) {
					const cur = stack.pop();
					if (!cur) continue;
					count += 1;
					const kids = cur.children || [];
					for (let i = 0; i < kids.length; i += 1) stack.push(kids[i]);
					}
					return count;
				};
				const subtreeSize = countSubtreeNodes(node);
				const rect = node.rect || {};
				const hasMeaningfulText = Array.isArray(result.text) && result.text.length > 0;
				const isLikelyRootContainer = Number(rect.height || 0) > 180
					|| (Number(rect.width || 0) > 500 && children.length > 10);
				const hasMultipleInteractiveChildren = directInteractiveChildCount >= 2;
				const shouldExpandContainerInteractive = !keepWithoutTextTags.has(node.tag)
					&& (
						hasMultipleInteractiveChildren
						|| (
						!hasMeaningfulText
						|| (
							isLikelyRootContainer
							&& (children.length >= 8 || subtreeSize >= 40 || (node.isBoundary && children.length > 0))
						)
						)
					);

			// Expand container-like interactive wrappers so descendants (e.g. chat rows) are preserved.
				if (shouldExpandContainerInteractive) {
					const expandedChildren = children
						.flatMap((child) => {
							const transformed = transform(child, node.isBoundary);
							if (!transformed) return [];
							return Array.isArray(transformed) ? transformed : [transformed];
						});
					if (result.text && result.text.length > 0) {
						return expandedChildren.length > 0
							? [{ text: result.text, __meta: result.__meta }, ...expandedChildren]
							: [{ text: result.text, __meta: result.__meta }];
					}
					return expandedChildren.length > 0 ? expandedChildren : null;
				}

			// Drop generic interactive wrappers with no semantic value.
			if (!result.text && !result.type && !keepWithoutTextTags.has(node.tag)) {
				const flattenedChildren = children
					.flatMap((child) => {
						const transformed = transform(child, node.isBoundary);
						if (!transformed) return [];
						return Array.isArray(transformed) ? transformed : [transformed];
					});
				return flattenedChildren.length > 0 ? flattenedChildren : null;
			}

			registerRuntimeTarget(result.id, {
				selector: node.selector || '',
				rect: node.rect || null,
				isInput
			});
			return result;
		}

			const labels = dedupeTexts(node.labels || []);
			if (labels.length > 0) {
				result.text = enrichTexts(labels);
			}
			result.__meta = { rect: node.rect || null };

			if (node.tag === 'img' || node.tag === 'svg' || node.tag === 'video' || node.tag === 'canvas') {
				// Keep only meaningful media; tiny icons are usually decorative noise.
				const rect = node.rect || {};
				const isTiny = Number(rect.width || 0) < 24 && Number(rect.height || 0) < 24;
				if (!isTiny || labels.length > 0) {
					result.type = 'image';
				}
			}

		let children = (node.children || [])
			.flatMap((child) => {
				const transformed = transform(child, node.isBoundary);
				if (!transformed) return [];
				return Array.isArray(transformed) ? transformed : [transformed];
			});

		// 8) mergeTextNodes
		children = mergeTextNodes(children);

		// Remove parent text that is already represented by immediate children.
		if (result.text && children.length > 0) {
			const childTextSet = new Set();
			for (const child of children) {
				for (const t of (child.text || [])) {
					childTextSet.add(normalizeText(t).toLowerCase());
				}
			}
			result.text = result.text.filter((t) => !childTextSet.has(normalizeText(t).toLowerCase()));
			if (result.text.length === 0) delete result.text;
		}

		if (children.length > 0) {
			result.children = children;
		}

		if (!result.id && !result.sectionId && !result.text && !result.children && !result.type) {
			return null;
		}

		// Drop empty section wrappers.
		if (result.sectionId && !result.id && !result.text && !result.type && !result.children) {
			return null;
		}

		// Flatten wrappers that carry no semantic payload.
		if (!result.sectionId && !result.id && !result.text && !result.type) {
			if (result.children && result.children.length > 0) return result.children;
			return null;
		}

		return result;
	}

		function canMergeAdjacentTextSiblings(nodes) {
			const list = Array.isArray(nodes) ? nodes : [];
			if (list.length < 3) return false;

			const idIndexes = [];
			let textOnlyCount = 0;

			for (let i = 0; i < list.length; i += 1) {
				const n = list[i];
				if (!n || typeof n !== 'object') return false;
				if (n.children || n.sectionId || n.type) return false;
				if (n.id) idIndexes.push(i);
				if (!n.id && Array.isArray(n.text) && n.text.length > 0) {
					textOnlyCount += 1;
				}
			}

			if (idIndexes.length !== 1) return false;
			if (idIndexes[0] !== 0) return false;
			if (textOnlyCount < 2) return false;
			return true;
		}

		function mergeTextNodes(nodes) {
			if (!canMergeAdjacentTextSiblings(nodes)) return nodes;
			const merged = [];
			for (let i = 0; i < nodes.length; i++) {
				const cur = nodes[i];
				if (cur.text && !cur.children && !cur.id) {
				const texts = [...cur.text];
				let j = i + 1;
				while (nodes[j] && nodes[j].text && !nodes[j].children && !nodes[j].id) {
						texts.push(...nodes[j].text);
						j += 1;
					}
					merged.push({ text: enrichTexts(texts), __meta: cur.__meta || null });
					i = j - 1;
				} else {
					merged.push(cur);
				}
			}
			return merged;
		}

		function clusterRows(nodes) {
			const list = Array.isArray(nodes) ? nodes : [];
			const rowCandidates = list
				.filter((n) => n && !n.children && (n.id || n.text) && n.__meta && n.__meta.rect)
				.map((n) => ({ node: n, rect: n.__meta.rect }))
				.filter((e) => e.rect && Number.isFinite(e.rect.y) && Number.isFinite(e.rect.x));

			if (rowCandidates.length < 20) return list;

			rowCandidates.sort((a, b) => {
				if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
				return a.rect.x - b.rect.x;
			});

			const threshold = 12;
			const clusters = [];
			let current = [];
			for (const entry of rowCandidates) {
				if (current.length === 0) {
					current.push(entry);
					continue;
				}
				const dy = Math.abs(entry.rect.y - current[0].rect.y);
				if (dy <= threshold) {
					current.push(entry);
				} else {
					clusters.push(current);
					current = [entry];
				}
			}
			if (current.length) clusters.push(current);

			if (clusters.length < 8) return list;
			const avgRowSize = rowCandidates.length / clusters.length;
			if (avgRowSize > 8) return list;

			const splitRowTexts = (node) => {
				const texts = enrichTexts(node.text || []);
				if (texts.length <= 1) return [node];

				const isAuxiliaryToken = (t) => {
					const s = String(t || '').toLowerCase();
					if (!s) return false;
					const compact = s.length <= 28;
					const fewWords = s.split(/\s+/).length <= 5;
					const hasDigit = /\d/.test(s);
					const hasStructuralPunct = /[:/.-]/.test(s);
					return compact && fewWords && (hasDigit || hasStructuralPunct);
				};
				const isBadgeLikeToken = (t) => {
					const s = String(t || '').trim();
					if (!s) return false;
					const short = s.length <= 32;
					const fewWords = s.split(/\s+/).length <= 5;
					const numeric = /^\d+\b/.test(s) || /\b\d+\b/.test(s);
					return short && fewWords && numeric;
				};

				const names = [];
				const aux = [];
				const badges = [];
				const messages = [];

				for (const t of texts) {
					if (isBadgeLikeToken(t)) {
						badges.push(t);
						continue;
					}
					if (isAuxiliaryToken(t)) {
						aux.push(t);
						continue;
					}
					if (names.length === 0) names.push(t);
					else messages.push(t);
				}

				const children = [];
				const firstText = names.length > 0 ? dedupeTexts(names) : dedupeTexts([texts[0]]);
				const hasCountBadge = badges.length > 0;
				const cleanMessages = hasCountBadge
					? messages.filter((m) => !/^\d{1,3}$/.test(String(m || '').trim()))
					: messages;
				children.push({ id: node.id, text: firstText });
				if (aux.length > 0) children.push({ text: dedupeTexts(aux) });
				if (cleanMessages.length > 0) children.push({ text: dedupeTexts(cleanMessages) });
				if (badges.length > 0) children.push({ text: dedupeTexts(badges) });
				return children;
			};

			const clusterNodes = clusters.map((row) => {
				const sorted = [...row].sort((a, b) => a.rect.x - b.rect.x).map((e) => e.node);
				sectionCounter += 1;
				if (sorted.length === 1 && sorted[0].id && Array.isArray(sorted[0].text) && sorted[0].text.length > 1) {
					return {
						sectionId: `S${sectionCounter}`,
						children: splitRowTexts(sorted[0]),
						__meta: { rect: row[0].rect }
					};
				}
				return {
					sectionId: `S${sectionCounter}`,
					children: sorted,
					__meta: { rect: row[0].rect }
				};
			});

			const nodeToCluster = new Map();
			clusters.forEach((row, idx) => row.forEach((entry) => nodeToCluster.set(entry.node, idx)));
			const emitted = new Set();
			const out = [];
			for (const item of list) {
				if (!nodeToCluster.has(item)) {
					out.push(item);
					continue;
				}
				const idx = nodeToCluster.get(item);
				if (emitted.has(idx)) continue;
				emitted.add(idx);
				out.push(clusterNodes[idx]);
			}
			return out;
		}

	// 9) finalCollapse
		function finalCollapse(node) {
			if (!node) return null;
			if (!node.children) return node;
			node.children = node.children
				.map(finalCollapse)
				.filter(Boolean);
			if (!node.id && !node.text && !node.sectionId && node.children.length === 1) {
				return node.children[0];
			}
			return node;
		}

		function applyRowClustering(node) {
			if (!node || !node.children) return node;
			node.children = node.children.map(applyRowClustering).filter(Boolean);
			node.children = clusterRows(node.children);
			return node;
		}

		function stripInternal(node) {
			if (!node || typeof node !== 'object') return node;
			const out = {};
			if (node.sectionId) out.sectionId = node.sectionId;
			if (node.id) out.id = node.id;
			if (node.text && node.text.length > 0) out.text = enrichTexts(node.text);
			if (node.type) out.type = node.type;
			if (node.type === 'input' && typeof node.content === 'string' && node.content.length > 0) {
				out.content = normalizeText(node.content);
			}
			if (node.children && node.children.length > 0) {
				const children = node.children.map(stripInternal).filter(Boolean);
				if (children.length > 0) out.children = children;
			}
			if (!out.sectionId && !out.id && !out.text && !out.type && !out.content && !out.children) return null;
			return out;
		}

		function collectInteractiveTextSet(node, set = new Set()) {
			if (!node || typeof node !== 'object') return set;
			if (node.id && Array.isArray(node.text)) {
				for (const t of node.text) set.add(normalizeText(t).toLowerCase());
			}
			for (const child of (node.children || [])) collectInteractiveTextSet(child, set);
			return set;
		}

		function pruneRedundantTextLeaves(node, interactiveTextSet) {
			if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
			node.children = node.children
				.map((child) => pruneRedundantTextLeaves(child, interactiveTextSet))
				.filter(Boolean)
				.filter((child) => {
					if (child.id || child.children || child.type || !child.text) return true;
					const texts = child.text.map((t) => normalizeText(t).toLowerCase()).filter(Boolean);
					if (texts.length === 0) return false;
					return !texts.every((t) => interactiveTextSet.has(t));
					});
			return node;
		}

		function flattenTextNodes(node) {
			if (!node || typeof node !== 'object') return node;

			const removeStandaloneShadowTexts = (texts) => {
				const list = enrichTexts(texts || []);
				if (list.length <= 1) return list;
				return list.filter((t) => {
					const raw = normalizeText(t);
					if (!raw) return false;
					const short = raw.length <= 24;
					const hasSignal = /[\d:/.-]/.test(raw);
					if (!short || !hasSignal) return true;
					const key = raw.toLowerCase();
					return !list.some((other) => {
						const o = normalizeText(other).toLowerCase();
						return o !== key && o.length > key.length && o.includes(key);
					});
				});
			};

			if (Array.isArray(node.children)) {
				node.children = node.children.map(flattenTextNodes).filter(Boolean);
			}

			if (
				node.text &&
				!node.id &&
				!node.sectionId &&
				Array.isArray(node.children) &&
				node.children.length === 1
			) {
				const child = node.children[0];
				if (
					child &&
					child.text &&
					!child.id &&
					!child.sectionId &&
					!child.type &&
					!child.children
				) {
					node.text = removeStandaloneShadowTexts([...node.text, ...child.text]);
					delete node.children;
				}
			}

			if (node.text) {
				node.text = removeStandaloneShadowTexts(node.text);
			}

			return node;
		}

		function removeRedundantShadowTextLeaves(node) {
			if (!node || typeof node !== 'object') return node;

			const normalizeKey = (value) => normalizeText(value).toLowerCase();
			const collectShadowCandidates = (texts, set) => {
				for (const t of (texts || [])) {
					const raw = normalizeText(t);
					if (!raw) continue;
					if (raw.length > 24) continue;
					if (!/[\d:/.-]/.test(raw)) continue;
					set.add(raw.toLowerCase());
				}
			};

			if (Array.isArray(node.children)) {
				node.children = node.children.map(removeRedundantShadowTextLeaves).filter(Boolean);
			}

			const shadowCandidates = new Set();
			collectShadowCandidates(node.text, shadowCandidates);
			for (const child of (node.children || [])) collectShadowCandidates(child.text, shadowCandidates);
			const scopeTexts = [];
			if (Array.isArray(node.text)) scopeTexts.push(...node.text);
			for (const child of (node.children || [])) if (Array.isArray(child.text)) scopeTexts.push(...child.text);
			const normalizedScope = scopeTexts.map((t) => normalizeKey(t)).filter(Boolean);

			const removeStandaloneShadows = (texts) => {
				const list = enrichTexts(texts || []);
				if (shadowCandidates.size === 0) return list;
				return list.filter((t) => {
					const key = normalizeKey(t);
					if (!shadowCandidates.has(key)) return true;
					return !normalizedScope.some((other) => other !== key && other.length > key.length && other.includes(key));
				});
			};

			if (node.text) node.text = removeStandaloneShadows(node.text);

			if (Array.isArray(node.children)) {
				node.children = node.children
					.map((child) => {
						if (!child || typeof child !== 'object' || !child.text) return child;
						child.text = removeStandaloneShadows(child.text);
						return child;
					})
					.filter((child) => {
						if (!child || typeof child !== 'object') return false;
						if (child.id || child.sectionId || child.type || child.children) return true;
						return Array.isArray(child.text) && child.text.length > 0;
					});
			}

			return node;
		}

		function finalDedupeTextArrays(node) {
			if (!node || typeof node !== 'object') return node;

			if (Array.isArray(node.text)) {
				const seen = new Set();
				const deduped = [];
				for (const raw of node.text) {
					const cleaned = normalizeText(raw);
					if (!cleaned) continue;
					const key = cleaned.toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					deduped.push(cleaned);
				}
				if (deduped.length > 0) node.text = deduped;
				else delete node.text;
			}

			if (Array.isArray(node.children)) {
				node.children = node.children
					.map(finalDedupeTextArrays)
					.filter(Boolean)
					.filter((child) => {
						if (!child || typeof child !== 'object') return false;
						if (child.id || child.sectionId || child.type || child.children) return true;
						return Array.isArray(child.text) && child.text.length > 0;
					});
				if (node.children.length === 0) delete node.children;
			}

			return node;
		}

		function mergeAdjacentTextChildren(node) {
			if (!node || typeof node !== 'object') return node;
			if (Array.isArray(node.children)) {
				node.children = node.children.map(mergeAdjacentTextChildren).filter(Boolean);
				if (!canMergeAdjacentTextSiblings(node.children)) return node;
				const merged = [];
				let buffer = null;
				const flush = () => {
					if (!buffer || !Array.isArray(buffer.text) || buffer.text.length === 0) return;
					const seen = new Set();
					const out = [];
					for (const raw of buffer.text) {
						const value = normalizeText(raw);
						if (!value) continue;
						const key = value.toLowerCase();
						if (seen.has(key)) continue;
						seen.add(key);
						out.push(value);
					}
					if (out.length > 0) merged.push({ text: out });
					buffer = null;
				};

				for (const child of node.children) {
					const isTextOnly = child
						&& !child.id
						&& !child.sectionId
						&& !child.type
						&& !child.children
						&& Array.isArray(child.text)
						&& child.text.length > 0;

					if (isTextOnly) {
						if (!buffer) buffer = { text: [] };
						buffer.text.push(...child.text);
						continue;
					}

					flush();
					merged.push(child);
				}
				flush();
				node.children = merged;
				if (node.children.length === 0) delete node.children;
			}
			return node;
		}

	let tree = transform(sourceTree);
	if (Array.isArray(tree)) {
		tree = tree.length === 1 ? tree[0] : { children: tree };
	}
	tree = applyRowClustering(tree);
	tree = finalCollapse(tree) || {};
	tree = stripInternal(tree) || {};
	tree = flattenTextNodes(tree) || {};
	tree = removeRedundantShadowTextLeaves(tree) || {};
	tree = pruneRedundantTextLeaves(tree, collectInteractiveTextSet(tree)) || {};
	tree = finalDedupeTextArrays(tree) || {};
	tree = mergeAdjacentTextChildren(tree) || {};

	let clickableCount = 0;
	let textCount = 0;

	function walk(n, fn) {
		if (Array.isArray(n)) { n.forEach(item => walk(item, fn)); return; }
		fn(n);
		(n.children || []).forEach(c => walk(c, fn));
	}

	if (tree) {
		walk(tree, (n) => {
			if (n.id) clickableCount++;
			else if (n.text) textCount++;
		});
	}

	// --focus: filter tree to the subtree rooted at the given sectionId
	let focusedTree = tree;
	if (stateOptions.focus && tree) {
		const target = stateOptions.focus;
		let found = null;
		walk(tree, n => {
			if (!found && n.sectionId === target) found = n;
		});
		if (found) focusedTree = found;
	}

	return {
		tree: focusedTree || {},
		summary: { clickableCount, textCount, sectionCount: sectionCounter }
	};
}



function parseSheetArgs(args, cmdName) {
	let gid = '';
	let format = 'csv';
	let outputPath = '';
	let lines = 10;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--gid') {
			gid = args[i + 1] || '';
			if (!gid) throw new Error(`${cmdName} --gid requires a value`);
			i += 1;
			continue;
		}
		if (arg.startsWith('--gid=')) {
			gid = arg.slice('--gid='.length);
			if (!gid) throw new Error(`${cmdName} --gid requires a value`);
			continue;
		}
		if (arg === '--format') {
			format = (args[i + 1] || '').toLowerCase();
			if (!format) throw new Error(`${cmdName} --format requires a value`);
			i += 1;
			continue;
		}
		if (arg.startsWith('--format=')) {
			format = arg.slice('--format='.length).toLowerCase();
			if (!format) throw new Error(`${cmdName} --format requires a value`);
			continue;
		}
		if (arg === '--lines') {
			lines = parsePositiveInt(args[i + 1], `${cmdName} --lines`);
			i += 1;
			continue;
		}
		if (arg.startsWith('--lines=')) {
			lines = parsePositiveInt(arg.slice('--lines='.length), `${cmdName} --lines`);
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown ${cmdName} option: ${arg}`);
		}
		if (!outputPath) {
			outputPath = arg;
			continue;
		}
		throw new Error(`${cmdName} received too many positional arguments`);
	}

	if (!['csv', 'tsv'].includes(format)) {
		throw new Error(`${cmdName} --format must be csv or tsv`);
	}

	return { gid, format, outputPath, lines };
}

function parseSheetInfoFromUrl(urlString) {
	const url = new URL(urlString);
	const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
	if (!match) {
		throw new Error('Current page is not a Google Sheet');
	}

	const docId = match[1];
	const gidFromQuery = url.searchParams.get('gid');
	const gidFromHashMatch = (url.hash || '').match(/gid=(\d+)/);
	const gidFromHash = gidFromHashMatch ? gidFromHashMatch[1] : '';
	const gid = gidFromQuery || gidFromHash || '0';

	return { docId, gid };
}

function buildSheetExportUrl(docId, gid, format) {
	const query = new URLSearchParams({
		tqx: `out:${format}`,
		gid: String(gid || '0')
	});
	return `https://docs.google.com/spreadsheets/d/${docId}/gviz/tq?${query.toString()}`;
}

function buildDefaultSheetPath(docId, gid, format) {
	return `/tmp/sheet-${docId}-gid${gid}.${format}`;
}

async function fetchSheetText(page, url) {
	return withContextRetry(page, () => page.evaluate(async ({ exportUrl }) => {
		const response = await fetch(exportUrl, { credentials: 'include' });
		if (!response.ok) {
			throw new Error(`Sheet export failed: HTTP ${response.status}`);
		}
		return response.text();
	}, { exportUrl: url }));
}

function describeTarget(target) {
	if (target.kind === 'index') return `index ${target.value}`;
	if (target.kind === 'id') return `id ${target.value}`;
	return `selector ${target.value}`;
}

function resolveInteractiveIdFromTarget(tree, target, inputOnly = false) {
	if (target.kind === 'id') {
		const id = normalizeElementId(target.value);
		const runtime = runtimeInteractionMap.byId.get(id);
		if (!runtime) {
			throw new Error(`No interactive element with id ${target.value}`);
		}
		if (inputOnly && !runtimeInteractionMap.inputIds.has(id)) {
			throw new Error(`No input element with id ${target.value}`);
		}
		return id;
	}

	const ids = flattenTree(tree)
		.filter((item) => item && item.id)
		.map((item) => normalizeElementId(item.id))
		.filter((id) => runtimeInteractionMap.byId.has(id))
		.filter((id) => !inputOnly || runtimeInteractionMap.inputIds.has(id));

	const id = ids[target.value];
	if (!id) {
		if (inputOnly) throw new Error(`No input element at index ${target.value}`);
		throw new Error(`No clickable element at index ${target.value}`);
	}
	return id;
}

function findClickableByTarget(payload, target) {
	const id = resolveInteractiveIdFromTarget(payload.tree, target, false);
	return { id, ...runtimeInteractionMap.byId.get(id) };
}

function findInputByTarget(payload, target) {
	const id = resolveInteractiveIdFromTarget(payload.tree, target, true);
	return { id, ...runtimeInteractionMap.byId.get(id) };
}

async function robustClickLocator(locator) {
	await locator.waitFor({ state: 'visible', timeout: 10000 });
	await locator.scrollIntoViewIfNeeded().catch(() => { });
	try {
		await locator.click({ timeout: 5000 });
		return true;
	} catch { }
	try {
		await locator.click({ timeout: 5000, force: true });
		return true;
	} catch { }
	return false;
}

async function clickDomElementBySelector(page, selector) {
	return withContextRetry(page, () => page.evaluate((css) => {
		const el = document.querySelector(css);
		if (!el) return false;
		const r = el.getBoundingClientRect();
		const init = {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: Math.round(r.left + r.width / 2),
			clientY: Math.round(r.top + r.height / 2)
		};
		const fire = (type) => {
			try {
				el.dispatchEvent(new MouseEvent(type, init));
			} catch {
				// ignore event constructor issues
			}
		};
		fire('mousedown');
		fire('mouseup');
		fire('click');
		if (typeof el.click === 'function') el.click();
		return true;
	}, selector));
}

async function clickFromStateTarget(page, target) {
	if (target.selector) {
		try {
			const locator = page.locator(target.selector).first();
			const clicked = await robustClickLocator(locator);
			if (clicked) return;
		} catch {
			// Fallback to coordinate click for stale/non-unique selectors.
		}
		const domClicked = await clickDomElementBySelector(page, target.selector).catch(() => false);
		if (domClicked) return;
	}
	if (target.rect && Number.isFinite(target.rect.x) && Number.isFinite(target.rect.y)) {
		await page.mouse.click(target.rect.x, target.rect.y);
		return;
	}
	throw new Error(`Unable to resolve click target for ${target.id || 'unknown id'}`);
}

async function focusAndType(page, target, text) {
	if (target.selector) {
		const locator = page.locator(target.selector).first();
		try {
			await locator.waitFor({ state: 'visible', timeout: 10000 });
			await locator.scrollIntoViewIfNeeded().catch(() => { });
			await locator.fill(text, { timeout: 5000 });
			return;
		} catch {
			try {
				await locator.click({ timeout: 5000 });
			} catch {
				if (target.rect && Number.isFinite(target.rect.x) && Number.isFinite(target.rect.y)) {
					await page.mouse.click(target.rect.x, target.rect.y);
				} else {
					throw new Error(`Unable to resolve type target for ${target.id || 'unknown id'}`);
				}
			}
		}
	} else {
		if (target.rect && Number.isFinite(target.rect.x) && Number.isFinite(target.rect.y)) {
			await page.mouse.click(target.rect.x, target.rect.y);
		} else {
			throw new Error(`Unable to resolve type target for ${target.id || 'unknown id'}`);
		}
	}
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await page.keyboard.type(text, { delay: 15 });
}

async function clickBySelector(page, selector) {
	const locator = page.locator(selector).first();
	const clicked = await robustClickLocator(locator);
	if (clicked) return;
	const domClicked = await clickDomElementBySelector(page, selector);
	if (!domClicked) {
		throw new Error(`No element matched selector: ${selector}`);
	}
}

async function inputBySelector(page, selector, text) {
	await focusAndType(page, { selector }, text);
}

async function ensureReadableFile(filePath) {
	await access(filePath, fsConstants.R_OK).catch(() => {
		throw new Error(`File is not readable: ${filePath}`);
	});
}

async function uploadBySelector(page, selector, filePath) {
	const locator = page.locator(selector).first();
	await locator.waitFor({ state: 'attached', timeout: 10000 });
	await locator.setInputFiles(filePath, { timeout: 10000 });
}

async function uploadByStateTarget(page, target, filePath) {
	if (!target.selector) {
		throw new Error('Target has no selector; use --selector for upload');
	}
	await uploadBySelector(page, target.selector, filePath);
}

async function getActionResult(page, message) {
	const state = await getState(page, {
		includeClickable: true,
		includeInputs: true,
		includeText: false,
		includeSemantic: false
	});
	const payload = buildStatePayload(state, { hierarchyMode: 'summary', showDetails: false });
	return {
		message,
		url: page.url(),
		title: await page.title(),
		summary: payload.summary
	};
}

async function main() {
	const cli = parseCliArgs(process.argv.slice(2));
	const { tabId, positional } = cli;
	outputPrefs = {
		outputJson: cli.outputJson,
		compactJson: cli.compactJson
	};
	const [rawCmd, ...args] = positional;
	const cmdAliases = {
		st: 'state',
		clk: 'click',
		in: 'input',
		op: 'open',
		ls: 'tabs',
		nw: 'new',
		scr: 'screenshot',
		key: 'keys'
	};
	let cmd = cmdAliases[rawCmd] || rawCmd;

	if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
		if (!cmd && tabId) {
			cmd = 'state';
		} else if (!cmd) {
			cmd = 'tabs';
		} else {
			printUsage();
			return;
		}
	}

	if (cmd === 'tabs') {
		const { tabs } = await listTabs();
		printResult({ tabs });
		return;
	}

	if (cmd === 'new') {
		const url = args[0] || 'about:blank';
		const created = await createTab(url);
		const { tabs, byShortId } = await listTabs();
		let shortId = hashToShortId(created.id);
		for (const [candidate, fullId] of byShortId.entries()) {
			if (fullId === created.id) {
				shortId = candidate;
				break;
			}
		}
		const tab = tabs.find((t) => t.id === shortId) || {
			id: shortId,
			title: created.title || '',
			url: created.url || url
		};
		printResult(tab);
		return;
	}

	if (!tabId) {
		const { tabs } = await listTabs();
		printTabRequirement(tabs, outputPrefs);
		process.exitCode = 2;
		return;
	}

	const tabView = await listTabs();
	const fullTabId = resolveTabId(tabId, tabView.byShortId, tabView.byFullId);
	if (!fullTabId) {
		printTabRequirement(tabView.tabs, outputPrefs);
		process.exitCode = 2;
		return;
	}

	const browser = await chromium.connectOverCDP(endpoint);

	try {
		const page = await getPageByTabId(browser, fullTabId);
		if (!page) {
			const { tabs } = await listTabs();
			printTabRequirement(tabs, outputPrefs);
			process.exitCode = 2;
			return;
		}

		await settlePage(page);

		if (cmd === 'open') {
			const url = args[0];
			if (!url) throw new Error('open requires <url>');
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
			printResult(`Opened: ${page.url()}`);
			return;
		}

		if (cmd === 'state') {
			const includeRaw = args.includes('--raw');
			const cleanArgs = args.filter(a => a !== '--raw');
			const stateOptions = parseStateArgs(cleanArgs, cli.agentMode);
			const state = await getState(page, stateOptions);

			if (includeRaw) {
				printResult(state.tree);
				return;
			}

			const payload = buildStatePayload(state, stateOptions);
			printResult(payload.tree || {});
			return;
		}

		if (cmd === 'click') {
			const { target, consumed } = parseTargetArg(args, 'click');
			if (args.length > consumed) {
				throw new Error('click accepts only one target argument');
			}

			if (target.kind === 'selector') {
				await clickBySelector(page, target.value);
				await page.waitForTimeout(300);
				printResult(await getActionResult(page, `Clicked ${describeTarget(target)}`));
				return;
			}

			const state = await getState(page, {
				includeInputs: true,
				includeText: false,
				includeSemantic: true,
				showDetails: true
			});
			const payload = buildStatePayload(state, { includeSemantic: true, showDetails: true });
			const clickable = findClickableByTarget(payload, target);
			await clickFromStateTarget(page, clickable);
			await page.waitForTimeout(300);
			printResult(await getActionResult(page, `Clicked ${describeTarget(target)} (${clickable.id})`));
			return;
		}

		if (cmd === 'input') {
			const { target, consumed } = parseTargetArg(args, 'input');
			const text = args.slice(consumed).join(' ');
			if (!text) {
				throw new Error('input requires <index|--id <elementId>|--selector <cssSelector>> <text>');
			}

			if (target.kind === 'selector') {
				await inputBySelector(page, target.value, text);
				printResult(await getActionResult(page, `Input at ${describeTarget(target)}: ${text}`));
				return;
			}

			const options = {
				includeInputs: true,
				includeText: false,
				includeSemantic: true,
				showDetails: true
			};
			const state = await getState(page, options);
			const payload = buildStatePayload(state, options);
			const inputTarget = findInputByTarget(payload, target);
			await focusAndType(page, inputTarget, text);
			printResult(await getActionResult(page, `Input at ${describeTarget(target)}: ${text}`));
			return;
		}

		if (cmd === 'upload') {
			const { target, consumed } = parseTargetArg(args, 'upload');
			const filePath = args.slice(consumed).join(' ');
			if (!filePath) {
				throw new Error(
					'upload requires <index|--id <elementId>|--selector <cssSelector>> <filePath>'
				);
			}

			await ensureReadableFile(filePath);

			if (target.kind === 'selector') {
				await uploadBySelector(page, target.value, filePath);
				printResult(`Uploaded ${filePath} via ${describeTarget(target)}`);
				return;
			}

			const state = await getState(page, {
				includeInputs: true,
				includeText: false,
				includeSemantic: true,
				showDetails: true
			});
			const payload = buildStatePayload(state, { includeSemantic: true, showDetails: true });
			const clickable = findClickableByTarget(payload, target);
			await uploadByStateTarget(page, clickable, filePath);
			printResult(`Uploaded ${filePath} via ${describeTarget(target)}`);
			return;
		}

		if (cmd === 'query') {
			const { selector, field, all } = parseQueryArgs(args);
			const result = await withContextRetry(page, () => page.evaluate((payload) => {
				const { selector: cssSelector, field: selectedField, all: collectAll } = payload;
				const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();
				const clip = (v, max = 2000) => {
					const s = String(v || '');
					return s.length > max ? `${s.slice(0, max)}...` : s;
				};

				const cssEscape = (value) => {
					if (window.CSS && typeof window.CSS.escape === 'function') {
						return window.CSS.escape(value);
					}
					return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
				};

				const selectorFor = (el) => {
					if (el.id) return `#${cssEscape(el.id)}`;
					const parts = [];
					let current = el;
					while (current && current.nodeType === 1 && parts.length < 6) {
						const tag = current.tagName.toLowerCase();
						let part = tag;
						const cls = Array.from(current.classList || []).slice(0, 2);
						if (cls.length) {
							part += `.${cls.map(cssEscape).join('.')}`;
						}
						const parent = current.parentElement;
						if (parent) {
							const sameTag = Array.from(parent.children).filter(
								(sibling) => sibling.tagName === current.tagName
							);
							if (sameTag.length > 1) {
								const idx = sameTag.indexOf(current);
								if (idx >= 0) {
									part += `:nth-of-type(${idx + 1})`;
								}
							}
						}
						parts.unshift(part);
						current = current.parentElement;
					}
					return parts.join(' > ');
				};

				const readField = (el, selected) => {
					const fieldLower = String(selected || 'text').toLowerCase();
					if (fieldLower.startsWith('attr:')) {
						return clip(el.getAttribute(fieldLower.slice(5)) || '');
					}
					if (fieldLower === 'text') return clip(normalize(el.innerText || el.textContent || ''));
					if (fieldLower === 'value') return clip('value' in el ? el.value || '' : '');
					if (fieldLower === 'href') return clip(el.href || el.getAttribute('href') || '');
					if (fieldLower === 'src') return clip(el.src || el.getAttribute('src') || '');
					if (fieldLower === 'html') return clip(el.innerHTML || '');
					if (fieldLower === 'outerhtml') return clip(el.outerHTML || '');
					if (fieldLower === 'id') return clip(el.id || '');
					if (fieldLower === 'name') return clip(el.getAttribute('name') || '');
					if (fieldLower === 'aria-label') return clip(el.getAttribute('aria-label') || '');
					if (fieldLower === 'tag') return clip(el.tagName.toLowerCase());
					return clip(normalize(el.innerText || el.textContent || ''));
				};

				const nodes = Array.from(document.querySelectorAll(cssSelector));
				const mapped = nodes.map((el) => ({
					selector: selectorFor(el),
					tag: el.tagName.toLowerCase(),
					field: selectedField,
					value: readField(el, selectedField)
				}));

				if (!collectAll) {
					return mapped[0] || null;
				}
				return mapped;
			}, { selector, field, all }));

			if (typeof result === 'object') {
				printResult(result);
			} else {
				printResult(String(result));
			}
			return;
		}

		if (cmd === 'grant') {
			const origin = args[0] || '';
			const rawPermissions = args.slice(1);
			if (!origin || rawPermissions.length === 0) {
				throw new Error('grant requires <origin> <permission[,permission...]...>');
			}
			const permissions = rawPermissions
				.flatMap((item) => String(item).split(','))
				.map((item) => item.trim())
				.filter(Boolean);
			if (!permissions.length) {
				throw new Error('grant requires at least one permission');
			}
			await page.context().grantPermissions(permissions, { origin });
			printResult(`Granted ${permissions.join(', ')} for ${origin}`);
			return;
		}

		if (cmd === 'sheet-export') {
			const { gid: gidArg, format, outputPath } = parseSheetArgs(args, 'sheet-export');
			const pageUrl = page.url();
			const { docId, gid: detectedGid } = parseSheetInfoFromUrl(pageUrl);
			const gid = gidArg || detectedGid;
			const exportUrl = buildSheetExportUrl(docId, gid, format);
			const targetPath = outputPath || buildDefaultSheetPath(docId, gid, format);
			const text = await fetchSheetText(page, exportUrl);
			await writeFile(targetPath, text, 'utf8');
			printResult({
				path: targetPath,
				bytes: Buffer.byteLength(text, 'utf8'),
				docId,
				gid,
				format,
				exportUrl
			});
			return;
		}

		if (cmd === 'sheet-preview') {
			const { gid: gidArg, format, lines } = parseSheetArgs(args, 'sheet-preview');
			const pageUrl = page.url();
			const { docId, gid: detectedGid } = parseSheetInfoFromUrl(pageUrl);
			const gid = gidArg || detectedGid;
			const exportUrl = buildSheetExportUrl(docId, gid, format);
			const text = await fetchSheetText(page, exportUrl);
			const preview = text.split('\n').slice(0, lines);
			printResult({
				docId,
				gid,
				format,
				lines,
				totalBytes: Buffer.byteLength(text, 'utf8'),
				preview
			});
			return;
		}

		if (cmd === 'type') {
			const text = args.join(' ');
			if (!text) throw new Error('type requires <text>');
			await page.keyboard.type(text, { delay: 15 });
			printResult(`Typed: ${text}`);
			return;
		}

		if (cmd === 'keys') {
			const keyRaw = args[0] || '';
			if (!keyRaw) throw new Error('keys requires <KeyOrChord> [target]');
			const targetArgs = args.slice(1);
			let target = null;
			if (targetArgs.length > 0) {
				const parsed = parseTargetArg(targetArgs, 'keys');
				if (parsed.consumed !== targetArgs.length) {
					throw new Error('keys accepts at most one optional target argument');
				}
				target = parsed.target;
			}

			if (target) {
				if (target.kind === 'selector') {
					await clickBySelector(page, target.value);
				} else {
					const state = await getState(page, {
						includeInputs: true,
						includeText: false,
						includeSemantic: true,
						showDetails: true
					});
					const payload = buildStatePayload(state, { includeSemantic: true, showDetails: true });
					const clickable = findClickableByTarget(payload, target);
					await clickFromStateTarget(page, clickable);
				}
				await page.waitForTimeout(120);
			}

			const chord = toKeyChord(keyRaw);
			await page.keyboard.press(chord);
			if (target) {
				printResult(await getActionResult(page, `Pressed: ${chord} at ${describeTarget(target)}`));
			} else {
				printResult(`Pressed: ${chord}`);
			}
			return;
		}

		if (cmd === 'scroll') {
			const direction = (args[0] || '').toLowerCase();
			const amount = Number.parseInt(args[1] || '700', 10);
			if (!['up', 'down'].includes(direction)) {
				throw new Error('scroll requires <up|down> [amount]');
			}
			const y = direction === 'down' ? Math.abs(amount) : -Math.abs(amount);
			await page.mouse.wheel(0, y);
			printResult(`Scrolled ${direction} by ${Math.abs(amount)}`);
			return;
		}

		if (cmd === 'back') {
			await page.goBack({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
			printResult(`URL: ${page.url()}`);
			return;
		}

		if (cmd === 'reload') {
			await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
			printResult(`Reloaded: ${page.url()}`);
			return;
		}

		if (cmd === 'screenshot') {
			const { outputPath, toStdout } = parseScreenshotArgs(args);
			if (toStdout) {
				const pngBuffer = await page.screenshot({ type: 'png', fullPage: true });
				printResult({
					format: 'png',
					encoding: 'base64',
					data: pngBuffer.toString('base64')
				});
				return;
			}

			await page.screenshot({ path: outputPath, fullPage: true });
			printResult(`Saved screenshot: ${outputPath}`);
			return;
		}

		if (cmd === 'eval') {
			const script = args.join(' ');
			if (!script) throw new Error('eval requires <javascript>');
			const result = await withContextRetry(page, () => page.evaluate((code) => {
				// eslint-disable-next-line no-eval
				return eval(code);
			}, script));
			if (typeof result === 'object') {
				printResult(result);
			} else {
				printResult(String(result));
			}
			return;
		}

		throw new Error(`Unknown command: ${cmd}`);
	} finally {
		await browser.close();
	}
}

main().catch((err) => {
	const message = String(err?.message || err);
	if (outputPrefs.outputJson) {
		printJson({ error: message }, outputPrefs.compactJson);
	} else {
		console.error(`browser-cmd error: ${message}`);
	}
	process.exit(1);
});

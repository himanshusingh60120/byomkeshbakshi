// app/page.jsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROPERTIES } from '../lib/properties.js';

const BATCH_SIZE = 40; // URLs per request to /api/scan (server caps at 60)
const PARALLEL_BATCHES = 3; // batches in flight at once
const CONCURRENCY = 8; // page fetches in parallel inside one batch

// One-click inserts for the characters that are a pain to type.
const CHIPS = [
  { label: 'em dash', value: '\u2014' },
  { label: 'en dash', value: '\u2013' },
  { label: 'ellipsis', value: '\u2026' },
  { label: 'curly \u201c', value: '\u201c' },
  { label: 'curly \u201d', value: '\u201d' },
  { label: 'curly \u2019', value: '\u2019' },
  { label: 'nbsp', value: '\u00a0' },
];

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function describeChars(value) {
  return [...value]
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (code === 0x20) return 'space';
      if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
      if (code > 0x7e) return `${ch} U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
      return ch;
    })
    .join(' ');
}

export default function Page() {
  const [property, setProperty] = useState('kingsresearch');
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState('exact');
  const [scope, setScope] = useState('content');
  const [matchCase, setMatchCase] = useState(false);
  const [limit, setLimit] = useState(0); // 0 = whole property
  const [showOptions, setShowOptions] = useState(false);
  const [sortBy, setSortBy] = useState('hits');

  const [counts, setCounts] = useState({}); // propertyId -> url count
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [ranQuery, setRanQuery] = useState(null);

  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const urlCacheRef = useRef(new Map()); // propertyId -> url entries

  const nameOf = useMemo(
    () => Object.fromEntries(PROPERTIES.map((p) => [p.id, p.name])),
    []
  );

  const loadUrls = useCallback(async (id, signal) => {
    const cached = urlCacheRef.current.get(id);
    if (cached) return cached;
    const res = await fetch(`/api/urls?property=${encodeURIComponent(id)}`, { signal });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not read the sitemaps.');
    urlCacheRef.current.set(id, json.urls);
    setCounts((c) => ({ ...c, [id]: json.count }));
    return json.urls;
  }, []);

  // Warm the URL count for the selected property (skipped for "all", which
  // would mean pulling every sitemap of all six properties).
  useEffect(() => {
    if (property === 'all' || counts[property] !== undefined) return;
    const controller = new AbortController();
    loadUrls(property, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [property, counts, loadUrls]);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }

  async function run(event) {
    event?.preventDefault();
    const q = term;
    if (!q) {
      setError('Type something to search for.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setError('');
    setResults([]);
    setRunning(true);
    setRanQuery({ q, mode, scope, matchCase, property });
    setProgress({ done: 0, total: 0, matched: 0, failed: 0, emptyText: 0, startedAt: Date.now() });

    let urls;
    try {
      urls = await loadUrls(property, signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        setRunning(false);
      }
      return;
    }

    const list = limit > 0 ? urls.slice(0, limit) : urls;
    const lastmodOf = new Map(list.map((e) => [e.url, e.lastmod]));
    const propertyOf = new Map(list.map((e) => [e.url, e.property]));
    const batches = chunk(list.map((e) => e.url), BATCH_SIZE);

    setProgress((p) => ({ ...p, total: list.length }));

    let cursor = 0;
    let stopped = false;

    const lanes = Array.from({ length: PARALLEL_BATCHES }, async () => {
      while (cursor < batches.length && !stopped && !signal.aborted) {
        const batch = batches[cursor++];
        let json;
        try {
          const res = await fetch('/api/scan', {
            method: 'POST',
            signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q, mode, scope, matchCase, concurrency: CONCURRENCY, urls: batch }),
          });
          json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Scan failed.');
        } catch (err) {
          if (err.name === 'AbortError') return;
          stopped = true;
          setError(err.message);
          return;
        }

        const enriched = json.results.map((r) => ({
          ...r,
          lastmod: lastmodOf.get(r.url) || null,
          property: propertyOf.get(r.url) || property,
        }));

        setResults((prev) => prev.concat(enriched));
        setProgress((p) => ({
          ...p,
          done: p.done + json.scanned,
          matched: p.matched + json.matched,
          failed: p.failed + json.failed,
          emptyText: p.emptyText + json.emptyText,
        }));
      }
    });

    await Promise.all(lanes);
    if (!signal.aborted) setRunning(false);
  }

  function insertChip(value) {
    const input = inputRef.current;
    if (!input) {
      setTerm((t) => t + value);
      return;
    }
    const start = input.selectionStart ?? term.length;
    const end = input.selectionEnd ?? term.length;
    const next = term.slice(0, start) + value + term.slice(end);
    setTerm(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + value.length, start + value.length);
    });
  }

  const sorted = useMemo(() => {
    const copy = [...results];
    if (sortBy === 'hits') copy.sort((a, b) => b.hits - a.hits);
    if (sortBy === 'newest') {
      copy.sort((a, b) => (Date.parse(b.lastmod || 0) || 0) - (Date.parse(a.lastmod || 0) || 0));
    }
    return copy;
  }, [results, sortBy]);

  const totalHits = useMemo(() => results.reduce((n, r) => n + r.hits, 0), [results]);

  async function copyUrls() {
    if (!sorted.length) return;
    await navigator.clipboard.writeText(sorted.map((r) => r.url).join('\n'));
    setCopied('all');
    setTimeout(() => setCopied(''), 1600);
  }

  function downloadCsv() {
    if (!sorted.length) return;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['url', 'title', 'property', 'matches', 'last_modified', 'context'],
      ...sorted.map((r) => [
        r.url,
        r.title,
        nameOf[r.property] || r.property,
        r.hits,
        r.lastmod ? r.lastmod.slice(0, 10) : '',
        r.plain,
      ]),
    ];
    const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `scan-${(ranQuery?.q || 'query').replace(/\W+/g, '-').slice(0, 30)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const elapsed = progress ? Math.round((Date.now() - progress.startedAt) / 1000) : 0;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <h1>Content search</h1>
          <p>Live &middot; no index, pages are read on demand</p>
        </div>
        <div className="rail-heading">Property</div>
        <ul className="property-list">
          {PROPERTIES.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={property === p.id}
                onClick={() => setProperty(p.id)}
              >
                <span>{p.name}</span>
                <span className="count">
                  {counts[p.id] !== undefined ? counts[p.id].toLocaleString() : '\u2014'}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-pressed={property === 'all'}
              onClick={() => setProperty('all')}
            >
              <span>All properties</span>
              <span className="count">
                {counts.all !== undefined ? counts.all.toLocaleString() : 'slow'}
              </span>
            </button>
          </li>
        </ul>
        <p className="rail-note">
          Counts come straight from each property&rsquo;s sitemaps, refreshed every 30
          minutes.
        </p>
      </aside>

      <main className="main">
        <form className="searchbar" onSubmit={run}>
          <div className="field">
            <input
              ref={inputRef}
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Any text, down to a single character"
              aria-label="Search text"
              autoFocus
            />
            {running ? (
              <button type="button" className="stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit">Search</button>
            )}
          </div>

          <div className="chips">
            <span className="chips-label">Insert</span>
            {CHIPS.map((c) => (
              <button
                key={c.label}
                type="button"
                className="chip"
                title={`Insert ${c.label}`}
                onClick={() => insertChip(c.value)}
              >
                {c.label === 'nbsp' ? '\u2423' : c.value}
                <span>{c.label}</span>
              </button>
            ))}
          </div>

          <select
            className="mobile-picker"
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            aria-label="Property"
          >
            {PROPERTIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="all">All properties</option>
          </select>

          <div className="controls">
            <div className="modes">
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'exact'}
                  onChange={() => setMode('exact')}
                />
                Exact text
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'words'}
                  onChange={() => setMode('words')}
                />
                All words
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'regex'}
                  onChange={() => setMode('regex')}
                />
                Regex
              </label>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              Match case
            </label>
            <button
              type="button"
              className="linkish"
              onClick={() => setShowOptions((s) => !s)}
            >
              {showOptions ? 'Hide options' : 'Options'}
            </button>
            {results.length > 0 && (
              <>
                <button type="button" className="linkish" onClick={copyUrls}>
                  {copied === 'all' ? 'URLs copied' : 'Copy URLs'}
                </button>
                <button type="button" className="linkish" onClick={downloadCsv}>
                  Download CSV
                </button>
              </>
            )}
          </div>

          {showOptions && (
            <div className="opts">
              <label>
                Look in
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="content">Article text</option>
                  <option value="page">Whole page text</option>
                  <option value="html">Raw HTML source</option>
                </select>
              </label>
              <label>
                Stop after
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  <option value={0}>Every URL</option>
                  <option value={100}>100 URLs</option>
                  <option value={500}>500 URLs</option>
                  <option value={2000}>2,000 URLs</option>
                </select>
              </label>
              <label>
                Sort by
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="hits">Most matches</option>
                  <option value="newest">Newest first</option>
                  <option value="found">Order found</option>
                </select>
              </label>
            </div>
          )}
        </form>

        {progress && (
          <div className="progress" aria-live="polite">
            <div className="bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              <span>
                <strong>{progress.done.toLocaleString()}</strong> of{' '}
                {progress.total.toLocaleString()} pages read
              </span>
              <span>
                <strong>{results.length.toLocaleString()}</strong>{' '}
                {results.length === 1 ? 'page' : 'pages'} matched
              </span>
              <span>{totalHits.toLocaleString()} occurrences</span>
              {progress.failed > 0 && <span>{progress.failed} failed</span>}
              <span>{elapsed}s</span>
              {!running && progress.done > 0 && <span>done</span>}
            </div>
          </div>
        )}

        {error && <p className="notice">{error}</p>}

        {ranQuery && (
          <p className="status">
            Searching for <code>{describeChars(ranQuery.q)}</code> as{' '}
            {ranQuery.mode === 'exact'
              ? 'exact text'
              : ranQuery.mode === 'words'
                ? 'all words'
                : 'a regular expression'}
            , {ranQuery.matchCase ? 'case sensitive' : 'case insensitive'}, in{' '}
            {ranQuery.scope === 'content'
              ? 'article text'
              : ranQuery.scope === 'page'
                ? 'whole page text'
                : 'raw HTML'}
            .
          </p>
        )}

        {progress && !running && progress.emptyText > progress.done * 0.5 && progress.done > 0 && (
          <p className="notice">
            {progress.emptyText} of {progress.done} pages returned no text at all. That
            usually means the pages render their content in the browser, so a plain fetch
            sees an empty shell. Try the Raw HTML source scope, or check one URL with{' '}
            <code>/api/preview?url=&hellip;</code>.
          </p>
        )}

        {!ranQuery && (
          <div className="empty">
            <h2>Read the pages live, match the characters exactly</h2>
            <p>
              Nothing is indexed ahead of time. Each search pulls the property&rsquo;s
              sitemaps, splits the URLs into batches of {BATCH_SIZE}, and fetches{' '}
              {PARALLEL_BATCHES * CONCURRENCY} pages at a time. Results appear as batches
              land, and Stop halts it immediately.
            </p>
            <p>
              Because the match is literal, a single em dash, a non-breaking space or a
              stray double space is a valid search. Nothing is stemmed, lowercased or
              thrown away as a stopword.
            </p>
          </div>
        )}

        {ranQuery && !running && results.length === 0 && progress?.done > 0 && (
          <div className="empty">
            <h2>Nothing matched</h2>
            <p>
              {progress.done.toLocaleString()} pages read, no occurrence found. Try the
              whole page or raw HTML scope, or switch off Match case.
            </p>
          </div>
        )}

        <ul className="results">
          {sorted.map((r) => (
            <li className="result" key={r.url}>
              <div className="hitcount">
                {r.hits}
                <span>{r.hits === 1 ? 'match' : 'matches'}</span>
              </div>
              <div>
                <h3>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                </h3>
                <a className="url" href={r.url} target="_blank" rel="noreferrer">
                  {r.url}
                </a>
                {r.snippets.map((html, i) => (
                  <div
                    className="snippet"
                    key={i}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ))}
                <div className="meta">
                  <span>{nameOf[r.property] || r.property}</span>
                  {r.lastmod && <span>Updated {r.lastmod.slice(0, 10)}</span>}
                  <button
                    type="button"
                    className="linkish"
                    onClick={async () => {
                      await navigator.clipboard.writeText(r.url);
                      setCopied(r.url);
                      setTimeout(() => setCopied(''), 1600);
                    }}
                  >
                    {copied === r.url ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

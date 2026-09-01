// app/page.jsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { PROPERTIES } from '../lib/properties.js';

const PER_PAGE = 20;

export default function Page() {
  const [property, setProperty] = useState('all');
  const [mode, setMode] = useState('exact');
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!submitted) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      q: submitted.q,
      property: submitted.property,
      mode: submitted.mode,
      page: String(page),
      perPage: String(PER_PAGE),
    });
    fetch(`/api/search?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || 'Search failed.');
        return json;
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError(err.message);
        setData(null);
        setLoading(false);
      });
    return () => controller.abort();
  }, [submitted, page]);

  function runSearch(event) {
    event?.preventDefault();
    const q = term.trim();
    if (q.length < 2) {
      setError('Type at least 2 characters to search.');
      return;
    }
    setPage(1);
    setSubmitted({ q, property, mode });
  }

  function pickProperty(id) {
    setProperty(id);
    if (submitted) {
      setPage(1);
      setSubmitted({ ...submitted, property: id });
    }
  }

  function pickMode(next) {
    setMode(next);
    if (submitted) {
      setPage(1);
      setSubmitted({ ...submitted, mode: next });
    }
  }

  async function copyUrls() {
    if (!data?.results?.length) return;
    await navigator.clipboard.writeText(data.results.map((r) => r.url).join('\n'));
    setCopied('all');
    setTimeout(() => setCopied(''), 1600);
  }

  function downloadCsv() {
    if (!data?.results?.length) return;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['url', 'title', 'property', 'matches', 'last_modified'],
      ...data.results.map((r) => [
        r.url,
        r.title,
        r.property,
        r.hits ?? '',
        r.lastmod ? r.lastmod.slice(0, 10) : '',
      ]),
    ];
    const csv = rows.map((row) => row.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `search-${data.query.replace(/\W+/g, '-').slice(0, 40)}-p${data.page}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const totalIndexed = stats?.totals?.withText ?? null;
  const nameOf = useMemo(
    () => Object.fromEntries(PROPERTIES.map((p) => [p.id, p.name])),
    []
  );

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <h1>Content search</h1>
          <p>
            {totalIndexed === null
              ? 'Loading index…'
              : `${totalIndexed.toLocaleString()} pages indexed`}
          </p>
        </div>
        <div className="rail-heading">Property</div>
        <ul className="property-list">
          <li>
            <button
              type="button"
              aria-pressed={property === 'all'}
              onClick={() => pickProperty('all')}
            >
              <span>All properties</span>
              <span className="count">
                {stats ? stats.totals.withText.toLocaleString() : '—'}
              </span>
            </button>
          </li>
          {PROPERTIES.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={property === p.id}
                onClick={() => pickProperty(p.id)}
              >
                <span>{p.name}</span>
                <span className="count">
                  {stats?.byProperty?.[p.id]?.withText?.toLocaleString() ?? '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <form className="searchbar" onSubmit={runSearch}>
          <div className="field">
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search any word, phrase or sentence"
              aria-label="Search text"
              autoFocus
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Searching…' : 'Search'}
            </button>
          </div>

          <select
            className="mobile-picker"
            value={property}
            onChange={(e) => pickProperty(e.target.value)}
            aria-label="Property"
          >
            <option value="all">All properties</option>
            {PROPERTIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="controls">
            <div className="modes">
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'exact'}
                  onChange={() => pickMode('exact')}
                />
                Exact phrase
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'words'}
                  onChange={() => pickMode('words')}
                />
                Any words
              </label>
            </div>
            {data?.results?.length > 0 && (
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
        </form>

        {error && <p className="notice">{error}</p>}

        {!submitted && !error && (
          <div className="empty">
            <h2>Find the page that contains a line of text</h2>
            <p>
              Pick a property on the left, type the words you are looking for, and every
              matching page comes back with the exact sentence it appears in.
            </p>
            <p>
              Exact phrase matches the words in order, exactly as typed. Any words finds
              pages containing all the words anywhere on the page.
            </p>
          </div>
        )}

        {data && !loading && (
          <p className="status">
            <strong>{data.total.toLocaleString()}</strong>{' '}
            {data.total === 1 ? 'page' : 'pages'} contain “{data.query}” in{' '}
            {data.property === 'all' ? 'all properties' : nameOf[data.property]} ·{' '}
            {data.tookMs} ms
            {data.scanned && ' · full scan, no index match for this string'}
          </p>
        )}

        {data && data.results.length === 0 && !loading && (
          <div className="empty">
            <h2>Nothing matched</h2>
            <p>
              Try switching to Any words, shortening the phrase, or widening the search to
              all properties.
            </p>
          </div>
        )}

        <ul className="results">
          {data?.results.map((r) => (
            <li className="result" key={r.url}>
              <div className="hitcount">
                {r.hits ? (
                  <>
                    {r.hits}
                    <span>{r.hits === 1 ? 'match' : 'matches'}</span>
                  </>
                ) : null}
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
                <div
                  className="snippet"
                  dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
                />
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

        {data && data.totalPages > 1 && (
          <div className="pager">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {data.page} of {data.totalPages.toLocaleString()}
            </span>
            <button
              type="button"
              disabled={page >= data.totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

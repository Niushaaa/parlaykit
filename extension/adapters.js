// Site adapters: each one knows how to find the prediction markets a user can SEE on a venue's page.
// They return event slugs; the quoter resolves slugs to markets, conditionIds and live prices.
// Adding a venue = adding an adapter here + a source in quoter/src/sources/.

const slugFromHref = (href) => {
  const m = String(href || '').match(/\/event\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

globalThis.PK_ADAPTERS = [
  {
    id: 'polymarket',
    venue: 'polymarket',
    label: 'Polymarket',
    match: () => /(^|\.)polymarket\.com$/.test(location.hostname),
    // Event page (/event/<slug>) -> that event first; plus every event linked on screen
    // (home feed, category pages, sports slates) so cross-event parlays are one click away.
    currentSlug: () => slugFromHref(location.pathname),
    visibleSlugs: () =>
      uniq(
        [...document.querySelectorAll('a[href*="/event/"]')]
          .filter((a) => {
            const r = a.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((a) => slugFromHref(a.getAttribute('href')))
      ).slice(0, 24),
  },
  {
    // Local demo venue (demo/index.html) — fictional markets served by the quoter in DEMO mode.
    id: 'demo',
    venue: 'demo',
    label: 'Demo venue',
    match: () =>
      ['127.0.0.1', 'localhost'].includes(location.hostname) && !!document.querySelector('meta[name="parlaykit-demo"]'),
    currentSlug: () => (location.hash.match(/#\/event\/([^/?#]+)/) || [])[1] || null,
    visibleSlugs: () => uniq([...document.querySelectorAll('[data-event-slug]')].map((el) => el.dataset.eventSlug)),
  },
];

globalThis.PK_pickAdapter = () => globalThis.PK_ADAPTERS.find((a) => a.match()) || null;

// Stand-in ad creative for the fixture page. The host is mapped to the fixture
// server, so a real ad request never leaves the machine; the anti-ad preset
// blocks this file like it would block any ad script.
const styles = document.createElement("style");
styles.textContent = `
  .ad {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 16px;
    border: 2px dashed #c98600;
    border-radius: 12px;
    color: #2c1c00;
    background: repeating-linear-gradient(135deg, #fff6cd 0 16px, #ffeaa6 16px 32px);
    font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  }
  .ad .badge {
    flex: none;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #fff;
    background: #b4532a;
    border-radius: 4px;
    padding: 3px 6px;
  }
  .ad .copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .ad .headline {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .ad .sub {
    font-size: 12px;
    line-height: 1.35;
    color: #6b4a00;
  }
  .ad .cta {
    flex: none;
    margin-left: auto;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    background: #b4532a;
    border-radius: 999px;
    padding: 7px 14px;
    white-space: nowrap;
  }
  .ad[data-kind="sidebar"] {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 16px;
    min-height: 172px;
    justify-content: center;
  }
  .ad[data-kind="sidebar"] .headline {
    font-size: 18px;
  }
  .ad[data-kind="sidebar"] .cta {
    margin: 2px 0 0;
  }
`;
document.head.append(styles);

const copy = {
  leaderboard: {
    headline: "Upgrade your boat today",
    sub: "Harbor Marine · End-of-season deals on outboards, covers and mooring gear.",
    cta: "Shop the sale",
  },
  infeed: {
    headline: "Your dock deserves a lift",
    sub: "TideLine Lifts · Fitted in a weekend, keeps the hull dry all winter.",
    cta: "Get a quote",
  },
  sidebar: {
    headline: "Warm the whole house",
    sub: "Northwind Stoves · Pellet stoves from $1,290. Free delivery within 30 miles.",
    cta: "Book a demo",
  },
};

// Each slot is filled once, and only if nothing else got there first.
for (const slot of document.querySelectorAll(".ad-slot")) {
  if (slot.children.length) continue;
  const kind = slot.dataset.ad ?? "leaderboard";
  const entry = copy[kind] ?? copy.leaderboard;
  const ad = document.createElement("div");
  ad.className = "ad";
  ad.dataset.kind = kind;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "Sponsored";
  const text = document.createElement("span");
  text.className = "copy";
  const headline = document.createElement("span");
  headline.className = "headline";
  headline.textContent = entry.headline;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = entry.sub;
  text.append(headline, sub);
  const cta = document.createElement("a");
  cta.className = "cta";
  cta.href = "#";
  cta.textContent = entry.cta;
  ad.append(badge, text, cta);
  slot.append(ad);
}

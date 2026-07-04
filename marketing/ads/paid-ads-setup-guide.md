# Capiro Paid Acquisition: Setup Guide

Covers exact configuration for LinkedIn Ads and Google Search Ads, plus the outreach process for trade newsletter sponsorships (Politico, Punchbowl, Axios).

## Before you spend anything

1. Install tracking site-wide: the **LinkedIn Insight Tag** and a **Google Tag** (via Google Tag Manager, ideally) on every page of capiro.ai. Without this, neither platform can measure conversions or build a retargeting audience.
2. Define one conversion event both platforms will track: a demo request submission. Fire it off the `formSuccess` state shown after `submitDemo()` completes (see `index.html`), or off HubSpot's own form-submission webhook via GTM.
3. Have at least one landing page ready that matches ad intent before turning ads on — sending competitor-alternative traffic to the generic homepage will convert far worse than sending it to a page built for that intent (the `/vs/quorum` brief already written covers this).

## 1. LinkedIn Ads

### Account setup
- Create a Campaign Manager account at business.linkedin.com/marketing-solutions, linked to Capiro's LinkedIn Company Page.
- Install the Insight Tag (Campaign Manager → Account Assets → Insight Tag) on every page.
- Create a conversion action in Campaign Manager (Account Assets → Conversion Tracking) for "Demo Request Submitted."

### Build the audience — this is the most important step given how small this market is
- **Matched Audiences — Company List:** compile a CSV of actual target accounts (lobbying firms, corporate government affairs departments, trade associations). LinkedIn requires a minimum of 300 matched companies to activate a campaign; aim for 1,000+ for a workable match rate and reach. Only "Company Website" is a required column, but adding company name improves matching. Upload under Account Assets → Matched Audiences → Company List.
- **Layer targeting on top of the list** inside the campaign: Job Function (Government Relations, Public Policy, Legal), specific titles (Government Affairs Director/VP, Government Relations Manager, Lobbyist, Chief of Staff, Public Affairs Manager), Seniority (Manager, Director, VP, CXO — exclude entry-level to control cost), Location (wherever Capiro sells).
- **Build a second, broader audience** without the company list — Job Function + Industry only — for top-of-funnel awareness. This exists because the company-list audience alone won't have enough reach for a real awareness push; treat it as a separate campaign with separate creative.
- **Build a Website Retargeting audience** off the Insight Tag: all visitors, last 90 days.

### Campaign structure
Set up one Campaign Group ("Capiro Acquisition") with three campaigns:

| Campaign | Audience | Objective | Format |
|---|---|---|---|
| ABM Precision | Company list + job title/seniority | Website Conversions or Lead Gen Form | Single Image Ad or Lead Gen Form |
| Category Awareness | Job function + industry, no company list | Engagement / Video Views | Single Image or Document Ad, thought-leadership style |
| Retargeting | Website visitors (Insight Tag) | Conversions | Single Image Ad |

Put the majority of budget on ABM Precision — it's the highest-relevance segment and should perform best.

### Bidding & budget
- Start with **manual bidding**, not Maximize Delivery. Set a CPC bid cap around $12–18 to control cost at Director/VP seniority (LinkedIn B2B CPCs commonly run $8–20+, with VP+ targeting running 3–5x IC-level rates). Move to Cost Cap or Maximize Conversions once you have roughly 50 conversions of data.
- LinkedIn's minimum is $10/day per campaign. With three campaigns running, budget at least $50–75/day ($1,500–2,250/mo) as a floor to get usable data across all three.
- Because the account-list audience is inherently small, expect limited weekly reach on the ABM campaign — that's expected. It's meant to run always-on and patiently, not to scale like a broad-audience campaign.

### Creative specs
- Single Image Ad: 1200×628px (1.91:1) recommended; headline ≤70 characters; intro text truncates around 70 characters on mobile and 150 on desktop, so front-load the key message.
- Lead Gen Forms auto-pull the viewer's LinkedIn profile data (name, email, company, title) — ask for no more than 3–4 fields to keep conversion high, but note these leads tend to be lower-intent than a full website form fill; worth testing both against a direct website-conversion campaign.

### Tracking and cadence
- UTM-tag every ad (`utm_source=linkedin&utm_medium=paid-social&utm_campaign=...&utm_content=...`).
- Review weekly: CTR (B2B LinkedIn benchmark is roughly 0.4–0.65%), cost per lead, and frequency. Given the small audience, expect ad fatigue faster than usual — refresh creative every 2–3 weeks, especially on the ABM campaign.

## 2. Google Search Ads

### Account setup
- Create a Google Ads account, link Google Analytics 4, and import the "Demo Request" conversion event (or set a Google Tag conversion directly on the form-success state).

### Campaign structure — narrow, themed ad groups, not broad match
**Campaign: Capiro — Category**
- Ad group "Government Affairs Software": government affairs software, government affairs platform, government relations software
- Ad group "Legislative Tracking": legislative tracking software, bill tracking software, AI legislative tracking
- Ad group "Lobbying Software": lobbying software, lobbying CRM, lobbying management software

**Campaign: Capiro — Competitor Alternatives**
- Ad group "Quorum": quorum alternative, quorum competitors, quorum vs
- Ad group "FiscalNote": fiscalnote alternative, fiscalnote competitors

Use **Phrase and Exact match only** — skip Broad match. Given how little search volume exists for these terms, Broad match will mostly buy irrelevant traffic rather than unlock meaningful new volume.

Add negative keywords account-wide: free, jobs, salary, internship, course, certification, "what is", definition, wikipedia, reddit.

**Note on using competitor names:** bidding on competitor terms as keywords is fine under Google's policy — keywords aren't restricted. Putting a competitor's trademarked name directly into ad headline/description text is a different matter: it's allowed unless the trademark owner files a complaint against your account, at which point Google enforces against you specifically. Since this is a real (if avoidable) legal risk, default to describing the switch without naming the competitor in ad copy itself ("Switching from a legacy legislative tracker?") and get legal sign-off before ever putting "Quorum" or "FiscalNote" in the visible ad text.

### Landing pages
- Category ad groups → homepage or a dedicated platform page.
- Competitor ad groups → the `/vs/quorum` page specifically — don't send switcher-intent traffic to the homepage.

### Ad copy
Responsive Search Ads, up to 15 headlines / 4 descriptions:
- 2–3 headlines with the primary keyword.
- A differentiator headline ("AI Chief of Staff for Gov Affairs," "Meri Drafts Your Outreach," "Measured by Outcomes").
- A CTA headline ("Book a Demo Today").
- Extensions: Sitelinks (Platform, Pricing, Insights, Book a Demo), Callouts ("AI-Powered," "Built for Gov Affairs," "Free Demo"), Structured Snippets (Services: Legislative Tracking, Outreach Drafting, Client Management).

### Bidding & budget
- Start with **Manual CPC or Maximize Clicks with a budget cap** — Target CPA/Maximize Conversions bidding needs roughly 30 conversions in its lookback window to work well, which will take time to accumulate in a niche category.
- Given how low volume is on these specific terms, the real risk is under-spending, not overspending. $30–50/day ($900–1,500/mo) is likely enough to capture available impression volume; check Search Impression Share Lost (Budget) and raise budget only if you're actually losing share.

### Ongoing
- Review the Search Terms report weekly for the first month and add negatives for anything irrelevant.
- Once you have 15–20 conversions, test Target CPA bidding on the Category campaign (higher volume than the Competitor campaign).

## 3. Trade Newsletter Sponsorships (Politico, Punchbowl, Axios)

This is a direct sales relationship, not a self-serve platform — there's no dashboard to configure. The process is: identify the right newsletter, request the media kit, negotiate a small test, and hand off tracked creative.

1. **Pick the specific newsletter, not just the publisher** — these outlets run dozens of vertical editions:
   - **Politico**: "Influence" is Politico's newsletter specifically about lobbying and government affairs — the tightest fit if they'll sell into it. "Playbook" is the larger-reach, broader-DC fallback.
   - **Punchbowl News**: no lobbying-specific edition, but the flagship AM/PM newsletters reach "every corner of Washington," including lobbyists and Hill staff — that's the right ask.
   - **Axios**: organized by beat; ask specifically whether a policy/government-affairs edition exists, or default to a DC-focused newsletter.
2. **Contact directly:**
   - Politico: advertise@politico.com
   - Punchbowl News: via the "Become a Sponsor" page at punchbowl.news/become-a-sponsor
   - Axios: via axios.com/advertise
3. **Ask for:** the media kit for that specific newsletter (subscriber count and role/seniority breakdown, not just publisher-wide numbers), available formats (native text block, "presented by" logo, dedicated send), rates, minimum commitment length, and lead time — these are typically booked 4–8 weeks out.
4. **Negotiate a test first** — a single week or two-week run — before a monthly or quarterly commitment. Ask if they'll share anonymized open/click benchmarks from a comparable B2B tech or legal-vertical sponsor; Axios newsletters reportedly run around 40% open rates, which sets a rough expectation.
5. **Write it like editorial content, not a banner ad.** Typical format is 50–100 words: one hook, one differentiator (Meri, the AI Chief of Staff), one CTA. This audience reads a lot of sponsor content and tunes out anything that reads like generic SaaS ad copy.
6. **Send to a dedicated, UTM-tagged landing page** (e.g. `capiro.ai/?utm_source=politico-influence`) since these publishers won't give you pixel-level tracking themselves.
7. **Budget expectation:** flagship-newsletter sponsorships in this space run into five figures per placement based on public reporting on this market's sponsorship spend. Treat this as a later-stage channel — worth approaching once LinkedIn and Google have validated messaging and you have a landing page and offer that's already converting, not as a first move.

## Suggested sequencing

1. Install Insight Tag + Google Tag and get the demo-conversion event firing correctly — verify before spending a dollar.
2. Launch the LinkedIn ABM campaign and the two Google campaigns together; both have low daily minimums and will surface signal fast.
3. Spend the first 4–6 weeks tightening messaging, landing pages, and creative based on what's actually converting.
4. Approach Politico Influence / Punchbowl once there's a proven landing page and offer, and budget set aside for a real commitment rather than a token test.

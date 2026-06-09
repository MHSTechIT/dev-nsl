const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel, BorderStyle,
  WidthType, ShadingType, PageNumber, PageBreak, TableOfContents, VerticalAlign,
} = require("docx");

// ---------- shared helpers ----------
const CONTENT_W = 9360; // US Letter, 1" margins
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const HEAD_FILL = "1F4E79";
const ALT_FILL = "EAF1F8";

function cell(text, { w, head = false, alt = false, bold = false, align } = {}) {
  const runs = Array.isArray(text)
    ? text
    : [new TextRun({ text: String(text), bold: head || bold, color: head ? "FFFFFF" : "000000" })];
  return new TableCell({
    borders,
    width: { size: w, type: WidthType.DXA },
    shading: { fill: head ? HEAD_FILL : alt ? ALT_FILL : "FFFFFF", type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: align, children: runs })],
  });
}

function table(widths, headerRow, dataRows) {
  const rows = [];
  rows.push(new TableRow({
    tableHeader: true,
    children: headerRow.map((t, i) => cell(t, { w: widths[i], head: true })),
  }));
  dataRows.forEach((r, idx) => {
    rows.push(new TableRow({
      children: r.map((t, i) => cell(t, { w: widths[i], alt: idx % 2 === 1 })),
    }));
  });
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, rows });
}

const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const P = (t, opts = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, ...opts })] });
const bullet = (t, level = 0) => new Paragraph({ numbering: { reference: "bul", level }, children: textRuns(t) });
const num = (t, ref = "ord") => new Paragraph({ numbering: { reference: ref, level: 0 }, children: textRuns(t) });

// supports **bold** segments inside a string
function textRuns(t) {
  const parts = String(t).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) =>
    p.startsWith("**") && p.endsWith("**")
      ? new TextRun({ text: p.slice(2, -2), bold: true })
      : new TextRun(p)
  );
}

function note(t) {
  return new Paragraph({
    spacing: { before: 60, after: 120 },
    shading: { fill: "FFF4CE", type: ShadingType.CLEAR },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: "E0A800", space: 8 } },
    children: [new TextRun({ text: "Note:  ", bold: true }), ...textRuns(t)],
  });
}

function styles() {
  return {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal",
        run: { size: 52, bold: true, color: "1F4E79", font: "Arial" },
        paragraph: { spacing: { after: 120 } } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, color: "1F4E79", font: "Arial" },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "1F4E79", space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, color: "2E5E8C", font: "Arial" },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 23, bold: true, color: "333333", font: "Arial" },
        paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2 } },
    ],
  };
}

function numbering() {
  return {
    config: [
      { reference: "bul", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 280 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 280 } } } },
      ] },
      { reference: "ord", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 280 } } } },
      ] },
    ],
  };
}

function buildDoc({ titleLines, subtitle, sections, productLabel }) {
  const cover = [
    new Paragraph({ spacing: { before: 2600 } }),
    new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "MSL CRM", size: 36, bold: true, color: "888888" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200 },
      children: titleLines.map((t, i) => new TextRun({ text: (i ? "\n" : "") + t, break: i ? 1 : 0, size: 56, bold: true, color: "1F4E79" })) }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200 },
      children: [new TextRun({ text: subtitle, size: 26, italics: true, color: "555555" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1600 },
      children: [new TextRun({ text: "User Guide", size: 30, bold: true, color: "2E5E8C" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 },
      children: [new TextRun({ text: "Document version 1.0", size: 20, color: "888888" })] }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Contents")] }),
    new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  return new Document({
    styles: styles(),
    numbering: numbering(),
    features: { updateFields: true },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 4 } },
        children: [new TextRun({ text: `MSL CRM  —  ${productLabel}`, size: 16, color: "999999" })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Page ", size: 16, color: "999999" }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "999999" }),
          new TextRun({ text: " of ", size: 16, color: "999999" }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: "999999" })] })] }) },
      children: [...cover, ...sections],
    }],
  });
}

// ============================================================
// SHARED CONTENT BLOCKS
// ============================================================
function loginSection(roleNote) {
  return [
    H1("2.  Logging In"),
    num("Open the CRM in your browser and go to the login screen."),
    num("Enter your **Username** and **Password**, then click sign in."),
    P("Access to data depends on your role:"),
    bullet("**Admin** – full access to all data and controls.", 1),
    bullet("**Manager** – access scoped to their department.", 1),
    bullet("**Team Leader** – sees only their own team’s leads and data.", 1),
    note(roleNote),
  ];
}

// ============================================================
// META GUIDE
// ============================================================
function metaSections() {
  const s = [];
  s.push(H1("1.  Overview"));
  s.push(P("The Meta Workspace is the part of the MSL CRM dedicated to traffic and leads that come from Meta (Facebook / Instagram) Ads. Its Marketing module lets you monitor how visitors move through the registration funnel — from the first ad click all the way to a WhatsApp group join — and pinpoint exactly where people drop off."));
  s.push(P("This guide covers the Marketing module for the Meta workspace, with a focus on the main Page Performance dashboard."));

  s.push(...loginSection("Your session stays active while the browser tab is open. Closing the tab logs you out."));

  s.push(H1("3.  Selecting the Meta Workspace"));
  s.push(num("In the left sidebar, find the workspace switcher at the top — it reads “Modules · [Workspace]”."));
  s.push(num("Make sure it is set to the **Meta** workspace (this is the default on login)."));
  s.push(num("Other workspaces (YT / Meta 2.0) show a reduced set of metrics. Only the **Meta** workspace shows the full Meta marketing data."));
  s.push(P("Available workspaces in the switcher:"));
  s.push(table([3120, 6240], ["Workspace label", "Purpose"], [
    ["Meta", "Meta (Facebook / Instagram) Ads traffic — the focus of this guide"],
    ["YT", "YouTube traffic (covered in the separate YT guide)"],
    ["Meta 2.0", "Meta 2.0 campaign variant"],
    ["Meta Temp", "Temporary Meta workspace (Funnel & Page Performance hidden)"],
  ]));

  s.push(H1("4.  Opening the Marketing Dashboard"));
  s.push(P("Inside the Meta workspace, the Marketing module has six tabs:"));
  s.push(table([2760, 6600], ["Tab", "What it does"], [
    ["Funnel", "Visual funnel from awareness to advocacy"],
    ["Page Performance", "The main marketing dashboard (this guide)"],
    ["Leads", "Full leads table with filters"],
    ["WhatsApp Links", "Manage the rotating WhatsApp group links"],
    ["Timer & Controls", "Configure funnel timers and controls"],
    ["Settings", "Webinar dates, kill switch and campaign settings"],
  ]));
  s.push(P("Click Page Performance to open the marketing dashboard.", { bold: true }));

  s.push(H1("5.  The Page Performance Dashboard"));
  s.push(P("Heading: Page Performance", { bold: true }));
  s.push(P("Subtitle: “Button click analytics across all funnel pages.”", { italics: true }));
  s.push(P("The dashboard has four areas: the Filter Bar, Per-Webinar Performance, Metric Tiles, and Drop-off Analysis."));

  s.push(H2("5.1  Filter Bar"));
  s.push(P("Date Range — choose one of:", { bold: true }));
  s.push(bullet("All Time"));
  s.push(bullet("Today"));
  s.push(bullet("This Week"));
  s.push(bullet("This Month"));
  s.push(bullet("Custom — pick a From and a To date"));
  s.push(P("Webinar — a dropdown that defaults to “All Webinars”. Select a specific session to see numbers for just that webinar.", { bold: false }));
  s.push(P("Controls:", { bold: true }));
  s.push(bullet("↻ Refresh — manually pull the latest numbers."));
  s.push(bullet("✕ Clear — appears when filters are active; resets everything."));
  s.push(bullet("A last-updated timestamp shows when the data was last refreshed."));
  s.push(note("The dashboard also auto-refreshes every 30 seconds, so the figures stay close to live."));

  s.push(H2("5.2  Per-Webinar Performance"));
  s.push(P("A section titled “Per-Webinar Performance” shows one row per webinar. When Meta Ads is connected, a blue “Meta linked” badge appears."));
  s.push(P("Each webinar row shows (Meta workspace):"));
  s.push(table([2600, 6760], ["Column", "Meaning"], [
    ["Meta Clicks", "Link clicks counted server-side from Meta — the most reliable figure (“From Meta — bulletproof”)"],
    ["Unique Visitors", "Distinct real people who landed on the page"],
    ["Page Views", "Total page loads"],
    ["Registrations", "Completed registrations (may show “N from Meta”)"],
    ["WhatsApp", "WhatsApp joins (may show “N from Meta”)"],
  ]));
  s.push(P("If there are more than three webinars, use “See all (N)” / “Show less” to expand or collapse the list."));

  s.push(H2("5.3  Metric Tiles"));
  s.push(P("A grid of tiles summarises the whole funnel for the current filters."));
  s.push(H3("Traffic metrics"));
  s.push(table([3000, 6360], ["Tile", "Meaning"], [
    ["Meta Link Clicks", "Server-side count from Meta; matches Ads Manager exactly"],
    ["Meta Visits (verified)", "Visits confirmed by the Meta click ID in the landing URL — bulletproof"],
    ["Meta Landing (Pixel)", "Pixel-based landing views; lossy on iOS / ad blockers, kept for reference"],
    ["Unique Visitors", "Real people, merged by phone number after registration"],
    ["Page Views", "Total page loads (one person can fire many)"],
  ]));
  s.push(H3("Conversion funnel metrics"));
  s.push(table([3000, 6360], ["Tile", "Meaning"], [
    ["Start Registration", "Clicked the main CTA button"],
    ["Sugar Level Selected", "Chose a sugar range (150–250 + 250+ mg/dL)"],
    ["No Diabetes", "Disqualified at the diabetes question"],
    ["Tamil: Yes", "Qualified on language"],
    ["Tamil: No", "Disqualified on language"],
    ["Registration Submitted", "Completed the registration form"],
    ["WhatsApp Join Clicked", "Opened the WhatsApp group link"],
    ["YouTube Clicked", "Opened the YouTube channel link"],
    ["Explore Products", "Opened the product page"],
  ]));
  s.push(note("On the YT / Meta 2.0 workspaces the three Meta-specific tiles are hidden, because that traffic does not pass through Meta Ads."));

  s.push(H2("5.4  Drop-off Analysis"));
  s.push(P("These boxes show where you are losing people between steps. Each shows a percentage plus a sub-line such as “N no action · M entered”."));
  s.push(bullet("**CTA → Sugar Page** — drop-off after the CTA click."));
  s.push(bullet("**Sugar → Tamil Page** — drop-off after the sugar-level step."));
  s.push(bullet("**Tamil → Registration** — drop-off after the language step."));
  s.push(bullet("**Registration → WhatsApp** — drop-off between registering and joining WhatsApp."));
  s.push(bullet("**Optin Rate** — Start Registration ÷ Page Views."));
  s.push(P("Colour guide for the drop-off percentage:", { bold: true }));
  s.push(table([2400, 6960], ["Colour", "Meaning"], [
    ["Green", "Under 25% — healthy"],
    ["Orange", "25%–50% — watch"],
    ["Red", "Over 50% — needs attention"],
  ]));

  s.push(H1("6.  Typical Workflows"));
  s.push(H3("Check today’s ad performance"));
  s.push(num("Open Page Performance."));
  s.push(num("Set Date Range to Today."));
  s.push(num("Read Meta Link Clicks and Meta Visits (verified) for traffic, then Registration Submitted and WhatsApp Join Clicked for conversions."));
  s.push(H3("Compare two webinars"));
  s.push(num("Use the Webinar dropdown to select one session and note the tiles."));
  s.push(num("Switch to the other session and compare — or scan the Per-Webinar Performance rows side by side."));
  s.push(H3("Find the weakest funnel step"));
  s.push(num("Set the Date Range to your campaign window."));
  s.push(num("Look at the Drop-off Analysis boxes and find the highest (reddest) percentage — that is your biggest leak."));

  s.push(H1("7.  Tips & Notes"));
  s.push(bullet("Trust the verified / server-side Meta numbers most. The Meta Landing (Pixel) tile undercounts on iOS and with ad blockers and is for reference only."));
  s.push(bullet("Unique Visitors vs Page Views: one person can create several page views, so Unique Visitors is the truer “people” figure."));
  s.push(bullet("If Meta numbers look missing or behind, they are fetched separately from the Meta API and may lag briefly — they do not block the rest of the dashboard."));
  s.push(bullet("Always confirm you are in the Meta workspace; YT / Meta 2.0 intentionally hide Meta-only metrics."));
  s.push(bullet("Use ↻ Refresh for an immediate update instead of waiting for the 30-second auto-refresh."));

  s.push(H1("8.  Quick Reference"));
  s.push(table([4560, 4800], ["You want to…", "Do this"], [
    ["See live ad clicks", "Meta Link Clicks tile"],
    ["See real visitor count", "Unique Visitors tile"],
    ["Filter by a single webinar", "Webinar dropdown"],
    ["Look at a date range", "Date Range pills / Custom"],
    ["Find where users quit", "Drop-off Analysis boxes"],
    ["Force latest data", "↻ Refresh"],
    ["Reset the view", "✕ Clear"],
  ]));
  return s;
}

// ============================================================
// YT GUIDE
// ============================================================
function ytSections() {
  const s = [];
  s.push(H1("1.  Overview"));
  s.push(P("The YT Workspace is the part of the MSL CRM dedicated to traffic and leads that come from YouTube. It has its own dedicated funnel app (the YT funnel) and its own view of the Marketing dashboard inside the CRM."));
  s.push(P("This guide covers two things: (1) the YT funnel — the landing and registration flow your YouTube visitors experience — and (2) the YT workspace Marketing dashboard, where you monitor that traffic."));
  s.push(note("The YT funnel is a separate build from the Meta funnel. Every lead and event it records is automatically tagged with the source “yt”, which is what keeps YouTube data cleanly separated from Meta in the CRM."));

  s.push(...loginSection("Your session stays active while the browser tab is open. Closing the tab logs you out."));

  s.push(H1("3.  Selecting the YT Workspace"));
  s.push(num("In the left sidebar, open the workspace switcher at the top (“Modules · [Workspace]”)."));
  s.push(num("Select **YT** from the list."));
  s.push(num("When you switch into YT, the CRM takes you straight to the Marketing module — this is by design."));
  s.push(P("Available workspaces in the switcher:"));
  s.push(table([3120, 6240], ["Workspace label", "Purpose"], [
    ["Meta", "Meta (Facebook / Instagram) Ads traffic"],
    ["YT", "YouTube traffic — the focus of this guide"],
    ["Meta 2.0", "Meta 2.0 campaign variant"],
    ["Meta Temp", "Temporary Meta workspace"],
  ]));
  s.push(note("In the YT workspace, the sidebar shows only the Marketing module. All work for YouTube traffic happens inside Marketing."));

  s.push(H1("4.  The YT Funnel (visitor flow)"));
  s.push(P("This is what a YouTube visitor sees after clicking your link. Knowing the steps helps you read the dashboard, because each step maps to a metric."));
  s.push(table([2400, 3000, 3960], ["Step", "Screen", "What happens"], [
    ["1", "Landing page", "Visitor arrives on the YT landing / splash screen and sees the main call-to-action."],
    ["2", "Registration", "Visitor fills in the registration form (name, contact details)."],
    ["3", "WhatsApp join", "After registering, the visitor is invited to open the WhatsApp group link."],
  ]));
  s.push(P("The YT funnel is intentionally short — it goes straight from the landing page to registration, then to the WhatsApp join. Every action along the way is recorded against the YT workspace."));
  s.push(note("Because all YT funnel traffic is tagged as source “yt”, it never mixes with Meta numbers — even though both share the same underlying leads table."));

  s.push(H1("5.  Opening the YT Marketing Dashboard"));
  s.push(P("Inside the YT workspace, the Marketing module shows the same six tabs as Meta:"));
  s.push(table([2760, 6600], ["Tab", "What it does"], [
    ["Funnel", "Visual funnel from awareness to advocacy"],
    ["Page Performance", "The main marketing dashboard (this guide)"],
    ["Leads", "Full leads table of YouTube registrations, with filters"],
    ["WhatsApp Links", "Manage the rotating WhatsApp group links"],
    ["Timer & Controls", "Configure funnel timers and controls"],
    ["Settings", "Webinar dates, kill switch and campaign settings"],
  ]));
  s.push(P("Click Page Performance to open the dashboard.", { bold: true }));

  s.push(H1("6.  The Page Performance Dashboard (YT)"));
  s.push(P("Heading: Page Performance", { bold: true }));
  s.push(P("Subtitle: “Button click analytics across all funnel pages.”", { italics: true }));
  s.push(P("The dashboard works the same way as the Meta one, but the Meta-only tiles are hidden because YouTube traffic does not pass through Meta Ads."));

  s.push(H2("6.1  Filter Bar"));
  s.push(P("Date Range — All Time, Today, This Week, This Month, or Custom (From / To dates)."));
  s.push(P("Webinar — dropdown defaulting to “All Webinars”; pick one to scope the numbers to a single session."));
  s.push(P("Controls — ↻ Refresh to pull the latest data, ✕ Clear to reset filters, plus a last-updated timestamp."));
  s.push(note("The dashboard auto-refreshes every 30 seconds."));

  s.push(H2("6.2  Per-Webinar Performance"));
  s.push(P("One row per webinar. On the YT workspace each row shows four columns (the Meta Clicks column is not shown):"));
  s.push(table([2600, 6760], ["Column", "Meaning"], [
    ["Unique Visitors", "Distinct real people who landed on the page"],
    ["Page Views", "Total page loads"],
    ["Registrations", "Completed registrations"],
    ["WhatsApp", "WhatsApp group joins"],
  ]));

  s.push(H2("6.3  Metric Tiles"));
  s.push(P("The YT dashboard shows these tiles. The three Meta tiles (Meta Link Clicks, Meta Visits, Meta Landing) are deliberately hidden."));
  s.push(H3("Traffic metrics"));
  s.push(table([3000, 6360], ["Tile", "Meaning"], [
    ["Unique Visitors", "Real people, merged by phone number after registration"],
    ["Page Views", "Total page loads (one person can fire many)"],
  ]));
  s.push(H3("Conversion funnel metrics"));
  s.push(table([3000, 6360], ["Tile", "Meaning"], [
    ["Start Registration", "Clicked the main CTA button"],
    ["Sugar Level Selected", "Chose a sugar range (150–250 + 250+ mg/dL)"],
    ["No Diabetes", "Disqualified at the diabetes question"],
    ["Tamil: Yes", "Qualified on language"],
    ["Tamil: No", "Disqualified on language"],
    ["Registration Submitted", "Completed the registration form"],
    ["WhatsApp Join Clicked", "Opened the WhatsApp group link"],
    ["YouTube Clicked", "Opened the YouTube channel link"],
    ["Explore Products", "Opened the product page"],
  ]));
  s.push(note("“YouTube Clicked” is shown on both the Meta and YT workspaces — it tracks anyone who opens the YouTube channel link, regardless of where they came in."));

  s.push(H2("6.4  Drop-off Analysis"));
  s.push(P("Same as the Meta dashboard — each box shows a percentage and a “N no action · M entered” sub-line:"));
  s.push(bullet("**CTA → Sugar Page**"));
  s.push(bullet("**Sugar → Tamil Page**"));
  s.push(bullet("**Tamil → Registration**"));
  s.push(bullet("**Registration → WhatsApp**"));
  s.push(bullet("**Optin Rate** — Start Registration ÷ Page Views."));
  s.push(P("Colour guide for the drop-off percentage:", { bold: true }));
  s.push(table([2400, 6960], ["Colour", "Meaning"], [
    ["Green", "Under 25% — healthy"],
    ["Orange", "25%–50% — watch"],
    ["Red", "Over 50% — needs attention"],
  ]));

  s.push(H1("7.  How YT Differs From Meta"));
  s.push(P("If you also use the Meta workspace, keep these differences in mind:"));
  s.push(table([3120, 3120, 3120], ["Aspect", "YT workspace", "Meta workspace"], [
    ["Traffic source", "YouTube (source “yt”)", "Meta Ads (source “meta”)"],
    ["Funnel app", "Dedicated YT funnel", "Meta funnel"],
    ["Meta tiles", "Hidden", "Shown"],
    ["Per-webinar columns", "4 (no Meta Clicks)", "5 (incl. Meta Clicks)"],
    ["YouTube Clicked tile", "Shown", "Shown"],
    ["Sidebar modules", "Marketing only", "Full module set"],
  ]));
  s.push(note("Because the YouTube funnel does not run through Meta Ads, any Meta-sourced figures are always zero for YT — which is why those tiles are hidden rather than shown as empty."));

  s.push(H1("8.  Typical Workflows"));
  s.push(H3("Check today’s YouTube performance"));
  s.push(num("Open Page Performance in the YT workspace."));
  s.push(num("Set Date Range to Today."));
  s.push(num("Read Unique Visitors and Page Views for traffic, then Registration Submitted and WhatsApp Join Clicked for conversions."));
  s.push(H3("Measure registration quality for a webinar"));
  s.push(num("Pick the session in the Webinar dropdown."));
  s.push(num("Compare Registrations against WhatsApp in the Per-Webinar Performance row."));
  s.push(H3("Find the weakest funnel step"));
  s.push(num("Set the Date Range to your campaign window."));
  s.push(num("Read the Drop-off Analysis boxes and address the highest (reddest) percentage first."));

  s.push(H1("9.  Tips & Notes"));
  s.push(bullet("Unique Visitors is the truer “people” count; Page Views can be inflated by a single person reloading."));
  s.push(bullet("Ignore the absence of Meta tiles — it is expected on YouTube traffic, not a fault."));
  s.push(bullet("Use the Webinar dropdown to keep numbers tied to a single session when reporting."));
  s.push(bullet("Use ↻ Refresh for an immediate update instead of waiting for the 30-second auto-refresh."));
  s.push(bullet("Always confirm the switcher reads “YT” before reading or reporting numbers."));

  s.push(H1("10.  Quick Reference"));
  s.push(table([4560, 4800], ["You want to…", "Do this"], [
    ["See real visitor count", "Unique Visitors tile"],
    ["See total registrations", "Registration Submitted tile"],
    ["See WhatsApp joins", "WhatsApp Join Clicked tile"],
    ["Filter by a single webinar", "Webinar dropdown"],
    ["Look at a date range", "Date Range pills / Custom"],
    ["Find where users quit", "Drop-off Analysis boxes"],
    ["Force latest data", "↻ Refresh"],
    ["Reset the view", "✕ Clear"],
  ]));
  return s;
}

// ---------- build & write ----------
async function write(name, doc) {
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(name, buf);
  console.log("wrote", name, buf.length, "bytes");
}

(async () => {
  await write("MSL-CRM-Meta-Workspace-Marketing-Dashboard-User-Guide.docx",
    buildDoc({
      titleLines: ["Meta Workspace", "Marketing Dashboard"],
      subtitle: "Meta (Facebook / Instagram) Ads — Page Performance",
      productLabel: "Meta Workspace Marketing Dashboard",
      sections: metaSections(),
    }));
  await write("MSL-CRM-YT-Funnel-and-Marketing-Dashboard-User-Guide.docx",
    buildDoc({
      titleLines: ["YT Funnel &", "Marketing Dashboard"],
      subtitle: "YouTube Traffic — Funnel & Page Performance",
      productLabel: "YT Funnel & Marketing Dashboard",
      sections: ytSections(),
    }));
})();

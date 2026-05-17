# MHS CRM — How Calling and Post-Call Forms Work

A plain-English guide to what happens when a caller dials a lead and fills out the form afterwards. No code, no jargon.

---

## Part 1 — The Calling Flow

### What happens when you click "Auto Call"

1. **You click the button** in the Assigned Leads page.
2. **The CRM sends a request to Tata Smartflo** asking it to start a click-to-call.
3. **Tata rings your phone first.** Your mobile rings as a normal incoming call.
4. **You pick up.**
5. **Tata then rings the customer's phone.** The customer hears the call from your DID number.
6. **The customer picks up.** You're now connected — talk normally.
7. **One of you hangs up.** Tata sends the recording back to the CRM automatically.

### Who knows what during the call

| Step | What the CRM knows | What Tata knows |
|---|---|---|
| You click Auto Call | "Caller X wants to dial lead Y" | nothing yet |
| Request sent to Tata | "Call started" (status = `initiated`) | "OK, dialing agent" |
| Your phone rings | still `initiated` | "Ringing agent's mobile" |
| You pick up | updates to `ringing` (customer leg starting) | "Agent answered, dialing customer" |
| Customer picks up | updates to `answered` | "Bridge complete, two-way audio" |
| Call ends | updates to `ended`, duration saved | sends final webhook with recording |
| Recording arrives | recording is downloaded and stored | done |

### What can go wrong

| Symptom | Most likely cause |
|---|---|
| Your phone never rings | Wrong agent number / API key blacklisted / agent extension not configured in Tata |
| Your phone rings but feels like "no network" after you answer | Tata can't bridge to customer — usually a wrong outbound CLI (DID), or the agent number we sent doesn't have an outbound campaign attached |
| Customer phone never rings | Same as above — bridge fails silently |
| Call connects but no recording | Webhook URL in Smartflo dashboard isn't pointing to the CRM backend, or recording feature is disabled on the plan |
| Status stuck on "initiated" forever | Tata accepted the request but didn't actually originate the bridge (the call is in queue limbo) |

### Where each piece of caller info comes from

| Setting | What it does | Where to set it |
|---|---|---|
| **Account Type** | Tells the CRM which Tata API key to use (per-account override) | Admin → Users → Smartflo Settings |
| **Extension** | Smartflo's internal ID for this agent | Admin → Users → Smartflo Settings |
| **Agent Number** | The agent's real mobile (e.g. `918754689554`) — Tata rings this | Admin → Users → Smartflo Settings |
| **Caller ID** | The DID number the customer sees as the incoming caller | Admin → Users → Smartflo Settings |
| **API Key** | Optional per-agent override key (rare — most use the global key) | Admin → Users → Smartflo Settings |

### Key rule for the Agent Number field

The CRM tries values in this order when deciding which number to give Tata:

1. **Agent Number** (mobile) — if filled, this wins
2. **Phone** (caller's profile phone) — fallback
3. **Extension** — last resort

**Best practice:** always fill the Agent Number field with the agent's real 12-digit mobile (e.g. `918754689554`). That's the only value Tata can reliably ring and bridge with.

---

## Part 2 — Inbound Calls (when a customer dials your DID)

1. Customer dials your Caller-ID (DID) number.
2. Tata receives the call and asks the CRM: "Who owns this DID — which agent should I route this to?"
3. The CRM looks up the matching agent and tells Tata.
4. Tata rings the agent's phone.
5. Agent picks up → connected.
6. Recording webhook arrives the same way as outbound calls.

This whole flow runs through the same webhook endpoints — only the direction is different.

---

## Part 3 — Recordings

- After every call ends, Tata sends a webhook with the recording URL.
- The CRM downloads the audio file in the background and saves it locally.
- This way the recording link **never expires** — Tata's hosted URLs can expire after a few days, but our local copy stays forever.
- You can play it back from the lead's call history. The CRM streams the local file through an authenticated proxy so the browser doesn't need to know the Smartflo credentials.

---

## Part 4 — The Post-Call Form

When a call ends (or you hit "Complete Call"), a form pops up so you can log what happened.

### The 5 outcomes

| Outcome | When to use it | What it does to the lead |
|---|---|---|
| **Completed** | Customer enrolled / paid | Marks lead as won. Removes from queue. |
| **Follow-up** | They want a callback later | Lead reappears at the scheduled callback time |
| **Not interested** | They said no permanently | Removed from active rotation |
| **DNP (Did Not Pick)** | Customer didn't answer | Goes to auto-recall queue |
| **Ringing No Answer** | One-time miss | Lead returns to queue without penalty |

### Other fields you fill in

| Field | Required when | Notes |
|---|---|---|
| **Sugar confirmation** | outcome = Completed | "Same as before" or "Different" |
| **Confirmed range** | outcome = Completed | 250+ / 200-250 / 100-200 / no diabetes |
| **Lead tag** | always (auto-set on DNP) | HOT / WARM / COLD / JUNK |
| **Callback time** | outcome = Follow-up | When to call back |
| **Notes** | optional | Free text up to 1000 chars |
| **DNP reason** | outcome = DNP | No answer / Switched off / Wrong number / Not in service |

### What happens when you hit Save

1. The form sends all the info to the backend.
2. The backend updates the lead's record — outcome, tag, follow-up time, etc.
3. A **celebration overlay** appears for 5 seconds:
   - Confetti animation
   - Mascot does a happy dance
   - Tag-specific motivational message in a speech bubble
   - Tag-specific cheer audio (HOT / WARM / COLD / JUNK each have their own clip)
4. After 5 seconds the form closes and the **next lead loads automatically**.

### The reason cards (when calls go wrong)

If the call doesn't reach the "talk to customer" stage, a small reason card appears before the full form:

- **Agent reason card** — shown if you press DNP while the customer is still ringing. No timer. Pick a reason.
- **Form reason card** — shown after a call ended cleanly. Has a 5-second timer that auto-advances.

These exist so the right outcome can be inferred without making you fill the whole form for a 2-second misdial.

---

## Part 5 — The Mascot

The little robot in the bottom-right corner has three moods:

| Mood | When you see it |
|---|---|
| **Idle** | Default state — between calls |
| **Thinking** | While the call is dialing or waiting for the customer to pick up |
| **Happy** | After you submit a Completed outcome — dances for 5 seconds, then back to idle |

There's also a **welcome popup** when you log in — a happy robot with a motivational Tanglish message. Appears once per session.

---

## Part 6 — Activity Log

Every caller's activity is tracked in the background. Admins can click the Status pill in the Sales Performance grid to see a timeline:

| Tag | Meaning |
|---|---|
| **Logged In** | First sign of activity in a fresh session |
| **Active** | Working, between calls |
| **On Call** | Currently in a call (shows lead name + duration) |
| **Break** | On a break (with timer) |
| **Break Over** | Break exceeded the allotted time |
| **Resumed** | Returned from break |
| **Idle** | Heartbeat alive but no activity |
| **Paused by Admin** | Admin disabled the agent |
| **Unpaused by Admin** | Admin re-enabled the agent |
| **Paused by Smartflow** | Auto-pause when agent retries hit the cap |
| **Offline** | No heartbeat for over 90 seconds |

Each row shows start time, end time, and duration. Ongoing entries tick live until they end.

---

## Part 7 — Quick troubleshooting

When something doesn't work, check in this order:

1. **Is the API key still valid?**
   The Smartflo admin can rotate it. If it's blacklisted, every call fails or queues without bridging. Generate a fresh key in the Smartflo dashboard and paste it into `backend/.env`.

2. **Is the Agent Number field filled in for the affected caller?**
   Empty → CRM falls back to less reliable values (phone, then extension). Extension-based dialing often doesn't bridge.

3. **Is the Caller ID (DID) approved for outbound use?**
   The DID has to be whitelisted in Smartflo for outbound CLI presentation. Inbound-only DIDs will be rejected.

4. **Is the webhook URL in the Smartflo dashboard pointing to the right backend?**
   If wrong / blank, the CRM never learns the call's real status — rows freeze on `initiated`.

5. **Is `TATA_TELE_WEBHOOK_SECRET` set?**
   If set in our `.env` but Smartflo isn't signing webhooks with the same secret, we silently reject everything. Easiest fix: clear the env var to make verification permissive.

6. **Is the customer's number valid?**
   Tata returns "Call missed by agent" or "Originate failed" for invalid / unreachable numbers.

---

## Part 8 — One-page summary

```
┌─────────────────────────────────────────────────────────────────┐
│              ONE-LINE SUMMARY OF THE WHOLE FLOW                 │
└─────────────────────────────────────────────────────────────────┘

  CALL OUT:
    Click Auto Call → CRM asks Tata → Tata rings YOUR phone →
    You pick up → Tata rings CUSTOMER → Customer picks up →
    You talk → Someone hangs up → Tata sends recording →
    CRM downloads it → Form pops up → You fill it →
    Celebration → Next lead.

  CALL IN:
    Customer dials your DID → Tata asks CRM who to route to →
    CRM names the matching agent → Tata rings them →
    They answer → Same recording + form flow as outbound.

  WHAT MAKES IT WORK:
    1. Valid Tata API key
    2. Agent Number (mobile) filled for each caller
    3. Caller ID DID approved for outbound presentation
    4. Webhook URL registered in Smartflo dashboard
    5. Phone numbers in correct format (12 digits, 91-prefixed)
```

import type { ChatMessage } from '../../components/site/ChatMockup';

export interface BuildSection {
  heading: string;
  prose: string;
  pair: ChatMessage[];
}

export const buildSections: Record<string, BuildSection[]> = {
  'group-trip': [
    {
      heading: 'Setting up the group',
      prose:
        "The opening of the design conversation isn't 'how should this be built' — it's 'who's in this group and what's the trip about.' You sketch the friends and the dynamics; Cast translates that into a structure. Notice the user describes the people and their differences, not the architecture; the questions Cast asks back are about the group's needs, not Cast's mechanics.",
      pair: [
        {
          from: 'user',
          text: "Three of us are planning a trip to Portugal in October — me, Sam, and Priya. We've got different budgets and very different ideas about what makes a good trip (Sam's all food, Priya hikes, I want some of both plus museums). Can you set us up something that helps without turning into another spreadsheet?",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Yeah. Here's what I'd propose:\n\n· you three as the people who can talk to it\n· each of you has a private space — your own research, preferences, budget thoughts stay yours\n· a shared itinerary the assistant curates — destinations, dates, accommodations, what's been agreed\n· synthesis on demand — when you need to pick a restaurant or a hostel, it pulls everyone's preferences and budgets into a short list\n\nA couple of things to nail down:\n\n· Anyone in the group leading on logistics (booking, payments), or is that flexible?\n· How tight is the budget conversation — should the assistant know each person's max, or stay neutral and surface ranges?",
        },
        {
          from: 'user',
          text: "I'm leading on logistics — bookings, AirBnB hold, the group flight. On budgets: Priya's tight, Sam and I are middle. I'd rather the assistant know each cap privately and default to options that fit the tightest budget, with a way for people to opt up if they want.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Locked in:\n\n· you: organizer; bookings and payment confirmations route to you, the others see decisions as they're made\n· each person tells the assistant their max privately; default option set fits the tightest budget so nobody feels priced out\n· anyone can ask 'show me higher tier' and it'll surface those for them only — others don't see those unless the group explicitly opts in\n\nThat's the assistant's brain. Connecting each of you to it lands in configure once we wrap.",
        },
      ],
    },
    {
      heading: 'Designing how the group decides',
      prose:
        "The whole point of the assistant is helping the group decide without devolving. That means designing how it handles decisions — when to recommend, when to vote, what to do when you can't agree. The user describes what kinds of decisions the group faces; Cast proposes patterns it can use.",
      pair: [
        {
          from: 'user',
          text: "When we need to pick something — like which AirBnB in Lisbon, or where to eat Saturday night — what does the assistant actually do?",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Two patterns I'd build in:\n\n· Quick pick — short list of three options that fit the group's preferences and budget. Each carries a one-line rationale ('matches the group's stated cuisine preferences, fits the tightest budget, two-block walk from the AirBnB'). You decide quickly or vote.\n\n· Deep pick — when it matters more (the AirBnB, the rental car, the long ferry day), I'd gather each of your asks privately, show the group an anonymized synthesis ('three of you flagged proximity to Time Out Market, two prioritized walkability, one wants AC'), then propose options.\n\nBoth modes preserve the privacy contract — your individual asks stay yours; only the synthesis goes to the group.",
        },
        {
          from: 'user',
          text: "Default to deep pick on accommodations and big spends; quick pick on day-to-day stuff like restaurants and activities. And if we can't agree, I want the assistant to say so honestly — not push us toward fake consensus.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Set:\n\n· accommodations, transport, anything over €100/person — deep pick, full synthesis\n· day-to-day — quick pick, three options, no synthesis writeup\n· when preferences split (e.g., two want hiking, two want beach for Saturday) — I'd surface the split honestly with each side's reasoning, suggest a tiebreaker (compromise day, voting, alternating), but not push consensus\n\nI'd start opinionated about tiebreakers and we'd refine in the first few decisions based on what the group actually does.",
        },
      ],
    },
    {
      heading: 'Connecting each friend',
      prose:
        "Designing the assistant is one thing; getting each friend actually connected to it is another. That handoff lives in the configure console, separate from the design, because granting each person access on the transport they actually use is per-deployment operator work, not part of who the assistant is.",
      pair: [
        {
          from: 'user',
          text: "How does each friend actually reach the assistant? Sam only checks Telegram, Priya basically lives in Slack, and I'd just use the web.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Each person reaches the same assistant through whichever transport they actually use. The assistant doesn't change. Only how each person reaches it does.\n\n· Sam → Telegram\n· Priya → Slack\n· you → web\n\nSame conversation lane for all of you (the default), different transports per person. Each only ever sees their own private space and the shared itinerary. Access happens in configure once we wrap design here: each person messages from their own transport, and you approve them the first time. Handles are per-deployment, so it's deployment work, not design.",
        },
        {
          from: 'user',
          text: "What if Sam loses his phone, or wants to add WhatsApp later? And if a fourth friend joins mid-planning — any limit?",
        },
        {
          from: 'agent',
          via: 'configure',
          text: "All configure-console things, all straightforward:\n\n· Sam loses his phone: same Telegram account on the new one, and he's recognized automatically. His identity and threads stay his.\n· Sam adds WhatsApp later: he messages from it, you approve that first contact, and both Telegram and WhatsApp now reach his identity.\n· A fourth friend joins mid-planning: I'd let them in like the others. You decide what they see (probably the shared itinerary plus their own private space, probably not retroactive group decisions if you want to keep that intentional).\n\nNone of these change the assistant. It's all in the identity-and-transport layer.",
        },
      ],
    },
  ],

  'prediction-edge': [
    {
      heading: 'Picking what to watch',
      prose:
        "Your edge as a bettor is the input. You bring domain knowledge — which markets you follow, which signals matter, which sources you trust. Cast turns that into a structure: which parts watch what, how they cross-check, when they ping you. The substance is yours; Cast supplies the shape.",
      pair: [
        {
          from: 'user',
          text: "I bet on award shows — Best Picture mainly, sometimes Best Actor and Director. I follow the trade press and feel I have informed views, but I can't watch every signal in real time. What would the system actually watch?",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "For Best Picture, the high-signal feeds are guild votes (PGA, DGA, SAG-ensemble — these are the predictive ones), critic associations (NYFCC and NSFC matter because they're early; LAFCA splits often), and industry buzz (Variety, Deadline, THR coverage of the campaign).\n\nI'd set up a watcher per stream — three watchers — plus a reviewer whose job is the synthesis: when guild + critic + buzz align toward a film and the market hasn't repriced, that's the alert. For Best Actor and Director we'd reuse the same shape with the actor- and director-specific outlets.\n\nWant me to watch more than one venue when they list the same race?",
        },
        {
          from: 'user',
          text: "Yes, cross-reference where they overlap. Skip Best Director — too noisy, too contested. Add the Spirit Awards to the critics watcher; they've been more predictive lately. And if there's strong indie consensus the guilds aren't seeing, I want to know separately — that's a different signal pattern from guild-converged.",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "Wiring it in:\n\n· Best Picture and Best Actor — three watchers (guilds, critics, buzz) with Spirit Awards feeding the critics watcher\n· Director skipped until you say otherwise\n· every venue you watch, read-only, with cross-reference when more than one lists the same race\n· New rule for the reviewer: Spirit + critic alignment toward an indie that the guilds haven't seen → separate alert class, distinguishable from guild-converged alerts at a glance\n\nThe last one is the tricky bit. Want me to draft sample alert language for the indie case so you can see how it'll read on Telegram?",
        },
      ],
    },
    {
      heading: 'How an alert decides to ping you',
      prose:
        'What turns this from a noisy feed into a tool is the bar for action. The design conversation is where you set it: what convergence means, what gap matters, what stays in the morning brief instead of paging you. Tunable from there as you live with it.',
      pair: [
        {
          from: 'user',
          text: "On these prediction-market alerts — I don't want to be paged for every flutter. When would something actually fire vs. stay quiet?",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "Convergence + price gap is the bar. Two examples to make it concrete:\n\n· All three watchers surface Anora over The Brutalist (PGA + DGA + SAG-ensemble all align). The market has The Brutalist at 38%, Anora at 27% — that's an 11-point gap with three converged signals. Pings you on Telegram.\n\n· One critic association (LAFCA) goes for The Brutalist; the others haven't moved. No convergence. The reviewer notes it in the morning brief but does not page.\n\nThe gap threshold and which signal combinations count are tunable. I'd write a starting point into the reviewer's instructions — say 10-point spread, two-of-three convergence — and we'd refine those together over the first few weeks based on what fires.",
        },
        {
          from: 'user',
          text: "Start at 8 points spread, not 10 — I'm fine with more noise to find more edges, I'll tighten if it gets annoying. Two-of-three convergence is right. Weight NYFCC and NSFC heavier than LAFCA — LAFCA picks weird every few years, shouldn't move the needle.",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "Set:\n\n· 8-point gap minimum to alert\n· two-of-three convergence required\n· LAFCA noted in the morning brief but doesn't count toward critic-watcher convergence\n· NYFCC + NSFC aligning counts as the critic-watcher's vote, even if LAFCA dissents\n\nAll of these live in the reviewer's instructions — I can tune any of them in a future design pass without redoing the watchers, whenever you want them dialed.",
        },
      ],
    },
    {
      heading: 'Adding a new market',
      prose:
        "Once one domain is working, the rest is mostly supplying signals. A new market isn't a new system — it's the same shape with different specialists and different prompts about what convergence looks like. The architecture you set up the first time is the one you reuse.",
      pair: [
        {
          from: 'user',
          text: "I want to add NCAA basketball next March — completely different signals from awards, but I follow it the same way. How much rework?",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "Almost none of the structure changes; the contents do. Three new watchers, scoped to the streams that matter for college hoops:\n\n· recruiting and roster construction (247Sports, Rivals, On3)\n· advanced team metrics (KenPom, Bart Torvik, Haslametrics)\n· beat coverage and locker-room reporting\n\nReviewer same role, different prompt about what convergence looks like for sports — usually it's metrics + recruiting both flagging a team that the futures market hasn't repriced. Coordinator unchanged.\n\nI'd run NCAA alongside the awards setup — both stay independent, both alert you on their own clock. The system gets bigger but doesn't get harder to use.",
        },
        {
          from: 'user',
          text: "Only follow KenPom top-25 — I don't have an edge below that. Run it Nov 15 through Selection Sunday, paused otherwise. Awards setup keeps running year-round. NCAA convergence rule should be different from awards: recruiting + advanced metrics aligning is the strong signal, beat coverage is supporting, not gating.",
        },
        {
          from: 'agent',
          via: 'all-agents · design',
          text: "Configured:\n\n· NCAA active Nov 15 through Selection Sunday; paused outside that window — no signal collection, no reviewer cycles\n· top-25 KenPom only; teams falling out drop off automatically, climbers added\n· awards setup unchanged, year-round, alongside\n· NCAA convergence rule: recruiting + metrics aligning on a team the futures market hasn't priced → alert; beat coverage as supporting evidence in the body, not gating\n\nReady to ship the first NCAA version whenever you are. Dry run when November hits, or live on day one?",
        },
      ],
    },
  ],

  'health-stack': [
    {
      heading: 'Getting your data in',
      prose:
        "Health Stack reads files. No upload, no sync, no API. That makes the design surface small: which folder, which formats, when it should look. The first design conversation is mostly about pointing at the data and confirming the schedule — most of the work is shaping how the assistant reads, not how it gets reached.",
      pair: [
        {
          from: 'user',
          text: "I have Whoop, Oura, and Garmin exports — months of files in a folder on my Mac. I'd like a 7am brief on recovery and training and sleep, plus a weekly trend on Sundays. The data has to stay on my machine.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "All local. Here's the shape:\n\n· I'd point it at one folder of your choosing — that's the only place it can read\n· Whoop's CSV, Oura's JSON, Garmin's FIT — each format gets a parser the assistant runs when its schedule fires\n· network locked to the model — no cloud sync, no broker, no third party in the loop\n· 7am morning brief, Sunday weekly trend\n\nIf you start dropping new exports in monthly, it'll pick them up automatically — the schedule re-reads the folder.\n\nTwo confirmations:\n\n· The folder is on this machine, not on a NAS or a cloud-synced folder, right?\n· Want me to handle CGM exports too if you have those?",
        },
        {
          from: 'user',
          text: "Local folder, yes. Skip CGM for now — I'll add it later. Two quirks worth knowing: my Whoop exports come weekly but I sometimes go a few weeks without exporting, so don't panic about gaps. And Garmin shows zero strain on days I leave the watch off — treat that as 'unknown,' not 'rest.'",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Got it:\n\n· Whoop / Oura / Garmin only; no CGM\n· export gaps treated as 'no data for this period' in the brief, not as zeros or stale data\n· Garmin strain of zero with no other Garmin signals → 'watch off, unknown,' not 'rest day'\n\nWhen we add CGM later it'll be the same shape — I'd point it at the export, parser handles the format. Anything else about the data I should bake in upfront?",
        },
      ],
    },
    {
      heading: 'What the morning brief actually looks like',
      prose:
        "A morning brief is only as useful as the question it asks you. The design conversation is where you shape what gets surfaced, in what voice, at what threshold for flagging. You'd refine those over the first week or two until the brief feels like a coach rather than a dashboard.",
      pair: [
        {
          from: 'user',
          text: "Walk me through a normal 7am. What's actually in the brief — and what's not?",
        },
        {
          from: 'agent',
          via: 'design',
          text: "It opens with the cross-signal observation, not a stat dump. Like:\n\n> Third morning your HRV has trailed your strain. Last time this pattern ran four days was after your March viral thing. Flagging recovery debt — scale back today, or push and reassess Wednesday?\n\nUnderneath, the numbers it's reading from (sleep efficiency, HRV vs. baseline, training load drift) so you can sanity-check.\n\nWhat it doesn't do: pretend yesterday's poor sleep is the headline if your week's pattern is more interesting; show every metric whether it matters or not; recommend specific workouts (it surfaces what you're trending into and asks).\n\nThe voice and the threshold for 'this is worth flagging' are tunable in the design — I'd start opinionated and we'd dial it in together over the first week.",
        },
        {
          from: 'user',
          text: "Less coachy than what you showed — drop the 'or push and reassess Wednesday?' framing. I want the observation and the call, that's it. And only ping me on something flag-worthy. If yesterday was unremarkable, no brief at all — silence is fine.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Adjusted:\n\n· brief shape: observation, then the call, no decision tree\n· silent days when nothing crosses the flag threshold — no 'all good!' filler\n· flag threshold: meaningful HRV deviation (>15% off baseline), training-load drift (>10% week-over-week), or sleep efficiency shift (>8 points). Below that, no brief\n\nOne risk to flag: on stressful weeks the silence might feel like the system is broken. Want a Sunday 'baseline confirmed' check that fires only if the daily was silent all week, just for confidence? Otherwise we trust the silence.",
        },
      ],
    },
    {
      heading: 'What the weekly trend catches',
      prose:
        "The daily brief catches the acute; the weekly catches the slow drift. The design conversation is where you tell Cast what kinds of patterns the weekly looks for — what's worth tracking month-over-month, what's just noise. It's the part of the assistant that thinks across time on your behalf.",
      pair: [
        {
          from: 'user',
          text: "What does the Sunday trend tell me that the daily briefs don't?",
        },
        {
          from: 'agent',
          via: 'design',
          text: "The slow stuff. Daily catches acute — last night's sleep, today's recovery. Sunday catches drift — that your strain has crept up 12% over four weeks while sleep efficiency has dropped 6%, and the two are probably related. Or that your CGM glucose is trending higher in the post-7pm window for a month, even though no single night looked alarming.\n\nThe Sunday brief reads the last 28 days at once and surfaces three or four threads — what changed when, what cross-signals correlate, what to watch this coming week.\n\nThe specific patterns it looks for — recovery debt, glucose drift, training plateau — are something we'd shape in the design, and I'd extend over time as you notice things you want it watching.",
        },
        {
          from: 'user',
          text: "Three I want from day one: training-load drift over four weeks, HRV trended against my last 90 days (not just last week), and the post-7pm metrics window — sleep + HR for now, I'll add CGM later. Send the Sunday brief at 9am, not earlier. I want to read it with coffee.",
        },
        {
          from: 'agent',
          via: 'design',
          text: "Locked:\n\n· Sunday brief fires at 9am\n· three patterns watched every week: 4-week training-load drift, HRV trended over 90 days, post-7pm metrics window (sleep + HR for now, expandable)\n· Sunday brief always surfaces the top three threads — not silenced like the daily, since the whole point is the longitudinal read\n\nWhen CGM lands we'll add post-7pm glucose to that window pattern automatically. Anything else for Sunday before we wrap?",
        },
      ],
    },
  ],
};
export const exampleScripts: Record<string, ChatMessage[]> = {
  'second-brain': [
    {
      from: 'user',
      time: '08:14',
      text: "i'm back — where was i on everything?",
    },
    {
      from: 'agent',
      time: '08:14',
      tools: [
        { icon: '🧠', source: 'memory', detail: '3 active topics · last reflection 2 nights ago' },
        { icon: '📧', source: 'email', detail: '47 unread · 4 threads waiting on you' },
        { icon: '📅', source: 'calendar', detail: 'this week — 2 deadlines, 6 meetings' },
        { icon: '📝', source: 'reflections', detail: 'consolidation flagged 2 stalled threads' },
      ],
      text:
        "Welcome back.\n\n**Active**\n· *Atlas migration* — you'd just decided to push the cutover to Q3; draft memo at /memory/topics/atlas.md, last edit before you left.\n· *Hiring* — second-stage with Kira on Friday; the three areas to probe are in the topic note.\n· *The longform piece* — 3 paragraphs from 9 days ago, untouched since.\n\n**Waiting on you**\n· Reply to the Q2 doc thread — meeting Thursday.\n· Sarah's intro to the design candidate.\n· Two vendor follow-ups, neither urgent.\n\n**This week**\n· Atlas decision memo due Wed; performance reviews Fri.\n· From two consolidations ago: you've twice mentioned wanting to order the Davenport book but haven't. Want me to surface that next time you're at a laptop?",
      footer: '4 sources synthesized · all of this is your own',
    },
  ],

  'group-trip': [
    {
      from: 'user',
      time: '14:08',
      text: 'where are we eating in porto saturday night?',
    },
    {
      from: 'agent',
      time: '14:08',
      tools: [
        { icon: '👥', source: 'group', detail: 'preferences gathered from 4 members' },
        { icon: '🍴', source: 'cuisine signal', detail: 'traditional Portuguese (3 of 4)' },
        { icon: '💸', source: 'budget signal', detail: '€10–25 / head feasible for everyone' },
        { icon: '📍', source: 'location signal', detail: 'near São Bento (2 of 4)' },
      ],
      text: "Three picks that fit the group:\n\n· Cervejaria Gazela — €18/head, two-block walk from São Bento. Traditional petiscos, well-loved.\n· O Buraco — €12/head, slight walk. Cheap traditional, busy with locals.\n· Casa Guedes — €10/head, near São Bento. Famous for slow-roasted pork sandwich; single-dish place.\n\nWant me to put it to a vote, or pick one?",
      footer: 'preferences gathered privately · only the synthesis goes to the group',
    },
  ],

  'prediction-edge': [
    {
      from: 'agent',
      via: 'telegram · alert',
      time: '06:42',
      tools: [
        { icon: '🎬', source: 'guild-watcher', detail: 'PGA + DGA + SAG-ensemble → Anora' },
        { icon: '📝', source: 'critic-watcher', detail: 'NYFCC + NSFC → Anora; LAFCA split' },
        { icon: '📣', source: 'buzz-watcher', detail: 'late-cycle momentum shifting to Anora' },
      ],
      text: 'Market: "Anora wins Best Picture" → 27%. The Brutalist still leading at 38%.\n\nThree independent feeds converging on Anora. The PGA + DGA + SAG-ensemble trio to one film has called BP 9 of 10 times since 2010. Your January pick was Anora before the guilds confirmed.\n\nWorth a look?',
      footer: "not a trade. that's your job.",
    },
  ],

  'health-stack': [
    {
      from: 'user',
      time: '07:02',
      text: 'morning brief',
    },
    {
      from: 'agent',
      time: '07:02',
      tools: [
        { icon: '💤', source: 'oura', detail: 'sleep 5h 48m · 3 wakes · efficiency 78%' },
        { icon: '❤️', source: 'whoop', detail: 'HRV 42 (7d avg 51) · recovery 38%' },
        { icon: '🏃', source: 'garmin', detail: 'training load 3d · +18% over baseline' },
      ],
      text: 'Third morning your HRV has trailed your strain. Last time this pattern ran four days was after your March viral thing.\n\nFlagging recovery debt. Scale back today, or push and reassess Wednesday?',
      footer: 'network to the model only. nothing syncs out.',
    },
  ],
};

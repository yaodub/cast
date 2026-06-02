export interface ShapePart {
  name: string;
  desc: string;
}

export interface ShapeDescription {
  lead?: string;
  parts: ShapePart[];
  closing?: string;
}

export interface Example {
  slug: string;
  name: string;
  audience: string;
  pitch: string;
  situation: string;
  shape: ShapeDescription;
  denial: string;
  extensions: string[];
  transports: string[];
  blueprintHighlight: string;
  cron: string;
}

export const examples: Example[] = [
  {
    slug: 'prediction-edge',
    name: 'Prediction Edge',
    audience: 'for people who bet on what they know',
    pitch:
      'A specialist agent per market domain. Watches contracts, reads adjacent discussion, pings you when reality and the price drift apart. Never trades.',
    situation:
      "You watch prediction markets. You have informed views on a few specific topics (award shows, election outcomes, sports championships) but you can't watch every signal yourself. Prediction Edge runs a specialist agent per signal stream (guild votes, critic awards, polling, recruiting, whatever the market depends on), plus a reviewer that synthesizes across them and asks the questions you'd ask if you had time. None of them place trades. That's your job.",
    shape: {
      lead: 'Three things, on the markets you care about.',
      parts: [
        {
          name: 'Watches the signals you would',
          desc:
            "award shows: guild votes, critic awards, industry buzz. elections: polling and ground-game reporting. sports: recruiting and beat coverage",
        },
        {
          name: 'Pings you when signals agree but the price is lagging',
          desc:
            "the kind of mispricing you want to know about in minutes, not in the next day's recap",
        },
        {
          name: 'Stays read-only',
          desc:
            'every trade is yours by construction, so the system can flag but never act',
        },
      ],
      closing:
        "A watcher sits on each signal stream. The reviewer only pings you when they independently line up. That keeps the alerts grounded instead of vibe-driven.",
    },
    denial:
      "None of the parts can place a bet, by construction. The market connections are wired up for reading only (checking prices, looking at order books), and the betting actions simply aren't there. The model has nothing to call. Read-only isn't a rule the assistant obeys. It's the absence of a button it could push.",
    extensions: ['market-data (read-only)', 'web-fetch (X, Substacks, news)'],
    transports: ['web', 'telegram (alerts)'],
    blueprintHighlight:
      'Three watchers on different signal streams + a reviewer cross-checking + a coordinator alerting you, read-only across the whole thing',
    cron: '24/7 watch with threshold-triggered pings to your Telegram',
  },
  {
    slug: 'group-trip',
    name: 'Group Trip',
    audience: 'for friends, partners, groups making plans together',
    pitch:
      "Friends planning a trip without flooding the group chat. Cast keeps each person's research private, the shared plan curated, and pulls everyone's preferences together when it's time to pick.",
    situation:
      "Three friends planning a trip to Portugal in October. Different budgets, different obsessions, different ideas of what makes a good vacation. Group chats devolve into noise. Spreadsheets get abandoned. Cast keeps each person's research and preferences private to them, curates the shared itinerary, and weighs everyone's input when the group needs to decide between options. Different opinions, one plan, less arguing.",
    shape: {
      lead: 'One assistant for the whole group, with private space for each of you.',
      parts: [
        {
          name: 'Private research per person',
          desc:
            "Sam's restaurant lookups, Priya's hike notes, your own destination and museum thinking. None of it leaks across",
        },
        {
          name: 'Shared itinerary, curated',
          desc:
            'destinations, dates, accommodations, agreed-on activities. Anyone can see, anyone can suggest, the assistant keeps it tidy',
        },
        {
          name: 'Group decisions, synthesized',
          desc:
            "when it's time to pick a restaurant or a flight, it pulls everyone's privately stated preferences into a short list with rationale",
        },
        {
          name: 'Each friend on the app they actually use',
          desc:
            'Sam on Telegram, Priya on Slack, you on the web. Same assistant, different doors',
        },
      ],
      closing:
        "The two guarantees aren't the same kind. Each person's research sits behind a wall the others can't cross, including you, the organizer. The assistant just keeps the shared itinerary tidy.",
    },
    denial:
      "Cast enforces per-person privacy. Sam's research is Sam's, Priya's budget concerns are Priya's, and even as the organizer you can't see what each of them is exploring. The shared itinerary works differently. The assistant curates it according to its instructions, surfacing what's been decided and holding open questions until the group agrees. Two kinds of separation: a hard wall on private research, and curated discipline on shared plans.",
    extensions: ['web-fetch', 'shared-itinerary', 'group-budget', 'memory (per-identity)'],
    transports: ['telegram', 'slack', 'web'],
    blueprintHighlight:
      'One assistant for the group: private research per person, shared itinerary curated by the assistant, synthesis when the group needs to decide',
    cron: "weekly digest: this week's decisions, this week's open questions, anyone's ideas worth circulating",
  },
  {
    slug: 'second-brain',
    name: 'Second Brain',
    audience: 'for one person, across everything they touch',
    pitch:
      "Your assistant across email, calendar, WhatsApp, and the web. Holds the threads you keep losing, surfaces the connections you'd miss, consolidates its memory overnight so what matters stays close.",
    situation:
      "You have a person you've been meaning to follow up with, somewhere between an email thread, two WhatsApp messages, and a calendar event next week. You had an idea three weeks ago you've half-forgotten. Your inbox accumulates faster than you triage it. Second Brain runs alongside you across all those surfaces, builds memory of what matters, surfaces it when timing's right, and consolidates what it learns every night.",
    shape: {
      lead: 'One agent that runs alongside you, across email, calendar, WhatsApp, and the web.',
      parts: [
        {
          name: 'Pick up where you left off',
          desc:
            "'where was i on everything?' or 'what did i think about X?' Pulls memory, recent reflections, and the four extensions into one answer grounded in your own past thinking",
        },
        {
          name: 'Daily check-in',
          desc:
            "negotiates a time with you on first run, then fires each morning already knowing what's on today and what landed overnight",
        },
        {
          name: 'Overnight memory consolidation',
          desc:
            'single-shot reflection task hardcoded in the blueprint. It compresses, spots patterns, and surfaces recovered thoughts when timing fits',
        },
        {
          name: 'Chat is the interface',
          desc: 'no dashboards to maintain, conversation is the surface, memory accumulates underneath',
        },
      ],
      closing:
        "One agent, four extensions, two schedules. The agent picks when its daily check-in fires, to fit your rhythm. You set the nightly memory consolidation, so the agent can't quietly skip its own housekeeping.",
    },
    denial:
      "Every external read or write is an approval gate provided by the extension framework. Email reads prompt, calendar writes prompt, WhatsApp sends are off by default, web fetches gate by domain. The container network is sdk-only, so the agent can't dial out around the extensions. The only routes off your machine are the ones you wired. The 'second brain' stays yours: nothing leaves without an approval you saw.",
    extensions: ['email', 'calendar', 'whatsapp', 'web-fetch'],
    transports: ['web', 'cli'],
    blueprintHighlight:
      'One agent, four extensions, agent-scheduled daily check-in, blueprint-locked nightly memory consolidation on a single-shot reflection channel',
    cron: 'nightly memory consolidation pass (locked in blueprint), and a daily check-in cadence the agent negotiates with you on first run',
  },
  {
    slug: 'health-stack',
    name: 'Health Stack',
    audience: 'for the quantified self',
    pitch:
      "Reads your wearable exports, watches recovery, training, and sleep together. Talks only to the model. No cloud sync, no broker, no third party. Asks better questions than 'how do you feel?'",
    situation:
      "You track everything: Whoop, Oura, Garmin, CGM. You have a year of data and roughly zero insight. Health Stack reads what you let it read, sees the cross-signals between sleep, training, and recovery, and notices when something's drifting before your body does. One agent, one security surface, and it never dials out anywhere but the model.",
    shape: {
      lead: 'A morning brief, a weekly trend, and the questions you should be asking.',
      parts: [
        {
          name: 'Reads your wearable exports',
          desc: 'Whoop, Oura, Garmin, CGM, sitting in a folder you point it at',
        },
        {
          name: 'Morning brief at 7am',
          desc:
            "yesterday's strain vs. recovery, what the cross-signals are saying, what to watch today",
        },
        {
          name: 'Weekly trend on Sunday',
          desc: "what's drifting, what's improving, what changed when",
        },
        {
          name: 'Network locked to the model',
          desc: "The only host it can reach is the model that reads your data. There's no route to anything else.",
        },
      ],
      closing:
        "It reads one folder and dials out to one place, the model and nothing else. 'No third party touches this data' isn't a promise here. The wiring can't reach one.",
    },
    denial:
      "You wrote down what the assistant can reach, twice. Once when you described it ('it expects a folder of wearable exports, read-only'), once when you set it up on your machine ('this folder, here, is the one'). The description is portable. The path is yours. The assistant never sees a wider scope than what you bound, because there's no third place where access is granted. And the network is locked to the model only. No other host on the internet is reachable from this assistant.",
    extensions: ['whoop-parser', 'oura-parser', 'garmin-parser', 'cgm-parser', 'file-search'],
    transports: ['web'],
    blueprintHighlight:
      'One assistant: reads one folder, network locked to the model, parses Whoop / Oura / Garmin formats at runtime',
    cron: "morning brief: yesterday's strain vs recovery, and a weekly trend report",
  },
];

export function findExample(slug: string): Example | undefined {
  return examples.find((e) => e.slug === slug);
}

export function exampleNeighbors(slug: string): {
  prev: Example | null;
  next: Example | null;
} {
  const i = examples.findIndex((e) => e.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? examples[i - 1]! : null,
    next: i < examples.length - 1 ? examples[i + 1]! : null,
  };
}

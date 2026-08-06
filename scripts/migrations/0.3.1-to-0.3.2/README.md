# Migrating from 0.3.1 to 0.3.2

There are no migration scripts for this release. 0.3.2 changes no database schemas and no config formats, so a 0.3.1 install starts cleanly on 0.3.2 with nothing run first.

There is, however, **one check you should run**, because a defect fixed in this release could have corrupted `routes.json` on 0.3.0 and 0.3.1. It is the first section below.

## Required check: transport credentials in routes.json

On 0.3.0 and 0.3.1, saving a route in the admin UI paired each submitted row with its stored entry **by position**, while the page moved the edited row to the end of the list. Editing one route therefore handed every other route of that transport its neighbour's credential, and dropped the last route's credential entirely. No error was shown.

You are affected if **all** of these are true:

- you have two or more routes of the same transport (two Telegram bots, two mailboxes, and so on), and
- you edited one of them through the admin UI on 0.3.0 or 0.3.1, and
- you did not retype every other route's credential during that save.

The damage is silent, so verify rather than assume:

```bash
# List each transport's routes with a masked credential tail.
python3 - "$CAST_CONFIG_DIR/routes.json" <<'EOF'
import json, sys
for kind, entries in json.load(open(sys.argv[1])).items():
    for e in entries or []:
        for field in ('token', 'pass'):
            v = e.get(field) or (e.get('imap') or {}).get(field)
            if v:
                print(f"{kind:10} {e.get('address'):24} …{v[-6:]}")
EOF
```

Confirm each address is paired with the credential that actually belongs to it. For Telegram, the fastest check is to ask the API which bot a token is:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

A `401 Unauthorized` means the token is dead. A success response names the bot, which tells you whether it is the one that route is supposed to use.

If a credential was lost, it is not recoverable from `routes.json`. Retrieve it from the issuing service (BotFather for Telegram, your mail provider for IMAP/SMTP) and write it back. Editing routes in the admin UI is safe again once you are on 0.3.2.

## What changed on disk

Nothing structural. `routes.json` keeps the same shape; 0.3.2 only stops writing wrong values into it.

One behaviour change is worth knowing before you next edit a route. Changing a route's **agent address or channel** while leaving its credential masked is now rejected with `No stored <field> to keep for <transport> route "<address>"`. Identity is what resolves a mask, so a re-addressed route has nothing to resolve against. Retype the credential and the save succeeds. Previously this silently inherited a neighbouring route's secret, which is the defect above.

## Rebuild

Server bundle **and web UI** (`pnpm bundle --outdir …`, or `pnpm install && pnpm build` for source installs). Unlike 0.3.1, this release changes admin web-UI code, so a bundle that ships a stale `web-ui` build still carries the defect on the client side. The agent container image is untouched; the bundle re-tags the existing image with the new version.

## Verify

- Server starts and logs `Cast 0.3.2 ready`.
- With two or more routes of one transport configured, edit one route's credential in the admin UI, save, and confirm the other routes' masked tails are unchanged.
- An agent whose outbound transport is failing no longer blocks delivery for other agents to the same recipient. With one agent's credential deliberately invalid, a second agent's reply to the same user still arrives.

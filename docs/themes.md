# Make it your own

A theme file lets you name the people in the office, give them looks, roles, job titles and things to say, recolour the rooms and the furniture, and pin particular projects to particular desks. The extension ships only neutral built-in defaults; whatever you type into your own file is yours, so putting your colleagues, your friends or a favourite TV cast in the office is entirely your choice.

## Quick start

1. Run **Middle Management: Create Theme File** from the Command Palette and choose where to save it. The save dialog starts in your [themes folder](#your-offices-and-the-themes-folder). You can also click the receptionist to open the Front desk and choose **Create theme file** on its Theme tab.
2. The starter file opens with every field filled in. Change a few names and save.
3. Watch the office update. It checks the file every 2 seconds while the office is visible.

Any file named `*.theme.json` gets completions and red squiggles for typos, bad colours and unknown style names. The extension turns this on itself, through the schema in `media/theme.schema.json`, so files it creates have no `$schema` line.

The command also sets `claudeOffice.themeFile` for you. To use a file you already have, set that setting to its path. `~` is expanded, and a relative path is resolved against your first workspace folder.

The extension ships six ready-made offices. Each one is a complete theme with its own sign, people, colours and small talk. The floor plan and the furniture stay the same.

To try one without a file, open the Front desk and go to the **Theme** tab. Under **Ready-made offices** there is one button for each office. The button shows the office's name, with its description underneath. Choosing a button sets `claudeOffice.themeFile` to that office's setting value, shown in the table below.

| Label | Setting value | What it is |
| --- | --- | --- |
| Example office | `preset:example` | Pennywhistle Paper, Harbour Branch: made-up staff, a receptionist and a seaside colour scheme of teal, slate and sand. |
| Spaceship | `preset:spaceship` | A fully themed starship crew where everyone talks ship, from the bridge to the galley, in cool deck greys and teal under a field of stars. |
| Construction Site | `preset:construction-site` | A hi-vis site crew in the cabins, a gatehouse sign-in and concrete, plywood and safety-orange colours. |
| Metalwork Factory | `preset:metalwork-factory` | Welders, furnace keepers and a crane driver, a works gate and a soot, steel and ember colour scheme. |
| Cyberpunk | `preset:cyberpunk` | A neon tower office in the endless rain: data brokers, drone couriers and a dark magenta and cyan palette. |
| Steampunk | `preset:steampunk` | An airship and clockwork counting house: cog-wrights, a pneumatic post and brass, mahogany and baize. |

Ready-made offices are read-only. While one is in use, the Theme tab shows a **Ready-made** chip next to the title, together with **Make an editable copy…**, the other ready-made offices and **Back to built-in**. Choose **Make an editable copy…** to save a copy to a file you pick (the dialog starts in your [themes folder](#your-offices-and-the-themes-folder)). The extension then switches to that copy, so you can edit it like any other theme file.

To have Claude write one for you, see [Ask Claude to make one](#ask-claude-to-make-one). You can also edit the theme without touching the JSON. The Front desk's Staff and Colours tabs change the same fields. See [Saving from the Front desk](#saving-from-the-front-desk).

## Ask Claude to make one

You don't have to write the JSON yourself. Claude Code can write a whole theme from a description: names, job titles, everything people say, their looks, and the colours of the rooms and furniture.

For example: "Make me a Middle Management theme set on a pirate ship where everyone talks like a pirate."

1. Click the receptionist (or the bell in the icon bar) to open the Front desk, and go to the **Theme** tab.
2. Find the **Make one with Claude** card and choose **Teach Claude**. This installs a small Claude Code personal skill, once. It is never installed without that click.
3. In any Claude Code chat, say what you want, for instance "make me a theme for Middle Management that…" followed by your idea. Claude may ask one question if something big is unclear.
4. When Claude has saved the file, pick it under **Your offices** on the Theme tab. It shows up as soon as it is saved.

The skill lives in `~/.claude/skills/middle-management-theme/`. If `CLAUDE_CONFIG_DIR` is set, the folder is under that instead. It holds a short set of instructions, the theme schema, a guide to every field and an example theme. Nothing else on your machine is changed.

What the card shows depends on the skill's state:

| State | What you see |
| --- | --- |
| Not installed | **Teach Claude** |
| Installed and current | "Claude knows how." and **Remove** |
| Older than this version of the extension | **Update** |
| Files edited by hand | "The skill's files were changed by hand." with **Reinstall…** and **Remove…**. Both ask you to confirm, because your edits would be lost. |
| Another skill already uses the folder name | An explanation only. Middle Management leaves that folder alone. |

**Update** appears after an extension update brings a newer skill. **Remove** deletes only the files the skill installed, and then the folder if nothing else is in it. Files you added yourself stay.

If you'd rather not add a skill, choose **Copy a prompt** at the bottom of the card. It copies a full, self-contained prompt that tells Claude where the schema and guide are, where to save the file and what the rules are. Paste it into a Claude Code chat and add your idea.

Claude's detailed authoring reference is [`media/theme-guide.md`](../media/theme-guide.md). It ships with the extension and has the full table of speech pools with their built-in counts and samples, and every colour key with its built-in value. It is generated from the code, so it is always current.

## Your offices and the themes folder

Themes that Claude makes are saved in `~/.middle-management/themes/`. The Theme tab lists the `*.theme.json` files in that folder under **Your offices**:

- Newest first, up to 50 files. If there are more, the tab says it is showing the newest 50.
- Each one is labelled with the theme's `name` and has its `description` underneath. A file with no `name` shows its file name, and one with problems is marked "Has problems".
- Only files directly in the folder are listed. Hidden files (names starting with a dot) and files over 1 MB are skipped.
- The folder is checked when the Front desk opens, after each theme action, and every few seconds while the office is visible.

Picking one sets `claudeOffice.themeFile` to `~/.middle-management/themes/<file>` in your user settings. **Open themes folder** opens the folder in your file manager. The office you are using is marked "In use", and if a workspace setting chooses the theme file, the buttons are disabled.

**Create theme file** and **Make an editable copy…** open their save dialog in this folder by default, so a theme you make by hand ends up in **Your offices** too. You can still save anywhere else, and a theme anywhere on disk works through `claudeOffice.themeFile` as before.

## The file, section by section

Everything is optional. Leave something out and the built-in value stays.

### name and description

```json
"name": "Pirate ship",
"description": "A galleon crew where everyone talks like a pirate."
```

How the theme is labelled under **Your offices**: the name (at most 40 characters) and a one-sentence description (at most 160). Both are optional. Without a `name`, the list shows the file name.

### lineMode

```json
"lineMode": "replace"
```

What your lines do to the built-in ones. This one switch covers `lines`, `smallTalk`, `manager.lines` and `receptionist.lines`.

- `"add"` (the default) mixes your lines in with the built-in lines.
- `"replace"` says only your lines, but only in the pools you fill. A pool you leave out keeps its built-in lines, so nobody goes silent.

Use `replace` for a themed office and fill every pool, or ordinary office talk leaks in. A worker's own `lines` (see `staff`) are always that person's own chat openers, whatever the mode.

### company and branch

```json
"company": "Pennywhistle Paper",
"branch": "Harbour Branch"
```

The two lines of the wall sign.

### manager

```json
"manager": { "name": "Alex Mercer", "look": { "head": "boss", "tie": "#8c2d3c" }, "lines": ["Let's circle back."] }
```

Your name on the manager's tooltip, the manager's look, and the boss-isms they say. `manager.lines` is the older way to give the manager lines. It still works and joins the `bossVisit` pool, so `lineMode` decides whether it adds to the built-in lines or replaces them. For new themes, use the `lines` pools, which cover more moments. No line repeats until all of them have been said. Keep each line to about 70 characters or fewer so it fits in a speech bubble.

### receptionist

```json
"receptionist": {
  "name": "Odette Marsh",
  "look": { "head": "headset", "outfit": "blouse", "accent": "#2f6f73" },
  "lines": ["Good morning, Pennywhistle Paper. How may I redirect you?"]
}
```

The receptionist is always at the front desk, whether or not any sessions are running. She works the same way as `manager`: a name, a look and her own lines. Her `lines` join the `receptionPhone`, `receptionGreeting` and `receptionIdle` pools, so `lineMode` decides whether they add to her built-in lines or replace them. They are only said when `claudeOffice.speechBubbles` is on. No line repeats until all of them have been said. Keep each line to about 70 characters or fewer so it fits in a speech bubble. Click her to open the Front desk.

### colors

```json
"colors": { "wall": "#cfe3e0", "carpet": "#3f5f73", "signPlate": "#1f3a4d" }
```

Overrides for the colours of the office itself: the rooms and, since the furniture colours were added, the furniture, plants, windows and lights. Each is `#rrggbb`, and you can set any of them. Leave one out and the built-in colour stays. Unknown names are reported and ignored. Shades are worked out from the colour you give, so setting `wall` also changes its lighter and darker tones.

| Key | What it paints |
| --- | --- |
| `wall` | The walls |
| `trim` | Skirting and trim |
| `ceiling` | The ceiling |
| `carpet` | The open-plan floor |
| `lobbyFloor` | The lobby floor |
| `kitchenFloor` | The kitchen floor |
| `conferenceFloor` | The conference room floor |
| `managerFloor` | The floor of the manager's office |
| `annexFloor` | The floor of the annex |
| `rug` | The rug |
| `rugBorder` | The border of the rug |
| `deskChairs` | The desk chairs |
| `kitchenChairs` | The kitchen chairs |
| `managerChair` | The manager's chair |
| `signPlate` | The plate behind the wall sign |
| `signText` | The company name on the sign |
| `signBranch` | The branch name on the sign |

The next 17 keys recolour the furniture and the view. The Colours tab shows them in the groups below.

| Group | Key | What it paints |
| --- | --- | --- |
| Furniture | `desks` | Desk tops |
| Furniture | `deskPanels` | Side panels of the desks |
| Furniture | `wood` | Cupboards, counters and other light wood |
| Furniture | `darkWood` | The manager's desk and the conference table |
| Furniture | `metal` | Filing cabinets, drawers and other metal |
| Furniture | `computers` | Monitor cases and the copier |
| Furniture | `screens` | Monitor screens when switched off |
| Plants | `plants` | Leaves of the pot plants |
| Plants | `plantPots` | Plant pots |
| Windows and glass | `glass` | The glass walls of the manager's office |
| Windows and glass | `glassFrames` | Frames of the glass walls |
| Windows and glass | `blinds` | Blinds on the windows and glass walls |
| Windows and glass | `windowFrames` | Window frames on the top wall |
| Windows and glass | `sky` | The sky through the windows |
| Windows and glass | `skyline` | The skyline in front of the sky |
| Lights and outside | `ceilingLights` | Ceiling light panels and their glow |
| Lights and outside | `outside` | The dark strip around the outside of the building |

Furniture colours only change the furniture and fittings. The shapes, the floor plan and the props on each desk stay the same, and so do held food and the food trolley. The built-in value of every key is listed in [`media/theme-guide.md`](../media/theme-guide.md).

Keep `signText` and `signBranch` well apart from `signPlate`, or the sign is hard to read. The Front desk's Colours tab warns you about this.

### smallTalk

```json
"smallTalk": [["Is the lift working today?", "Only if you ask it nicely."]]
```

Pairs of lines for the water cooler: one worker says the first, the other answers with the second. You can give up to 200 pairs. In `add` mode (the default) they are added to the built-in ones; in `replace` mode they are the whole water cooler (see `lineMode`). The built-in set has about 840 pairs, enough for about two hours of chat without a repeat, so a replace-mode theme wants a good number of its own. Shuffled like a deck, no pair repeats until all of them have been used, and a pair that is in both the theme and the built-ins counts once.

A worker's own `lines` (see `staff`) can open a chat, but only once every 40 minutes per person. The other person then answers with a generic reply. At all other times the chat uses the small-talk pairs.

Keep each line to about 70 characters or fewer so it fits in a speech bubble. Speech bubbles wrap to up to 3 rows of about 24 characters, and longer lines are cut off with "..". Most built-in lines fit in 2 rows (about 40 characters).

### lines

```json
"lines": {
  "bossVisit": ["Eyes on the horizon, crew.", "Who touched the compass?"],
  "cartCalls": ["Biscuits, hot from the galley!"]
}
```

What everyone says, one list per speech pool. Use only the keys below (an unknown key is reported and ignored), and fill as many as you like. Each list holds at most 60 lines. Speech is only shown when `claudeOffice.speechBubbles` is on. In `add` mode your lines mix in with the built-in ones; in `replace` mode a pool you fill says only your lines (see `lineMode`).

| Pool | Who says it | When |
| --- | --- | --- |
| `bossVisit` | the manager | visiting a worker's desk |
| `bossSnack` | the manager | at the food trolley, justifying what he picked |
| `bossSnoop` | the manager | looking over a working agent's shoulder |
| `bossSulkStart` | the manager | as a Fable agent takes over his office |
| `bossSulk` | the manager | muttering while he sulks outside his office |
| `bossSulkEnd` | the manager | as the spell ends and he gets his office back |
| `deskBumped` | a worker | when a better-ranked model takes their desk |
| `deskMoveUp` | a worker | when moving to a better desk |
| `chatReplies` | a worker | answering a colleague's own `staff` line during water-cooler chat |
| `receptionPhone` | the receptionist | when a call comes in at the front desk |
| `receptionGreeting` | the receptionist | when a new worker steps out of the elevator |
| `receptionIdle` | the receptionist | idle remarks while she works the front desk |
| `receptionAttending` | the receptionist | when the Front desk panel is open and she looks up from her work |
| `cleanerMutters` | the cleaner | muttering while wiping a vacated desk, emptying bins or doing the kitchen counter |
| `cartCalls` | the food trolley vendor | calling out while pushing the trolley and while it is parked |
| `itFix` | the IT fixer | the opening line of every fix |
| `itVerdicts` | the IT fixer | once the worker's monitor has rebooted |
| `itGiveUps` | the IT fixer | when the worker gets up and leaves halfway through the fix |
| `itSneers` | the IT critic | sneering at what the AI worker has on screen once it comes back |
| `itComebacks` | the AI worker being fixed | answering back after its monitor has been rebooted |
| `itFixerMutters` | the IT fixer | muttering while walking round the office |
| `itCriticMutters` | the IT critic | muttering while walking round the office |
| `itTalkReplies` | an idle AI worker, the receptionist or the manager | a puzzled reply to either IT opener in small talk |
| `itFixerTalk` | the IT fixer, then the listener | small talk: an awkward opener, then a reply (pairs) |
| `itCriticTalk` | the IT critic, then the listener | small talk: fumbled chat read off a crib card, then a reply (pairs) |

**Two pools hold pairs.** `itFixerTalk` and `itCriticTalk` are lists of `[opener, reply]` pairs, like `smallTalk`, not single lines. The IT person says the opener and the listener says the reply, and each list may hold up to 60 pairs.

```json
"itFixerTalk": [["Nice weather for a server room.", "It is colder in there. I like cold."]]
```

In `replace` mode, keep the pools you fill reasonably full. Every pool is shuffled like a deck and no line repeats until all of them have been said, so a pool with three lines repeats quickly. [`media/theme-guide.md`](../media/theme-guide.md) lists the built-in count and some sample lines for each pool, and suggests how many lines to write.

**Rules for lines**

- Plain ASCII only. The pixel font draws anything else as `?`. Curly quotes, dashes and ellipses are folded to their plain look-alikes for you, but accented letters, emoji and symbols are not, so avoid them.
- Keep each line to about 70 characters or fewer (the hard limit is 80). Speech bubbles wrap to 3 rows of about 24 characters and cut longer lines off with "..".
- A line is one line of text, with no line breaks.

### titles

```json
"titles": { "manager": "Captain", "receptionist": "Quartermaster", "cleaner": "Deck Scrubber" }
```

Job titles shown on tooltips, speech bubbles and the roster. Each is at most 40 characters. Leave one out and the built-in title stays.

| Key | Who | Built-in title |
| --- | --- | --- |
| `manager` | The manager (you) | Regional Manager |
| `receptionist` | The receptionist | Receptionist |
| `cleaner` | The cleaner | Cleaner |
| `temp` | Every temp (subagent) | Temp |
| `vendor` | The food trolley vendor | Food cart |
| `itSupport` | Both of the IT people | IT support |

### cleaner, vendor, itFixer and itCritic

```json
"cleaner": { "name": "Old Barnaby", "look": { "head": "short", "outfit": "plain" } },
"vendor": { "name": "Mabel", "look": { "head": "bob" } }
```

The four side characters can be named and restyled like any other person. Each takes a `name` and a `look` (see [Looks](#looks)), both optional, and no `lines` of their own: what they say comes from the `lines` pools above.

| Key | Who |
| --- | --- |
| `cleaner` | The cleaner, who wipes down empty desks and does the rounds |
| `vendor` | The food trolley vendor |
| `itFixer` | The IT fixer, who reboots a worker's monitor |
| `itCritic` | The IT critic, who sneers at what is on screen |

The IT fixer and the IT critic share the `itSupport` title. Any name left out keeps the built-in name.

### staff

```json
"staff": [
  { "name": "Dana Whitcombe", "role": "Head of Snacks", "look": { "outfit": "cardigan" }, "lines": ["Fruit is also a snack."] }
]
```

Up to 8 people. Everything is optional: `name`, `role`, `look`, `lines` (what they say to open a water-cooler chat, at most once every 40 minutes; see `smallTalk`) and `pin`. A person with no name shows no name, like a person without a theme. The first entry is slot 1, and so on. Slots are handed out in desk order as sessions start.

Use `{}` to keep a slot untouched without naming anyone. This is how you change slot 4 and leave slots 1 to 3 as they are:

```json
"staff": [{}, {}, {}, { "name": "Marta Quill", "role": "Printer Whisperer" }]
```

An entry that can't be used (not an object, or a bad `name`) also becomes `{}`, with a problem reported, so that the people after it keep their desks. Trailing `{}` entries are the same as leaving them off.

| Slot | Desk |
| --- | --- |
| 1 | Right end of the open-plan desk row, just outside the manager's glass office |
| 2 | Next to slot 1, one desk to the left |
| 3 | The IT help desk, in the middle of the bottom row |
| 4 | Left side of the open-plan desk row |
| 5, 6 | The two desks in the bottom-left corner |
| 7 | In the open-plan row, between slot 4 and slot 2 |
| 8 | The annex on the right, where the temps' desks are |

Each slot keeps the desk props of its built-in character (for example the crossword or the cat photos), whatever look you give it.

**Slot 3 and the reception desk.** The reception seat in the lobby now belongs to the receptionist, who is always there (see `receptionist`). The worker in slot 3 moved to a new desk, the IT help desk, in the middle of the bottom row. That slot's built-in character is now "IT Help Desk", with a headset, a polo shirt and lanyard, a rubber duck and a label maker. If your file already has a third `staff` entry, that person sits at the help desk. A partial `look` there is filled in from the help-desk look, not the old reception look. The Front desk's **Reset to built-in look** clears a look you no longer want.

### temps

```json
"temps": [{ "name": "Temp Tilly", "look": { "head": "ponytail", "hair": "#c08040" } }]
```

Up to 6 looks for temps (subagents). They are handed out round-robin, so the seventh temp reuses the first look. As with `staff`, `name` is optional and `{}` keeps a slot untouched.

## Looks

A `look` is a set of optional keys. Anything you leave out falls back to whatever that slot's built-in look uses. Colours are written `#rrggbb`.

| Key | What it sets |
| --- | --- |
| `head` | Head style (see below) |
| `skin` | Skin tone |
| `build` | Body size |
| `outfit` | Clothing style |
| `hair`, `hairHighlight` | Hair colour and its lighter streaks |
| `eye` | Eye colour |
| `shirt` | Shirt or blouse |
| `outer` | Jacket, cardigan or vest |
| `sleeve` | Sleeves (default: same as `outer`) |
| `tie`, `collar` | Tie and shirt collar |
| `bow` | Hair accessory (bow or clip), on heads that have one such as `cat` and `ponytail` |
| `accent`, `accent2` | Pattern colours of the `floral` outfit and button trim on a `vest` |
| `pants`, `legs`, `shoes` | Trousers (or the skirt), bare legs shown below a skirt, shoes |
| `glasses` | Glasses frame |
| `facialHair` | Beard or moustache |
| `beltColor` | Belt |
| `skirt` | `true` for a skirt instead of trousers |
| `shortSleeves` | `true` for bare forearms |
| `belt` | `true` to show a belt (shirt tucked in) |

**Head styles**

| Value | Looks like |
| --- | --- |
| `boss` | Short hair with a side parting |
| `assistant` | Short hair with a full fringe, and glasses |
| `prankster` | Tousled hair with a tuft on top, swept to one side |
| `receptionist` | Long hair falling past the chin on both sides |
| `crossword` | Bald on top, hair at the sides, glasses and a short beard |
| `cat` | Rounded hair with a small bow on top |
| `chili` | Thin, short hair, high forehead and a broad face |
| `knitting` | Full, fluffy hair with a fringe, wide at the sides |
| `hr` | Bald on top with hair at the sides and a full beard |
| `short` | Short, simple haircut |
| `spiky` | Short spiky hair |
| `ponytail` | Hair tied back in a ponytail with a hair tie |
| `curly` | Big curly hair all round the face |
| `bob` | Chin-length bob covering the ears |
| `headset` | Short hair under a headset, with a band over the crown, ear cups and a microphone to the mouth; the built-in look of the IT help desk |

**Skin tones:** `fair`, `rosy`, `warm`, `olive`, `brown`, `deep`.

**Builds:** `normal`, `tall`, `small`, `big`.

**Outfits**

| Value | Looks like |
| --- | --- |
| `suit` | Buttoned jacket over a shirt and tie |
| `shirtTie` | Shirt, collar and tie, no jacket |
| `looseTie` | Jacket over a shirt with a loosened, crooked tie |
| `cardigan` | Cardigan with the shirt showing down the middle |
| `buttonCardigan` | Cardigan buttoned all the way up |
| `vest` | Waistcoat with buttons over a shirt and tie |
| `floral` | Top with an all-over flower pattern |
| `openCardigan` | Open cardigan over a top (looks much like `cardigan` from the front) |
| `plain` | Plain top with a collar band |
| `polo` | Polo shirt with a button placket |
| `blouse` | Plain blouse with a small collar |

Any outfit can be combined with `skirt`, `shortSleeves` and `belt`.

## Pins

A pin keeps a project at a particular desk:

```json
{ "name": "Dana Whitcombe", "pin": { "project": "website", "title": "refactor" } }
```

- `project` matches against the project's folder path, `title` against the session title. Both ignore case and match any part of the text.
- With both given, both must match. A pin with empty text counts as no pin.
- A new worker takes a free slot whose pin matches first, then the first free slot with no pin, then the first free pinned slot, and finally becomes a temp if all eight are taken.
- Pins only affect workers who arrive after the file is saved. Anyone already at a desk stays put.

## Saving from the Front desk

The Front desk's Staff and Colours tabs edit your theme file. **Save** does not patch the file. It writes the whole theme again in a standard form:

- Two-space indentation and a fixed key order: `name`, `description`, `company`, `branch`, `lineMode`, `titles`, `manager`, `receptionist`, `cleaner`, `vendor`, `itFixer`, `itCritic`, `colors`, `lines`, `smallTalk`, `staff`, `temps`. Inside a person: `name`, `role`, `pin`, `look`, `lines`. Inside `lines`, `titles` and `colors` the keys follow the order of the tables on this page.
- Every field described on this page is kept, including `name`, `description`, `lineMode`, `lines`, `titles`, the side characters and the furniture colours, so a theme that Claude wrote survives being edited in the Front desk.
- Empty `lines` lists are dropped, and so are empty `manager`, `receptionist`, side-character, `titles`, `lines` and `colors` objects. Trailing `{}` entries in `staff` and `temps` are dropped too. Empty ones in the middle stay, because they hold a slot.
- Only valid fields are written. Anything the extension would have ignored (unknown keys, invalid values) is lost, along with your own formatting and any comments.
- A `$schema` line you added yourself is kept. New files made by the extension have none, because files named `*.theme.json` are checked and completed automatically.

A save is refused when the target isn't safe to overwrite: the theme path comes from workspace settings, the file doesn't end in `.json`, the file isn't a JSON object, or the theme has problems. If the file changed on disk since it was loaded, the Front desk asks whether to load it, keep yours, or save anyway. If you don't want your file rewritten, edit it by hand and use the Front desk only to look.

## Limits

| What | Max |
| --- | --- |
| Staff | 8 |
| Temps | 6 |
| Lines per person, and per speech pool in `lines` | 60 |
| Pairs per pairs pool (`itFixerTalk`, `itCriticTalk`) | 60 |
| Small-talk pairs | 200 |
| Theme name, company, branch and names | 40 characters |
| Description | 160 characters |
| Title | 40 characters |
| Role | 60 characters |
| One line of speech | 80 characters (aim for 70 or fewer) |
| One pin text | 200 characters |

## When something is wrong

- A field with a problem is skipped and the rest of the file still applies. Each problem is listed in the **Middle Management** Output channel, and a warning popup tells you how many there were.
- If the file goes missing, can't be read or isn't valid JSON, the office keeps the last good theme.
- Unknown keys are ignored. Inside `lines`, `titles` and `colors` they are also reported, so a misspelt pool name shows up in the Output channel.

## Settings

When the file sets `company`, `branch` or `manager.name`, they win over `claudeOffice.companyName`, `claudeOffice.branchName` and `claudeOffice.managerName`. Leave them out of the file and the settings apply as usual.

## Example

[`media/themes/example.theme.json`](../media/themes/example.theme.json) is a complete made-up office that uses every section, including the receptionist and colours. It is also built in as `preset:example`. Copy it and change the names. The other five files in `media/themes/` (`spaceship`, `construction-site`, `metalwork-factory`, `cyberpunk` and `steampunk`, each as `<id>.theme.json`) are also complete themes worth copying.

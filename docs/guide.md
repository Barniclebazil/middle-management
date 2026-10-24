# Middle Management user guide

This guide covers everything the [README](../README.md) skips: how seating works, what the office gets up to between tasks, every part of Manager Mode, the office tools, exactly what the extension reads and starts on your machine, and how to install it in awkward places. For theme files, see the separate [theme guide](themes.md).

## Contents

- [What the workers do](#what-the-workers-do)
  - [Who sits where](#who-sits-where)
  - [Office life between tasks](#office-life-between-tasks)
- [Using the office](#using-the-office)
  - [The office on top](#the-office-on-top)
  - [The strip layout](#the-strip-layout)
  - [Conversation tabs](#conversation-tabs)
  - [Sending a worker home](#sending-a-worker-home)
  - [The demo](#the-demo)
- [Manager Mode](#manager-mode)
  - [Giving a task](#giving-a-task)
  - [Changing a worker's model, effort or approvals](#changing-a-workers-model-effort-or-approvals)
  - [The case file](#the-case-file)
  - [Knocks at your door](#knocks-at-your-door)
  - [Tokens and cost](#tokens-and-cost)
  - [Safety, reloading and personal use](#safety-reloading-and-personal-use)
- [View mode](#view-mode)
- [Office tools](#office-tools)
- [What starts in the background](#what-starts-in-the-background)
- [Front desk](#front-desk)
- [Settings](#settings)
- [Themes](#themes)
- [Privacy in detail](#privacy-in-detail)
- [Requirements](#requirements)
- [Installing and updating](#installing-and-updating)
  - [Updates](#updates)
  - [Windows 11 without admin rights](#windows-11-without-admin-rights)
  - [Claude Code in WSL](#claude-code-in-wsl)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## What the workers do

Each Claude Code session is a member of staff, and their pose shows what the agent is doing right now. Subagents are temps: they walk in from the lift, do their job and leave when they're done.

| Agent is... | Worker... |
| --- | --- |
| reading files | holds a printout up at their desk |
| searching (Grep/Glob) | rummages in the filing cabinets |
| researching the web | types with a browser on screen |
| writing or editing code | types fast |
| editing images, CSS, HTML or SVG | draws at the drafting easel |
| running commands | pounds the keyboard (green terminal glow) |
| running a long command (over 20 s) | waits at the copier, tapping a foot |
| planning (todo lists, plans, skills) | writes on the conference-room whiteboard |
| launching subagents | points toward reception while temps arrive |
| thinking | leans back with a thought bubble |
| needing you (a question or permission prompt) | walks to your office door and knocks; several queue up |
| compacting its context | feeds the shredder |
| idle | wanders to the kitchen, water cooler or vending machine and chats |

When you send a prompt, the manager walks out to that worker's desk and says a boss-ism. Speech bubbles show the file, search or command a worker is busy with.

Hover over a character for details: session title, project and git branch, role, current activity, how long they've been at it and how much of their context is used. A knocking worker also says what it wants. The hover badge has a coloured model chip (Fable amber, Opus violet, Sonnet blue, Haiku green) and an effort meter of five pips (low, medium, high, xhigh, max).

### Who sits where

Desks go by model. Opus gets the best desks near your office, including some temp desks. Sonnet gets the rest of the bullpen and the nearest annex desks, and Haiku gets the rest of the annex. Temps follow the same rules as everyone else, so a mixed team spreads across the floor.

- A worker whose model isn't known yet sits in the middle and moves once it is.
- If someone on a better model needs a desk, a worker sitting above their own band is bumped (and grumbles about it). Workers move back to their own band when a desk frees up.
- People keep their look when they move. Only the desk changes.

**The Fable takeover.** When a Fable worker (the top model) arrives, it takes over your office for 5 minutes. This happens once per Fable worker, and ends early if that worker leaves. The manager sulks at the kitchen table under a little storm cloud. They still come out for desk visits after your prompts, then storm back. When the takeover ends, the Fable worker moves to the best Opus desk. Hover over the manager to see how long is left.

### Office life between tasks

Some things happen around the desks whatever the agents are doing. None of them changes what a worker does for you.

- **Coffee shows effort.** Each worker sips coffee at their desk while working, and their effort level sets how often: roughly every 90 s at low, 60 s at medium, 35 s at high, 20 s at xhigh and 10 s at max, with higher effort sipping faster too. A mug holds six sips. When an idle worker's mug is empty they walk to the coffee maker for a refill, so high-effort workers visit the kitchen more. Workers never leave a task to get coffee. A session that doesn't report its effort uses the Claude default for its model.
- **The boss looks over shoulders.** Every 4 to 8 minutes, when nobody needs him, the manager walks up behind a worker busy at their desk, watches for a few seconds and says "Don't make mistakes." A knock at his door or a new prompt takes priority, and he skips this during a Fable takeover. All manager lines, this one included, are hidden when `claudeOffice.bossQuotes` is off.
- **The cleaner** comes in from the lift shortly after a worker leaves (or is sent home) and wipes down the empty desk. They also do a round every 10 to 15 minutes covering one or two of: an empty desk, the kitchen counter or the bin by the shredder, muttering to themselves as they go. Hover shows "Cleaner"; clicking does nothing.
- **The food cart.** Every 15 to 25 minutes a vendor pushes a snack trolley into the bullpen and stays about 90 seconds, calling out what's on. The manager always goes over (unless a Fable worker has his office), picks something unhealthy (carrot cake, a doughnut or crisps) and justifies it to no one in particular. Idle workers sometimes wander over too. Hover shows "Food cart".
- **The IT support pair.** Every 4 to 6 minutes Dez and Fenwick come in from the lift. Dez stands beside a worker's desk and asks, "Have you tried turning it off and on again?" The monitor reboots with a progress bar, and Fenwick sneers at whatever is on screen. They pick a worker stuck waiting on you first, then a busy one, then an empty desk, and never a desk the boss is watching. Most visits end with awful small talk with an idle worker, the receptionist or the boss, which stops at once if that person is needed. With speech bubbles off there's no small talk, but the fix still happens. The fix is for show only and doesn't touch the real Claude Code session. Hover shows "Dez, IT support" or "Fenwick, IT support"; clicking does nothing.

The cleaner, the vendor and the IT pair are built in and have no settings of their own. A theme can rename and restyle them, change their job titles and replace what they say. See the [theme guide](themes.md#cleaner-vendor-itfixer-and-itcritic).

## Using the office

- **Open it.** Click the Middle Management icon in the activity bar to show the office in the panel and bring it forward. Clicking the icon again doesn't hide it. You can also run **Middle Management: Show Office** from the Command Palette, and bind a key to it if you like.
- **Open a big view** with **Middle Management: Open in Editor Tab**.
- **Give a task** with the **+ New task** button or **Middle Management: New Task**. See [Manager Mode](#manager-mode).
- **Use the office tools** from the icon bar at the top of the office (a rail down the left in the [strip layout](#the-strip-layout)). See [Office tools](#office-tools).
- **Change the look and settings** by clicking the receptionist, or with **Middle Management: Open Front Desk**. See [Front desk](#front-desk).
- **Switch to view mode** with **Middle Management: Switch Between View and Manager Mode**. See [View mode](#view-mode).
- **Check for updates** with **Middle Management: Check for Updates**. See [Installing and updating](#installing-and-updating).
- **Make your own theme** with **Middle Management: Create Theme File**. See [Themes](#themes).

### The office on top

The office works best as a wide, short strip above your editor. The first time you open it, it moves VS Code's panel to the top of the window and shows a one-time message saying so. It only does this once. To move the panel back, right-click the panel title and choose **Panel Position**. To put the office on top again later, run **Middle Management: Put the office on top**. If your editor has no command for moving the panel, there's no message and the panel stays where it is.

### The strip layout

When the office view is at least 1000 px wide, no more than 600 px tall and at least twice as wide as it is tall, it switches to the strip layout:

- The icon bar stands on its end as a rail down the left.
- The map sits flush beside it, at full height.
- The staff list takes the rest of the width, in up to three columns.
- When there's room, each row gets a detail line with model, effort, context used and cost. A panel that is wide but not very wide (say 1200 x 500) keeps a plain list.

Other shapes keep the classic layout. A narrow sidebar pans the map instead of squeezing it, and there Tab also reaches props that are off screen, such as the Front desk, and pans the map to them.

### Conversation tabs

In the strip layout, or when that worker's tab is already open, clicking a worker (on the map or in the staff list) opens their conversation in an editor tab instead of the in-office drawer. Clicking again brings the tab to the front.

- The tab reads like the Claude Code chat: a reading column with the reply box pinned at the bottom, with **Send** and **Stop**.
- The portrait in the tab matches the worker's look in the office.
- Escape never closes a tab. Close it like any other editor tab.
- You can have up to 20 tabs open; close one to open another.
- A staff row shows an **In tab** mark while its tab is open. Click the row to go to the tab.
- Tabs aren't restored after reloading the window, and aren't available in the demo.

### Sending a worker home

Once a worker has finished, you can send them home so they stop taking up a desk.

- Click the **×** on their staff row, or close their tab while they're idle. They walk out of the door.
- If the worker was an idle run started from the office, that run is stopped. Nothing is touched in a session that is live in another window.
- A busy worker is never sent home. Closing a busy worker's tab only closes the tab, and they carry on.
- A sent-home worker comes back when their session has new activity, or when they knock at your door. The final write made when an idle office run is stopped doesn't count as new activity.
- Idle workers go home by themselves after `claudeOffice.sendHomeAfter` hours (8 by default; `0` turns this off). A worker with an open tab is never sent home automatically.
- Sent-home workers stay home across window reloads.

### The demo

**Middle Management: Toggle Demo** plays a scripted office, showing every activity pose without any Claude Code session running. It has no model chips, no seating by model and no Fable takeover. Demo workers can't take real tasks, conversation tabs aren't available, and the five setup panels (File room, Training library, Phone, Office handbook and Temp agency) say "Not available in the demo", because there are no real folders or setup to show. Run the command again to turn it off.

## Manager Mode

Watching is only half the job. As the Regional Manager, you can give workers tasks, read their conversations and answer them from inside the office. Manager Mode runs this work with the Claude Agent SDK, which starts real Claude Code sessions.

### Giving a task

1. Click yourself in the glass office, use the **+ New task** button, or run **Middle Management: New Task**.
2. Fill in the interoffice memo:

   | Field | What to put in it |
   | --- | --- |
   | **RE (project)** | Your workspace folders come first, then recent projects Claude Code has worked in, each with its git branch. Or choose **Browse…**. |
   | **TASK** | What to do. |
   | **TO** | **New hire** (a new session), or an existing worker in that project who can take orders. |
   | **Model** | Default (your Claude Code model), Opus, Sonnet or Haiku. The row can also list other models Claude Code offers, such as 1M-context ones. |
   | **Effort** | Default, or one of five levels: Low, Med, High, XHigh and Max. Levels the chosen model doesn't support are greyed out, and Haiku doesn't use effort levels. |
   | **Approvals** | **Knock at my door**, **Auto-accept file edits** or **Plan first**. This section starts collapsed, and its label shows the current choice. |

   When you send to an existing office-run worker, Model, Effort and Approvals are locked, because that session already has its own.

3. Read the summary line, which says exactly what will happen, and send with **Ctrl+Enter**.

A new hire walks in from the lift, and you walk over to their desk.

**Auto-accept file edits** covers file edits only. A Bash command, web access or anything outside the project still knocks at your door. Use **Always allow** on that knock if you don't want to be asked again.

### Changing a worker's model, effort or approvals

The header of a worker's case file has Model, Effort and Approvals chips. Click one to change it.

| Worker | What the chips do |
| --- | --- |
| Started from the office | The change applies to the running session from the worker's next turn, not the one in progress. |
| A session no longer running anywhere | The change is kept and used when you continue it. |
| A session busy in another window (Claude Code panel or terminal) | Read-only. Use `/model` or `/effort` in Claude Code instead. |

If the bundled Claude Code is too old to change a running session, the chips say so and go read-only.

### The case file

Click any worker, or their staff row, to open their conversation. It opens in a drawer in a narrow view, and in an editor tab in the [strip layout](#the-strip-layout). It shows your memos, their replies and tool steps such as "Read app.ts" or "Ran: npm test", which you can expand. Each turn shows its cost.

What the reply box does depends on the worker:

| Worker | Reply box |
| --- | --- |
| Started from the office | **Send** (or **Queue** while they're busy) |
| A session no longer running anywhere | **Continue in office** resumes it, on the model it last used |
| A session busy in another window (Claude Code panel or terminal) | Read-only, with **Open in Claude Code** |
| Temps (subagents) | Report to their parent |

**Stop** interrupts the worker's current step. They can still take more instructions afterwards.

### Knocks at your door

When an office-run worker needs permission, it walks to your door and knocks. Click the knock to see a card with exactly what it wants to do: the command, the file edit or the URL. Then choose:

| Option | What happens |
| --- | --- |
| **Approve** | Allows this request. |
| **Always allow** | Adds a rule to that project's `.claude/settings.local.json`. The card shows exactly what will be allowed. |
| **Deny** | Refuses the request, with an optional reason. |

Workers also ask questions and propose plans:

- **Question cards** let you pick an option, choose **Other…**, or **Skip question**.
- **Plan cards** let you **Approve plan**, or **Keep planning** with feedback.

Workers only knock for things Claude Code would normally ask you about. Your existing permission settings still apply.

### Tokens and cost

- Watching the office is free.
- Tasks given from the office run real Claude Code sessions and count toward your Claude usage, just as if you had run them in Claude Code yourself.
- With no model chosen, a new hire uses your Claude Code default model, which may be Opus. Pick Sonnet or Haiku in the **Model** row for lighter work. Plan mode can switch to a larger model.
- **Plan first with Haiku:** when the model is `haiku`, Claude Code does the planning on Sonnet and returns to Haiku after you approve the plan. So a Plan first run costs more than a Haiku run without it.

### Safety, reloading and personal use

- Manager Mode never bypasses permissions. It follows your normal Claude Code permission rules and project settings.
- It refuses to drive a session that is live in another window, because that would mix two conversations.
- Everything stays on your machine, apart from what Claude Code itself sends to Anthropic.
- Office-run workers are child processes of the editor window. Reloading or closing that window stops them, just as it does for the Claude Code panel. Afterwards they show as free, and you can continue them from the office.
- Manager Mode runs Claude Code under your own login, for your own use. Anthropic doesn't allow third-party apps to offer Claude subscription login to other users. If you share this extension, each person should use their own Claude Code setup, and Anthropic's terms apply to them.

## View mode

View mode is a read-only office. It only shows the Claude Code sessions you run yourself, in the terminal or in the IDE, and never runs anything of its own. It suits you if you just want to watch.

- **Turn it on** with **Middle Management: Switch Between View and Manager Mode**, by setting `claudeOffice.mode` to `view`, or with the **Office mode** row on the Front desk's Settings tab. The same command switches back.
- **Hidden:** the icon bar or rail, the staff list and the **+ New task** button. The clock and calendar still show your usage, but only as tooltips.
- **Still there:** the [Front desk](#front-desk). Click the receptionist or the counter to change the look, the staff and the settings, including **Office mode** to go back.
- **Hover tooltips** still work, without "Click to" hints (except on the Front desk, which keeps its hint). A worker who needs you reads "Waiting for you in their Claude Code window"; answer them there. An office-run worker that is still going reads "Switch to manager mode to answer".
- **Switching** reloads the office view and closes any open conversation tabs. If office-run workers are still going when you switch, a message says they keep running and offers **Switch back**. Nothing is stopped.
- **New Task** is refused and the memo never opens. A notification says the office is in view mode, with a **Switch to Manager Mode** button.
- **Background work:** the [usage check](#usage) still runs, under the same `claudeOffice.usageChecks` setting, and so does the [update check](#updates).

## Office tools

The icon bar at the top of the office (a rail down the left in the strip layout) has eleven buttons: six office tools, then a group of five for the props that open your files and Claude Code setup. Use the mouse, or Tab into the bar and move with the arrow keys. Hovering or focusing a button outlines the matching thing in the office. Below 480 px wide, the bar shrinks to a single **Directory** button that lists the rest.

| Button | What it does | In the office |
| --- | --- | --- |
| **In-tray** | Collects finished reports, plans waiting for you, questions and approvals. Open a report to read that turn's output. Each report has **Reply**, **Open case file** and **Mark read** (or **Mark unread**), and **Mark all read** clears the list. The badge reads like "3 unread, some need you": how many items are unread, and whether any of them is blocking a worker. | The tray on the manager's desk |
| **Plans** | Lists recent plans in three groups: waiting for sign-off, approved and sent back. Open one to read it in full and **Approve plan** or **Send back…** with notes. Each plan also stays in the worker's case file with its status. | The whiteboard |
| **Usage** | How much of your Claude plan limits you have used. See [Usage](#usage). | The wall clock and calendar |
| **Front desk** | Opens the [Front desk](#front-desk). | The reception counter |
| **Directory** | Lists the office tools and opens any of them. | The directory board in the lobby |
| **New task** | Opens the memo to [give a task](#giving-a-task). | None |
| **File room** | Browses your project folders, read-only. | The filing cabinets |
| **Training library** | Your skills and slash commands. | The bookshelf |
| **Phone** | Your MCP servers and their status. | The phone on the manager's desk |
| **Office handbook** | Your CLAUDE.md files, project memory and permission rules. | The notice board |
| **Temp agency** | The subagent types you can hire. | The temp agency sign |

You can also click the props themselves, and the Directory lists them all. Characters always take priority over props when you click.

### Usage

- The **clock** has a ring for your 5-hour window: green below 60 % used, amber from 60 % to 84 %, red from 85 %. Hover for the percentage and when it resets.
- The **calendar** shows your weekly window in the same way.
- Click either, or the **Usage** button, to open the Usage panel. It shows each window as a bar with a reset countdown, when it was last updated, and a **Refresh** button. If you use an API key there are no plan windows, so it shows an estimated cost instead, marked "at API prices". These are estimates from token counts, not a bill.
- Each worker's desk has a pile of paper that grows with how much of its context window is used.

How the check works:

- It runs only while the office is visible. When the office is hidden, all its timers stop.
- It checks every 5 minutes. After a failed check it backs off: 5, 10, 20, then 30 minutes.
- **Refresh** checks straight away, but at most once a minute. After a sign-out, checks stay paused until you press Refresh.
- A check uses no tokens. It briefly starts Claude Code with no prompt and no tools, asks for your usage, and closes it.
- The office also reads the usage Claude Code already caches in `~/.claude.json`, and the limits reported by tasks you start from the office. Only the usage figures are kept from that file.
- Set `claudeOffice.usageChecks` to `off` to never start Claude Code for this. The office then shows only the cached and reported figures.

### File room

A read-only browser for your files. Click the filing cabinets, use the **File room** button, or pick it in the Directory.

- It only opens folders you allow: your workspace folders, the folders your workers are in, and projects you've browsed to recently.
- It previews text files and renders markdown (with a **Formatted** / **Plain text** toggle). It never previews binary files, very large files or files that look like secrets (`.env`, keys, credentials and similar), though you can still open those in the editor.
- Links that lead outside the folder you're browsing are refused.
- Claude Code's private files in `~/.claude` (credentials, session keys and history) are never listed or read.

For a file you can **Open in editor**, **Open diff** (against git HEAD, using VS Code's git; the file must be tracked in a git repository) or **Hand to a worker**, which opens the memo with the path filled in. A folder has **Hand this folder to a worker**. When the office is in an editor tab, the editor and the diff open beside it.

### Training library

Your skills and slash commands in one list. Click the bookshelf, or use the **Training library** button.

- Sources are yours, synced, project, plugin and built-in.
- Usage counts come from Claude Code's own records.
- **Use this** opens the memo starting with `/name `, so you only add the task.
- A search box filters the list, and **Open file** opens the item's file in the editor.
- Once you've opened the library, the bookshelf fills up in step with the number of skills.

### Phone

One line per MCP server, with its name, scope, transport, status and how many tools it offers. Click the phone, or use the **Phone** button.

- Status is one of connected, connecting, failed, needs sign-in, off or unknown. For "needs sign-in", sign in with `/mcp` in a Claude Code session.
- It never shows a server's command, settings, environment, headers or URL.
- After you've opened the panel, the phone on the manager's desk shows one light per server.
- claude.ai connectors are listed by name only, with no live status. MCP servers provided by plugins aren't shown yet.

Opening the Phone briefly starts your MCP servers. See [What starts in the background](#what-starts-in-the-background).

### Office handbook

What Claude Code will be told, in one place. Click the notice board, or use the **Office handbook** button. Each item has **Open in editor**.

- **Instructions:** your CLAUDE.md files in the order Claude Code loads them: managed, managed rules, yours, then each folder from the outermost down, with project, `.claude/CLAUDE.md`, rules and local files. You see file names and sizes, never the contents. `AGENTS.md` files aren't listed.
- **Memory:** the project's memory index and its entries, as titles and one-line hooks.
- **Permission rules:** grouped as never allowed, asks first and allowed.

### Temp agency

The subagent types you can hire (built-in, yours, project and plugin agents), with their description, model and tools. Click the temp agency sign, or use the **Temp agency** button. **Hire for a task** opens the memo starting with "Use the ... subagent to ", so you finish the sentence. It has a search box, and **Open file** opens a type's file in the editor.

### Refreshing

The File room reads your disk each time and has its own **Refresh** ("Read this folder again"). The other panels have a **Refresh** button that fetches fresh data; otherwise results are kept for a short while: about a minute for skills and agents, and 30 seconds for the Phone.

## What starts in the background

- **Opening the office starts nothing new.** Only the [usage check](#usage) runs.
- **Training library and Temp agency** start a short Claude Code check in the background. It sends no prompt, uses no tokens, and has hooks and MCP servers switched off.
  - It loads a project's settings only when VS Code trusts the workspace **and** Claude Code has already trusted that folder (you said yes to its trust prompt there).
  - Otherwise it reads only your user settings, and lists the project's own skills and agents by reading their files.
- **Phone** briefly starts your MCP servers to read their status, the same way Claude Code does at the start of a session. It usually stops them within about 8 seconds, and never leaves them running for more than about 20 seconds.
  - It starts your user-scope and local servers and any managed servers.
  - It starts a project's `.mcp.json` servers only when the folder is trusted by both VS Code and Claude Code **and** Claude Code has approved that server.
  - An unapproved project server is never started, and shows as off.
- **The update check** asks GitHub for the latest release about 30 seconds after VS Code starts, then at most once a day. It's a plain request that sends nothing about you. Turn it off with `claudeOffice.updateChecks`. See [Updates](#updates).
- **Theme skill refresh** happens about 5 seconds after start-up. If you installed the theme skill from the Front desk and haven't edited it, the extension quietly updates it in `~/.claude/skills/middle-management-theme/`. It never touches a skill it didn't install, or one you've edited.
- **Logs** record ids, counts and timings only. They never hold paths, file names, skill names or server names.

## Front desk

A receptionist is always at the front desk, even when no sessions are running. She types, takes phone calls and greets each new worker who arrives. Click her or the reception counter to open the Front desk, or use the bell button in the icon bar, the Directory, or **Middle Management: Open Front Desk**.

The Front desk has five tabs.

| Tab | What it does |
| --- | --- |
| **Theme** | Shows where the look comes from (the built-in office, a ready-made office or your own theme file), with the file's path and any problems found in it. On the built-in office you can pick a ready-made office, **Create theme file** or **Choose a file…**. On a ready-made office you can **Make an editable copy…**, switch to another ready-made office, or go **Back to built-in**. On your own file you can **Open in editor**, **Reload**, **Choose another…** or go **Back to built-in**. The tab also has the **Make one with Claude** card (see [Themes](#themes)) and a **Your offices** list of the themes in `~/.middle-management/themes/`, with an **Open themes folder** button. |
| **Settings** | Office mode, company, branch and manager name, speech bubbles, boss quotes, which sessions appear, usage checks and **Check for updates** (Daily or Off). |
| **Staff** | Edit the sign, the manager, the receptionist, the eight staff and the six temps: name, role, pin, lines and look (head, build, outfit, skin and colours), with a larger preview of the look. Values you haven't set show the built-in value, dimmed. **Reset to built-in look** clears a person's own look. |
| **Colours** | Walls and ceiling, the floor of each room, the rug, the chairs, the sign, the furniture, plants, windows and glass, and the lights and outside. **Reset all** goes back to the built-in colours. A warning appears if the sign text is hard to read. |
| **About** | The extension's version, when it last checked for updates, a **Check for updates** button and the check status with a **Change in Settings** link. See [Updates](#updates). |

What is saved where:

- **Settings tab:** each change is saved straight away to your user settings, as the matching `claudeOffice.*` setting. If a workspace setting sets the same option, the workspace value wins; the tab shows a badge and you can't override it from here, but **Change workspace value** lets you edit it. If your theme file sets a name, the theme wins over the setting, and the tab says so.
- **Staff and Colours tabs:** edits show in the office at once but are only a draft. A footer reads "Unsaved changes" with **Save** and **Discard**. **Save** writes your theme file. On the built-in or a ready-made office there's no file yet, so it becomes **Save as…** and then switches to the new file. If the file changed on disk in the meantime, a banner offers **Load it** or **Keep mine**; keeping yours then offers **Overwrite anyway** or **Save as…**. Closing the panel with unsaved changes asks whether to keep editing or discard.
- **Saving rewrites the theme file** in a standard form. See [Saving from the Front desk](themes.md#saving-from-the-front-desk).
- The Front desk never writes to a theme file that a workspace setting points at, and only writes to `.json` files that hold a JSON object.

## Settings

All settings live under `claudeOffice.*` in VS Code's settings.

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeOffice.scope` | `workspace` | Which sessions appear. `workspace` shows only sessions for the current workspace; `all` shows every live Claude Code session on this machine. |
| `claudeOffice.mode` | `manager` | `manager` is the full office. `view` is a read-only office that only shows your own Claude Code sessions. See [View mode](#view-mode). |
| `claudeOffice.sendHomeAfter` | `8` | Hours before an idle worker is sent home automatically. `0` turns it off; the maximum is `720`. Workers with an open conversation tab are never sent home this way. See [Sending a worker home](#sending-a-worker-home). |
| `claudeOffice.companyName` | `Middle Management` | Company name on the wall sign. |
| `claudeOffice.branchName` | `Riverside Branch` | Second line of the wall sign. Leave empty for a one-line sign. |
| `claudeOffice.speechBubbles` | `true` | Show speech bubbles with the file, search or command a worker is using. |
| `claudeOffice.managerName` | `You` | Your name on the manager's tooltip. |
| `claudeOffice.bossQuotes` | `true` | The manager occasionally says a boss-ism. |
| `claudeOffice.usageChecks` | `auto` | `auto` checks your plan usage every 5 minutes while the office is visible (see [Usage](#usage)). `off` never starts Claude Code for this. |
| `claudeOffice.updateChecks` | `auto` | `auto` checks GitHub once a day for a newer release, about 30 seconds after VS Code starts. `off` makes no automatic checks. See [Updates](#updates). |
| `claudeOffice.claudePath` | empty | Full path to the `claude` executable that Manager Mode uses. Leave empty to use the lookup described in [Requirements](#requirements). |
| `claudeOffice.themeFile` | empty | Path to a theme JSON file that names and styles the staff. Leave empty for the built-in office. The six ready-made offices, which you can also pick on the Front desk, are `preset:example`, `preset:spaceship`, `preset:construction-site`, `preset:metalwork-factory`, `preset:cyberpunk` and `preset:steampunk`. See [Themes](#themes). |

## Themes

The office ships with neutral default staff. A theme file lets you rename and restyle them: your own colleagues, friends or any cast you like. It can also change their job titles, everything they say, and the colours of the rooms and furniture. Run **Middle Management: Create Theme File**, edit the names and save; you can also start from the [Front desk](#front-desk). The office updates within a couple of seconds, and the editor checks your typing as you go.

```json
{
  "staff": [
    { "name": "Dana Whitcombe", "role": "Head of Snacks" },
    { "name": "Marta Quill", "role": "Printer Whisperer" }
  ]
}
```

Besides the example office there are five more ready-made offices: Spaceship, Construction Site, Metalwork Factory, Cyberpunk and Steampunk. Each changes the sign, the people and the colours and adds its own small talk, and each is a complete theme you can copy. See [the theme guide](themes.md) for how to pick them.

**Ask Claude to make one.** Claude Code can write a whole theme from a description. Open the Front desk, go to the **Theme** tab and choose **Teach Claude** on the **Make one with Claude** card. That installs a small Claude Code skill in `~/.claude/skills/middle-management-theme/` (under `CLAUDE_CONFIG_DIR` instead, if you set it). It is never installed without your click. Later the card offers **Update**, **Remove**, or **Reinstall…** if you edited it, and **Remove** deletes only the files it installed. Then, in any Claude Code chat, say something like "Make me a Middle Management theme set on a pirate ship where everyone talks like a pirate."

Themes Claude makes are saved in `~/.middle-management/themes/` and appear under **Your offices** on the Theme tab; pick one to switch to it. If you'd rather not add a skill, **Copy a prompt** copies a complete prompt you can paste into a chat instead. See [Ask Claude to make one](themes.md#ask-claude-to-make-one) and [Your offices and the themes folder](themes.md#your-offices-and-the-themes-folder).

Looks, speech (which can replace the built-in lines instead of adding to them), job titles, the cleaner, vendor and IT people, office and furniture colours, the receptionist, pins that tie a project to a desk, and the full list of options are all in [the theme guide](themes.md).

## Privacy in detail

Watching is read-only, and watching itself makes no network calls. It never changes your Claude Code data, and it only polls while the office is visible. Opening the office starts only the usage check, which briefly starts Claude Code with no prompt (see [Usage](#usage)); you can turn that off with `claudeOffice.usageChecks`. Opening the Training library, Temp agency or Phone starts a short Claude Code check, and the Phone briefly starts your MCP servers. See [What starts in the background](#what-starts-in-the-background).

Every 500 ms it reads these local files:

- `~/.claude/projects/<project>/<session>.jsonl`: session transcripts (only the newest part is read)
- `<session>/subagents/`: subagent activity for each session
- `~/.claude/sessions/<pid>.json`: live status files (it never opens the `*.key` files in that folder)
- `~/.claude.json` (every 15 s) and `~/.claude/settings.json` (every 5 s): the usage figures Claude Code caches, and your default model and effort. Only those keys are read.

It respects `CLAUDE_CONFIG_DIR` if you set it.

The office tools read a little more, and only when you open them:

- **Skills, commands and subagent types:** names and descriptions, and usage counts from `~/.claude.json`.
- **File room:** the folders you allow, and a text preview of a file only when you open it.
- **Office handbook:** CLAUDE.md file names and sizes (not their contents), memory titles and one-line hooks, and the text of your permission rules.
- **Phone:** MCP server names, scope, transport and status.

It never reads or shows:

- the contents of your CLAUDE.md files;
- a server's command, settings, environment, headers or URL;
- secret-looking files, binary files or very large files in the File room;
- Claude Code's credentials, session keys or history.

Manager Mode is the one part that does more. It starts Claude Code processes, and only when you give a task. Those processes talk to Anthropic just as Claude Code always does.

The only network call the extension makes itself is the daily update check. It asks GitHub for the latest release and sends nothing about you (see [Updates](#updates)), and you can turn it off with `claudeOffice.updateChecks`. Nothing else is sent anywhere, and there's no telemetry. The extension has no server and opens no port.

## Requirements

- VS Code 1.90 or later, or VSCodium.
- Claude Code, installed and run at least once on the same machine. It writes the files the extension reads.
- For [Manager Mode](#manager-mode): Claude Code installed and logged in on that machine. The extension uses the `claude` executable that ships with the Claude Code VS Code extension, then `~/.local/bin/claude`, then `claude` on your PATH (`claude.exe` on Windows). Set `claudeOffice.claudePath` to use another. The Output panel ("Middle Management") logs which Claude Code version it used, and warns if that differs from the version the extension was built for.
- Linux and Windows are supported. macOS should work (it uses the same code path as Linux) but is untested.

## Installing and updating

1. Download `middle-management-<version>.vsix` from the [latest release](https://github.com/Barniclebazil/middle-management/releases/latest).
2. Open the Extensions view, click the `...` menu and choose **Install from VSIX...**. Or, in a terminal:

   ```sh
   code --install-extension middle-management-<version>.vsix
   # VSCodium:
   codium --install-extension middle-management-<version>.vsix
   ```

You can also build the package yourself (see [Building from source](../README.md#building-from-source)). To update by hand, install a newer `.vsix` the same way; it replaces the old version. Reload the window afterwards.

### Updates

The office checks GitHub for a newer release about 30 seconds after VS Code starts, and then at most once a day. All your VS Code windows share that one check. The request is a plain GET to GitHub's public API. It sends nothing about you, your projects or your Claude Code use. GitHub sees your IP address and a `User-Agent: middle-management/<version>` header, as with any web request.

When a newer version is out, the receptionist says "Post from head office!" and a badge appears on the Front desk. Click it to open a memo from Head Office with three choices:

- **Install now** downloads the `.vsix` from the GitHub release, checks its size and installs it through VS Code, then offers **Reload now**. This works in view mode too.
- **Remind me later** hides the memo for 3 days.
- **Skip this version** hides it until a newer version comes out.

The memo and the About tab also have a **Release notes** link that opens the release page on GitHub in your browser.

The **About** tab on the Front desk shows the version and when the office last checked. Its **Check for updates** button checks now, even with automatic checks off, and so does **Middle Management: Check for Updates**.

If GitHub can't be reached or limits requests, automatic checks stay quiet and try again later. A manual check says what went wrong.

To stop all of this, set `claudeOffice.updateChecks` to `off`, or use the **Check for updates** row (Daily or Off) on the Front desk's Settings tab. On a locked-down network that blocks GitHub, nothing breaks.

### Windows 11 without admin rights

1. Install VS Code with the **User Installer**. It installs to `%LOCALAPPDATA%\Programs` and needs no admin rights. VSCodium also has a user installer and a portable zip.
2. Download the `.vsix` file from the [Releases page](https://github.com/Barniclebazil/middle-management/releases/latest). If GitHub is blocked on that machine, copy the file over another way (OneDrive, email, USB and so on).
3. Open the Extensions view, click `...` and choose **Install from VSIX...**. Or, in a terminal:

   ```bat
   code --install-extension C:\path\to\middle-management-<version>.vsix
   ```

4. Extensions install per user, into `%USERPROFILE%\.vscode\extensions` (VSCodium: `%USERPROFILE%\.vscode-oss\extensions`), so no admin rights are needed.
5. Make sure Claude Code is installed and has run at least once on that machine. It writes to `%USERPROFILE%\.claude`, or wherever `CLAUDE_CONFIG_DIR` points.

Why it should be fine on a locked-down PC: the watching part is plain JavaScript with no native code. It opens no ports and needs no network for the office to work. The optional update check is the only thing that reaches GitHub; if GitHub is blocked, that check just fails quietly, and you can stop it altogether by setting `claudeOffice.updateChecks` to `off`. It starts no processes until you give Manager Mode a task, apart from the usage check, which you can turn off.

**Manager Mode on Windows** needs Claude Code installed on the machine too, and uses that install's `claude.exe`. Corporate antivirus may need to allow it, as it would for Claude Code itself.

**Possible blocker:** IT can restrict extensions with VS Code's `AllowedExtensions` policy (VS Code 1.96 and later). If the install is refused, or the extension shows as disabled, that policy is the likely cause. Ask IT.

### Claude Code in WSL

If Claude Code runs inside WSL, its files are in the Linux home folder (`~/.claude` inside WSL), not in `%USERPROFILE%\.claude`, so an extension running on the Windows side sees an empty office.

To fix this, open the project with VS Code's WSL remote (Remote - WSL, or **WSL: Connect to WSL**) and install Middle Management in WSL. The Extensions view offers **Install in WSL**.

Claude Code running natively on Windows needs nothing special.

## Troubleshooting

**The office is empty.**

- Check that a Claude Code session is running and has written something recently. Sessions idle for more than 30 minutes with no live process are hidden.
- By default the office shows only this workspace's sessions. To see every session on the machine, pick **All sessions** under **Sessions shown** on the Front desk's Settings tab, or set `claudeOffice.scope` to `all`.
- Run **Toggle Demo**. If the demo plays, the view works and the problem is with session detection.
- On Windows with Claude Code in WSL, see [Claude Code in WSL](#claude-code-in-wsl).

**A worker seems stuck.**

- Very fast tool calls stay on screen for a few seconds after they finish, so a worker can look busy briefly after it has moved on.
- A session with no live process and no change to its transcript for 10 minutes is shown as idle.

**The update didn't install.** Open the Output panel and pick **Middle Management** from the dropdown; it says what went wrong. You can always install the `.vsix` by hand (see [Installing and updating](#installing-and-updating)).

**"Could not find the Claude Code program…".** Set `claudeOffice.claudePath` to the full path of `claude` (`claude.exe` on Windows), or install the Claude Code VS Code extension, which ships the executable.

**"Open in another window, so it's read-only here".** That session is live in a Claude Code tab or terminal, and Manager Mode won't drive it alongside. Close that Claude Code tab, or use **Open in Claude Code** to continue there.

**"Demo workers can't take orders".** Demo workers are scripted, so they can't take real tasks. Run **Toggle Demo** again to turn the demo off.

**Logs.** Open the Output panel and pick **Middle Management** from the dropdown.

## Development

The build commands are in the README under [Building from source](../README.md#building-from-source). You need Node 22.18 or later (CI uses Node 24) and npm; the tests run TypeScript directly with Node's built-in type stripping. CI runs the tests on Linux and Windows. Pushing a `v*` tag that matches the version in `package.json` makes GitHub Actions build the `.vsix` and attach it to a release (see `.github/workflows/release.yml`).

**Debugging.** Open the folder in VS Code or VSCodium and press F5 to start an Extension Development Host.

**Art and engine harness.** To work on the art or engine in a normal browser, run:

```sh
npm run build && npm run build:dev
```

Then open `dev/harness.html`. It accepts these URL parameters:

| Parameter | Effect |
| --- | --- |
| `?t=<seconds>` | Jump to a point in the demo loop |
| `?speed=<n>` | Change the playback speed |
| `?freeze=1` | Freeze the scene |
| `?company=<name>` | Set the wall sign text |

There is also a sprite gallery at `dev/sprites.html`.

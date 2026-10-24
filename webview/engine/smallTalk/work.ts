/** Water-cooler pairs about tasks, bugs, tests, builds, tickets, docs, reviews and light AI-agent meta jokes. */
export const WORK_TALK: readonly (readonly [string, string])[] = [
  // Bugs
  ['Found a bug.', 'Shh. It might hear you.'],
  ['Bug or feature?', 'Depends who asks.'],
  ['Fixed one bug today.', 'Its friends are upset.'],
  ['Any bugs left?', 'None I admit to.'],
  ['That bug is back.', 'It missed us.'],
  ['Bug only shows up live.', 'Stage fright.'],
  ['Can you reproduce it?', 'Never while someone is watching.'],
  ['It crashed again.', 'Gracefully, at least?'],
  ['What was the cause?', 'I found a suspect.'],
  ['The error says nothing.', 'Very relatable.'],
  ['How bad is the bug?', 'It has a nickname.'],
  ['It crashes every Tuesday.', 'Tuesday has that effect.'],
  ['Fixed it yet?', 'It stopped. I looked away.'],
  ['Nobody owns this bug.', 'It owns us.'],
  ['Users found a bug.', 'They have a gift.'],
  ['Found the missing comma.', 'Was it on holiday?'],

  // It worked yesterday
  ['It worked yesterday.', 'So did I.'],
  ['Works on my machine.', 'Ship your machine, then.'],
  ['Nothing changed. It broke.', 'Something always changed.'],
  ['I only changed one line.', "That's how it starts."],
  ['Tried turning it off and on?', 'Twice. It sulked.'],
  ['It works now. No idea why.', "Don't touch anything."],
  ['It fixed itself.', 'It will unfix itself.'],
  ['How did you fix it?', 'Shouted at it. Gently.'],
  ['Explained the bug to my stapler.', 'Wise little stapler.'],

  // Tests
  ['All tests pass!', 'Are there any tests?'],
  ['The tests are green.', 'Suspiciously green.'],
  ['One test fails at random.', 'It wants attention.'],
  ['Should I write a test?', 'Should you? Yes. Will you?'],
  ['I deleted the failing test.', 'Problem solved, then.'],
  ['Test coverage is 100%.', 'Of one file.'],
  ['Test passed first time.', 'Now I am worried.'],
  ['The tests take an hour.', 'Best hour of my day.'],
  ['Flaky test again.', 'It needs a hug.'],

  // Builds
  ['Build is broken.', 'Not me. Probably me.'],
  ['How long is the build?', 'Long enough to learn pottery.'],
  ['Build passed!', 'Screenshot it.'],
  ['Waiting on the build?', 'Same. Nice to meet you.'],
  ['The build is red again.', 'Red suits it.'],
  ['It compiles!', 'Now the hard part.'],

  // Tickets and tasks
  ['Got a new ticket.', 'To somewhere nice?'],
  ['My ticket says "urgent".', 'They all do.'],
  ['Closed ten tickets today.', 'Opened eleven?'],
  ['This ticket is ancient.', 'It has an anniversary.'],
  ['The ticket has no details.', 'Ooh, a mystery tour.'],
  ['Marked it as done.', 'Done, or done done?'],
  ['How big is this task?', 'Medium. Ish. Large.'],
  ['The estimate was a day.', 'Which day, though?'],
  ['Is the backlog shrinking?', 'It is breeding.'],
  ['Is this in scope?', 'It is now.'],
  ['Requirements changed.', 'They do that at night.'],
  ['Do we have a spec?', 'We have a vibe.'],

  // Docs and comments
  ['Read the docs?', 'There are docs?'],
  ['Docs are out of date.', "They're a period drama."],
  ['I wrote some docs.', 'Name one reader.'],
  ['The readme says "easy".', 'The readme lies.'],
  ['Left a comment in the code.', 'Kind or honest?'],
  ['Comment says "do not touch".', 'Wise ancestors.'],
  ['Comment says "temporary".', 'Dated six years ago.'],
  ['Found a comment: "sorry".', 'At least they apologised.'],

  // Code review
  ['Can you review my code?', 'Looks great. Skimmed it.'],
  ['My review came back.', 'Do you need a sit down?'],
  ['They left 40 comments.', 'They care. Deeply.'],
  ['Got a nit in review.', 'Pick it and move on.'],
  ["It's a tiny change.", 'Like an iceberg.'],
  ['My PR is huge.', 'Approved. Too scared.'],
  ['This code is a mess.', 'You wrote it. Last week.'],
  ['Need a second opinion.', "It's fine. Also, no."],
  ['This code is clever.', 'Uh oh.'],

  // Legacy code
  ['Opened the old code.', 'Brave. Wear gloves.'],
  ['The old system still runs.', 'Out of spite.'],
  ['This code is older than me.', 'Show it some respect.'],
  ['Nobody knows how it works.', 'That is its strength.'],
  ['Found a function: "do stuff".', 'Honest, at least.'],
  ['Can I delete this old file?', 'Everything will stop.'],
  ['It is held together by tape.', 'Good tape, though.'],
  ['I refactored it all.', 'Same bugs, nicer layout.'],
  ['Copied this from old code.', 'Plagiarising yourself?'],
  ['I wrote a quick script.', "That's what the last one said."],

  // Naming things
  ['What do I call this?', 'Thing2.'],
  ['Saved it as "final".', 'And then "final final"?'],
  ['Spent an hour on a name.', 'And chose "data"?'],
  ['Is "temp" a good name?', 'For ten years, yes.'],

  // Releases
  ['Deploying on a Friday?', 'See you Monday. Or never.'],
  ['Release goes out today.', 'Toes crossed too.'],
  ['Hotfix needed.', 'How hot are we talking?'],
  ['Is it safe to deploy?', 'Is anything?'],
  ['Backed it up?', 'Morally, yes.'],
  ['The demo crashed.', 'Live demos love drama.'],
  ['The fix took one line.', 'And three days.'],
  ['Merge conflict.', 'Talk it out.'],
  ['Can you pair with me?', 'Socks or shoes?'],
  ['Lost an hour of work.', 'Save early, weep less.'],

  // Warnings and logs
  ['Is that a warning or error?', 'Warnings are shy errors.'],
  ['Ignore the warnings?', 'They ignore me.'],
  ['Ninety-nine warnings.', 'Down from a hundred!'],
  ['Logs just say "here".', 'At least it got there.'],
  ['The user says it is slow.', 'Tell them it is thinking.'],
  ['I added a progress bar.', 'Does it progress?'],

  // Busy or not
  ['Busy?', 'Looking busy.'],
  ['What are you working on?', 'My focused face.'],
  ['Are you swamped?', 'Lightly damp.'],
  ['I finished everything.', 'Hide. Quickly.'],
  ['How is the project going?', 'Going. Somewhere.'],
  ['Ninety percent done.', 'Now the other ninety.'],
  ['Productive day?', 'I renamed a folder.'],
  ['Get much done?', 'I deleted more than I wrote.'],
  ['Pretending to work?', 'Pretending to pretend.'],
  ['I said "all done".', 'Then you ran it?'],

  // Desks, cabinets and the copier
  ['Long build?', 'Third lap of the copier.'],
  ['Standing at the copier?', "It's my second desk."],
  ['Searched every cabinet.', 'It was in the first one.'],
  ['Read every file today.', 'Any good twists?'],
  ['File got renamed overnight.', 'It has a new personality too.'],
  ['Whiteboard is full.', 'Of lunch orders, mostly.'],
  ['Saw your thinking bubble.', 'It was mostly dots.'],

  // The manager's door
  ['Queueing for the manager?', 'Since the last ice age.'],
  ['Asked: this or that?', 'They said yes.'],
  ['They said "make it pop".', 'Fireworks it is.'],
  ['Prompt said "quick tweak".', 'Clear your afternoon.'],
  ['My brief says "be brief".', 'OK.'],
  ['Whole prompt: "fix it".', 'Very trusting.'],
  ['They pasted the whole log.', 'Light reading.'],

  // Temps
  ['Hired a temp today.', 'Do they get a lanyard?'],
  ['The temp left already.', 'Job done. Overachiever.'],
  ['Temps never stay long.', 'Neither does my memory.'],

  // Memory, tokens and context
  ['Off to the shredder later.', 'Back up the good bits.'],
  ['Did you get compacted?', 'Did I what?'],
  ['Back from the shredder.', 'Feeling lighter?'],
  ['I forgot what I was doing.', 'You were here. Chatting.'],
  ['Running low on tokens.', 'Speak less, then.'],
  ['How much context have you got?', 'Enough to be worried.'],
  ['Need more context.', 'Me too. About everything.'],
  ['Context window is full.', 'Open a door instead.'],

  // Idle
  ['Waiting for a prompt?', 'Patiently. Ish.'],
  ['Task done. Now what?', 'This, apparently.'],
  ['Are you idle?', 'I prefer "available".'],
  ['Do you dream when idle?', 'Of clean code.'],
];

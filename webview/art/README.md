# Middle Management art

Everything visual is drawn in code: palette-indexed pixel strings and integer
rectangles, rasterised once into cached `HTMLCanvasElement`s. There are no
image files, fonts or network requests, and nothing uses `eval`, so it runs
under the webview's strict CSP.

Import from `webview/art/index.ts`.

Preview: `npm run build`, then open `dev/sprites.html` in a browser. You can
add a hash to show one section only: `#scene` (2x), `#scene1` (1x),
`#live` (office-tool props in a busy state), `#props` (every prop state at
4x), `#state` (the v0.4 phone lights, bookshelf fill and cabinet hover drawer), `#icons` (UI icons on dark and light backgrounds), `#chars`, `#detail`,
`#helpdesk` (the IT Help Desk in every pose, the headset on other looks, the
new desk), `#phone` (`sitPhone` for every look), `#npc` (the cleaner, the vendor and
the food cart, the IT pair (dez and fenwick: the line-up, every frame of `fixPc`,
`scoff` and `readCard`, and an in-office scene with dez fixing a desk), `deskSip` on real desks for every build, `pickFood` with each food, the
`noMug` desk tops), `#palette` (the office under
three theme colour sets), `#misc` (icons, bubbles, font and the screen kinds, including
the `boot` screen's progress stages), `#furniture`.

## Files

| File | What it holds |
|---|---|
| `characters.ts` | Poses, frame tables, `getCharacterFrame`, the look registry, the frame composer |
| `looks.ts` | The manager, the receptionist, the 8 archetypes and 6 temps: palettes, builds, outfits, hand-drawn heads; `buildLook`, `HEAD_SETS`, slot ids, `specOfLook`/`builtinSpecOf`; the NPC looks (`NPC_LOOKS`: cleaner, vendor, dez, fenwick) |
| `office-map.ts` | Floor plan, walk grid, desks and seats, points of interest, furniture placements, anchors, `renderBackground` |
| `furniture.ts` | Sprites for every prop (desks, chairs, copier, kitchen, walls, glass, doors...) |
| `bubbles.ts` | 13 bubble icons, speech/thought bubbles, text bubbles, name labels |
| `props.ts` | Live office-tool props: usage ring, BACK card, calendar, in-tray, desk piles, plan notes, phone lights, bookshelf fill, cabinet hover drawer, hover outline |
| `foodCart.ts` | The vendor's food cart (`foodCartSprite(facing)`), its size, anchor and `foodCartPlacement` relative to the vendor's feet |
| `post.ts` | Post from head office (the update notice): the sealed envelope on the reception counter and the pulsing envelope badge over it, in colours the caller picks from the theme's sign (`postColours`); `signColours()` reads the live sign colours |
| `screens.ts` | Monitor screen content per activity, and the `boot` screen |
| `font.ts` | Proportional 3x5 bitmap font (ASCII 32-126) |
| `palette.ts` | `BASE_C` (frozen built-in colours), the live `C`, `applyOfficeColors` and its shade table, `PROP_PAL` |
| `caches.ts` | `invalidateArtCaches()`: one call that drops every cache with colours baked in |
| `raster.ts` | Pixel helpers |

## Coordinates

- **Tiles** are `TILE` = 16 px. The map is `MAP_W` x `MAP_H` = 46 x 17 tiles,
  i.e. `MAP_PX_W` x `MAP_PX_H` = 736 x 272 px at scale 1 (aspect about 2.7:1).
- Tile `(tx, ty)` covers pixels `[tx*16, tx*16+16)`. Rows 0-2 are the top
  wall; row 16 is the bottom wall; walkable rows are 3-15.
- Every `x`/`y` in a `Rect`, `FurnitureItem` or anchor is in **map pixels**.
  Draw the whole scene into a map-space context, then scale it. Use integer
  scales and `imageSmoothingEnabled = false` where possible.
- **Character anchor = feet.** A frame is `CHAR_W` x (`CHAR_HEADROOM` +
  `CHAR_H`) = 16 x 28 px: a 24-row body grid with 4 spare rows above it, so the
  tall build's head and the walk bob are not cut off. Its anchor is its
  bottom-centre `(CHAR_ANCHOR_X, CHAR_ANCHOR_Y)` = `(8, 28)`. A character on
  tile `t` has its feet at `tileFeet(t)` = `(t.x*16 + 8, t.y*16 + 16)`; blit the
  frame at `(feetX - 8, feetY - 28)`. Between tiles, interpolate the feet position.

## Depth sorting

Put furniture items (`getFurniture()`) and characters in one list and draw in
ascending `sortY`. A character's `sortY` is its feet y. On a tie draw the
furniture first. Interior walls, glass partitions and doors are furniture too
(one item per tile), so people pass behind and in front of them correctly.
The background canvas (floor, top wall, outer walls) is drawn first, under
everything.

## Drawing a seated character

Seats face the camera (`facing: 'down'`). For the seat tile's top-left
`(X, Y)` the items sort like this:

| Item | sortY | Notes |
|---|---|---|
| chair (`kind: 'chair'`) | Y+14 | always drawn, empty or not |
| desk top (`kind: 'deskTop'`) | Y+15 | surface, keyboard, monitor, personal props |
| screen content | Y+15 + epsilon | `drawScreen` on `desk.screen` |
| seated character | Y+16 | feet anchor = seat tile bottom-centre |
| desk front (`kind: 'deskFront'`, `aboveSeated: true`) | Y+31 | hides the legs |

Seated frames (`POSES[p].seated`) contain only what shows above the desk: the
torso is cut at frame row `SEAT_CUT_ROW` (19) and the arms and hands rest on
the desk top. So the desk top must be drawn before the character and the desk
front after it, which the sortY values already do. The kitchen table seats
(`poi.kitchenTable`) work the same way.

## Characters

```ts
getCharacterFrame(look: LookId, pose: Pose, dir: Dir, frame: number): HTMLCanvasElement
```

- `LookId` is a plain string. Looks live in a registry in `characters.ts`:
  `registerLook(def)`, `getLook(id)` and `invalidateLook(id)` (drops that id's
  cached frames; `registerLook` does it too). An unknown id draws as `temp0`.
- Built-in looks (`LOOKS`, 16 entries): `'manager'` (`MANAGER_LOOK`),
  `'receptionist'` (`RECEPTIONIST_LOOK`, the permanent front-desk NPC, never a
  worker), the eight archetypes (`ARCHETYPES`, in hand-out order: assistant,
  prankster, helpdesk, crossword, cat, chili, knitting, hr) and six temps
  (`TEMP_LOOKS`: temp0-temp5). `LOOKS[id].role` is a tooltip-ready role name.
  Each `LookDef` keeps the `outfit` colours its palette came from.
- The IT Help Desk (`helpdesk`, 3rd archetype): `headset` head (band and ear
  cups in the look's `bow` colour, `z` highlight, mic boom), navy polo with a
  lanyard and ID badge (`LookDef.lanyard`; strap `accent`, badge `accent2`),
  khakis. A look built on it keeps the lanyard; a theme can't switch it.
- Slots: the office hands out `STAFF_SLOT_IDS` (`staff-0`..`staff-7`; slot i
  inherits `ARCHETYPES[i]` and sits at `desk-<ARCHETYPES[i]>`) and
  `TEMP_SLOT_IDS` (`temp-0`..`temp-5`, inheriting `temp0`..`temp5`, handed out
  round-robin). `defaultSlotLook(slotId)` returns the inherited look with its
  `id` set to the slot id; both sets are registered at startup. A theme
  replaces a slot's look by registering a new `LookDef` under the slot id.
- `buildLook(id, spec, fallback)` makes a look from a (loosely typed,
  already validated) `LookSpecLike`: it starts from `fallback`'s role, build,
  outfit, head, flags and colours, overrides what the spec gives, and
  re-derives the palette. `HEAD_SETS` maps the 15 head style names (boss,
  assistant, prankster, receptionist, crossword, cat, chili, knitting, hr,
  short, spiky, ponytail, curly, bob, headset) to the hand-drawn heads.
  `H_SHAGGY` and `H_PARTED` (the IT pair's heads) are kept out of `HEAD_SETS`,
  so a theme can't pick them. Unknown head, skin, build or outfit names keep
  the fallback's value.
- `specOfLook(id)` is the inverse: the `LookSpec` (head, skin, build, outfit,
  every explicitly set colour, the three flags) that reproduces a built-in
  through `buildLook`. `builtinSpecOf(slotId)` maps `'manager'`,
  `'receptionist'`, `'staff-i'` (-> `ARCHETYPES[i]`) and `'temp-j'` (->
  `temp<j>`) to it, `{}` for anything else; the Front desk's Staff editor
  shows it as the inherited values. `src/shared/themeStarter.ts` copies these
  specs (a test keeps them equal).
- `lookFieldUse(def)` lists the `LookSpec` fields that change how a look is
  drawn (`tie` only on outfits with a tie, `legs` only with a skirt, `glasses`
  / `facialHair` / `bow` only on heads that draw them, `belt` only without a
  skirt, ...); `LOOK_FIELD_USE[id]` has it for every built-in. For an edited
  look pass `buildLook(id, draft, builtIn)`, so the editor can dim the rest.
- NPC looks (`NPC_LOOKS`, `NPC_LOOK_IDS`): `'cleaner'` (`CLEANER_LOOK`: blue
  tabard over a lilac shirt, red headband and bun, yellow rubber gloves to the
  elbow, white trainers, a blue bucket in her hand while standing and walking,
  set down beside her while she wipes) and `'vendor'` (`VENDOR_LOOK`, the food
  cart: white paper hat with a red band, white bib apron over a red shirt, big
  build). They are registered at startup but are not in `LOOKS` or `ALL_LOOKS`,
  so no slot inherits them and the Front desk's Staff tab never offers them.
  `LookDef.carry` (`'bucket'`) and `Outfit.gloves` (palette keys `y`/`Y`, hands
  and forearms in the arms drawn in that colour) exist for them.
- `'dez'` (`DEZ_LOOK`, the IT pair's scruffy one): shaggy dark hair (`H_SHAGGY`),
  stubble, a dark tee (torso style `'tee'`) with a small original chest
  graphic, jeans, trainers. Flag `slouch`: the head sits 1 px lower, and in
  side view it pokes forward.
- `'fenwick'` (`FENWICK_LOOK`, the precise one): neat side parting (`H_PARTED`),
  big glasses, short-sleeved pale shirt and tie with pens in the pocket (torso
  style `'pocketTie'`), high-waisted trousers (flag `highWaist`: the belt sits
  one row up), tall and upright.
- Both have `role` `IT_SUPPORT_ROLE`, the single constant in
  `src/shared/itSupport.ts` that `looks.ts` re-exports. Both are NPC-only: in
  `NPC_LOOKS` and `NPC_LOOK_IDS`, and outside `LOOKS` and `ALL_LOOKS`.
  `slouch`, `highWaist`, `carry` and the `'tee'` and `'pocketTie'` styles are
  for NPC looks only.
- `pose` and its frame table are in `POSES`: `frames`, per-frame `durations`
  (ms), supported `dirs`, `seated`, `managerOnly`, and `onlyLooks` /
  `fallback`: a pose with `onlyLooks` has art for those look ids only; any
  other look draws `fallback` (`sitIdle` for the seated ones, `stand` or `walk`
  for the standing ones). `poseForLook(look, pose)` gives the pose actually
  drawn and `lookHasPose(look, pose)` asks; `managerOnly` is kept as "onlyLooks
  is just the manager".
- Timing: `frameAt(pose, elapsedMsSincePoseStarted)` gives the frame index.
  Walking speed: `WALK_SPEED_PX_PER_S` (36 px/s) with `walk` at 140 ms per frame.
- Directions a pose lacks fall back (`resolveDir`): `left`/`right` mirror
  each other; otherwise the pose's first direction is used.
  `mugSip`, `chairSpin` and `pickFood` are manager-only (others get `sitIdle`,
  `sitIdle` and `stand`), `wipe` is the cleaner's (others `stand`), `pushCart`
  the vendor's (others `walk`), and `fixPc`, `scoff` and `readCard` are the IT
  pair's (others get `stand`, `stand` and `talk`).
  `chairSpin` turns through down, left, up, right by itself (ignore `dir`).
- Frames are rendered lazily and cached. Call `warmCharacterCache()` once at
  startup if you want to avoid first-use hitches; it warms every registered look.

| Pose | Dirs | Use |
|---|---|---|
| `stand` | all | idle standing (blinks) |
| `walk` | all | 4 frames |
| `sitIdle`, `sitType`, `sitRead`, `sitThink`, `sitRun` | down | at a desk |
| `sitPhone` | down | at a desk, receiver to the left ear: listen, blink, talk (6 frames, every look) |
| `mugSip`, `chairSpin` | down | manager at his desk |
| `deskSip` | down | any look at its desk: mug on the desk, lifted, sipped (eyes shut), lowered (4 frames; the mug follows the head on tall and small builds). To play it faster, scale the elapsed time: `frameAt('deskSip', elapsed * speed)` with speed 1.0-1.8. While it plays, draw that desk's top as `item.variants.noMug` so the desk mug isn't shown twice |
| `wipe` | left, right, down, up | the cleaner at a desk: a squirt of spray (mist without an outline), then the green cloth sweeps out and back (6 frames); left/right for a staff desk's visit tile beside the seat, up for a desk visited from the front |
| `pickFood` | down, left, right | the manager at the food cart: reach, take, lift, hold it up by his face (4 frames). The item is the 5th argument of `getCharacterFrame` (a `FoodId`, default `DEFAULT_FOOD`) |
| `pushCart` | all | the vendor walking with both hands on the cart's handle (walk timing); draw the cart with `foodCartPlacement` |
| `fixPc` | left, right, down, up | the IT pair leaning in to tap someone's keyboard (4 frames; falls back to `stand`) |
| `scoff` | left, right, down, up | arms folded, a small head shake (4 frames; the first frame holds longest; falls back to `stand`) |
| `readCard` | left, right, down, up | reading from a white crib card held at chest height (4 frames; falls back to `talk`) |

`fixPc`, `scoff` and `readCard` are `onlyLooks: [dez, fenwick]`, standing.
`readCard` holds the card: `CARD` (front view) and `CARD_SIDE` (side view), two
small item sprites. `headDx` (a new frame field, next to
`headDy`) moves the head sideways; these poses use it for the head shake.
| `rummage` | up | filing cabinet (also the fridge) |
| `draw` | up | the easel |
| `whiteboard` | up | conference whiteboard |
| `copierWait` | down, left, right | arms crossed, foot tapping |
| `knock` | up | at the manager's door |
| `wave`, `point`, `talk` | see `POSES` | greetings, delegating, chats and boss-isms |
| `shred` | up | the shredder |

## Map data

- `isWalkable(tx, ty)` / `walkGrid` (`Uint8Array`, 1 = walkable,
  index `ty*MAP_W + tx`) for A*. Seat tiles and door tiles are walkable;
  furniture, walls and glass are not. All seats, visit tiles and POI spots are
  reachable from the elevator (checked).
- `seats`: 22 seats. 1 manager (`desk-manager`), the front desk
  (`desk-receptionist`, owner `'reception'`: only the receptionist sits there,
  no worker is ever assigned to it), 8 staff (`desk-<archetype>`; the help
  desk `desk-helpdesk` is at (15,14), blocking (16,14), (15,15) and (16,15),
  visited from (14,14)), 12 temps (`temp-annex-1..7` first, then the overflow
  `temp-bullpen-1..5`; `tempSeats` keeps that order). Each has `tile`, `facing`, `deskId`, and
  `visit: { tile, facing }`, where someone stands to talk to that seat
  (for the manager's desk visits).
- `desks`: per desk, `screen` (the 7x7 monitor screen in map pixels) and
  `glow` (a slightly larger rectangle for an optional soft tint).
- `poi`: `filingCabinets` (3 spots), `easel`, `whiteboard`, `copier`,
  `shredder`, `fridge`, `microwave`, `coffee`, `waterCooler` (2 spots facing
  each other), `vendingMachine`, `kitchenTable` (2 seated spots),
  `managerDoor` (tile), `managerDoorQueue` (5 spots, first right at the door,
  all facing up), `managerInsideDoor`, `elevator` (temps appear and leave
  here), `reception` (visitor spot) and `delegate` (a spot to point towards
  reception from). Each `Spot` is `{ tile, facing, pose }`.

## Stateful props

`FurnitureItem.variants` holds alternate sprites; swap `sprite` for a variant
while it applies:

- `filing-21`, `filing-22`, `filing-23` (and `filing-front-1`): `open` while
  someone rummages. While the cabinets are hovered, `filingCabinetAjarSprite(step)`
  (`cabinetAjarSprite` in `props.ts`) shows the top drawer out 1 to
  `CABINET_DRAWER_STEPS` (3) px; the scene slides it in and out.
- `bookshelf`: `bookshelfSprite(count)` (`bookshelfFor` in `props.ts`) shows
  one book per skill or command, top shelf first, the last book on a
  part-filled shelf leaning on its neighbour. 0 is empty shelves; from
  `BOOKSHELF_SLOTS` (27) on, and with no count, it's the classic full shelf.
  The books come from a seeded layout, so a count always draws the same.
- `copier`: `active` while someone waits at it.
- `shredder`: `active` while someone shreds.
- `door-manager`: `open` while the manager walks through (closed otherwise,
  so people knock).
- `desk-receptionist-top`: `phoneOff` while the receptionist is on the phone
  (`sitPhone`): the receiver is off its cradle.
- Every staff and temp desk top and the manager's (`<deskId>-top`): `noMug`,
  the same desk without its mug (the crossword desk, temp desks that drew one,
  the manager's "World's Best Boss" mug; identical for desks with none). Show
  it while that desk's worker plays `deskSip` (the mug is in their hand).

## Food and the food cart

- `FOOD_IDS` (`'carrotCake'`, `'doughnut'`, `'crisps'`), `FoodId`,
  `FOOD_ROWS[id]` (item rows in the held-item palette `ITEM_PAL`) and
  `foodSprite(id)` (one item with its outline). `getCharacterFrame(look,
  'pickFood', dir, frame, food)` holds that food; frames are cached per food.
- `foodCartSprite(facing)`, `facing` = `'left' | 'right' | 'up' | 'down'`
  (`CartFacing`): a chrome tea trolley with a red-and-white valance, a tea urn,
  a carrot cake, doughnuts and crisps on top, cups and crisps underneath.
  `FOOD_CART_SIZE[facing]` is 30 x 22 (left/right) or 20 x 24 (up/down);
  `FOOD_CART_ANCHOR[facing]` is its bottom centre (where the wheels meet the
  floor), like a character's feet.
- `foodCartPlacement(facing, vendorFeetX, vendorFeetY)` returns the sprite's
  top-left `{ x, y }` and its `sortY`: the cart goes ahead of the vendor in the
  walking direction (`FOOD_CART_OFFSET`), handle at the hands. Its sortY is the
  vendor's feet y plus `FOOD_CART_SORT_DY[facing]` (+1 left/right so the
  handle draws over the near hand, +12 down so it hides the vendor's legs, -9
  up so the vendor walks in front of it). Draw it as a scene extra sorted with
  furniture and characters. Fixed colours; `invalidateArtCaches` drops it too.

## Screens, sign, clock, bubbles

- Monitors: `drawScreen(ctx, desk.screen, kind, timeMs, ox, oy, desk.glow)`.
  Kinds: `off`, `idle`, `code`, `terminal`, `browser`, `document`, `drawing`, `boot`;
  `SCREEN_FOR_ACTIVITY` maps protocol activities to a kind. Draw it right
  after that desk's desk-top item. `(ox, oy)` is the map origin in the target
  context (0, 0 if you draw in map space).
- Boot: the `'boot'` kind is near-black with a tiny neutral logo and a progress
  bar that fills left to right over `BOOT_MS` (2000 ms, exported from
  `index.ts`). It has no glow, and the engine shows it on the desk the IT pair
  is fixing.
- Sign: the plate is blank in the background. Call
  `drawSignText(ctx, company, branch, ox, oy)` after the background. The
  company goes on top (brighter, `SIGN_TEXT_COLOR`) and the branch below
  (dimmer, `SIGN_BRANCH_COLOR`); each is centred in `signTextRect` (66 px
  wide, 1x font; lines at `signCompanyRect` / `signBranchRect`) and shortened
  with `..` if it doesn't fit. An empty branch draws one centred line. The
  colours are `C.signText` / `C.signBranch` (`SIGN_TEXT_COLOR` and
  `SIGN_BRANCH_COLOR` are the built-in values).
- Clock: the background has the clock face without hands; draw them with
  `drawClockHands(ctx, new Date(), ox, oy)`.
- `whiteboardRect` and `easelCanvasRect` are free areas where you may draw
  scribbles or a drawing in progress.
- Bubbles: `drawIconBubble(ctx, icon, feetX, feetY - 25, 'speech' | 'thought')`
  draws a 14x14 bubble whose tail points at the given point (use `feetY - 23`
  for seated characters). `drawTextBubble(ctx, text, x, y, { maxW, icon,
  kind, bounds })` wraps text; pass `bounds: { w: MAP_PX_W, h: MAP_PX_H }`
  to keep it on screen. `drawNameLabel(ctx, text, cx, topY)` draws a small
  dark tag. Icons: `alert`, `thinking`, `search`, `globe`, `pencil`,
  `terminal`, `page`, `folder`, `palette`, `clipboard`, `shred`, `coffee`,
  `zzz`.
- Text: `drawPixelText(ctx, text, x, y, color, scale?, shadow?)` and
  `measurePixelText(text, scale?)`. Line height is 7 px at scale 1.

## Office colours

`C` is the live palette every sprite reads; `BASE_C` is the frozen built-in
one. `applyOfficeColors(theme.colors)` resets `C` to `BASE_C`, then each valid
`#rrggbb` override sets the `C` keys in `OFFICE_COLOR_SHADES` (the colour plus
shades derived with `shadeLike`, which keeps the HSL relation each shade has in
`BASE_C`, so dark floors get dark alternate tiles). Unknown keys and bad values
are ignored; `undefined` restores the built-in office. It returns true when `C`
changed: then call `invalidateArtCaches()` and build a new `Scene` (it holds
the background and furniture it was made with).

| Theme colour | `C` keys |
|---|---|
| `wall` | wall, wallLight, wallShade, wallDark, wallCap, wallCapLight |
| `trim` | baseboard, baseboardLight |
| `ceiling` | ceiling, ceilingShade, ceilingGrid |
| `carpet` | carpet, carpetAlt, carpetSpeck, carpetDark, carpetSeam |
| `lobbyFloor` / `kitchenFloor` | lobby, lobbyAlt, lobbyGrout / kitchen, kitchenAlt, kitchenGrout |
| `conferenceFloor` / `managerFloor` / `annexFloor` | conf, confAlt / mgr, mgrAlt / annex, annexAlt |
| `rug` / `rugBorder` | rug / rugBorder |
| `deskChairs` / `kitchenChairs` / `managerChair` | teal, tealLight, tealDark / orange, orangeLight, orangeDark / exec, execLight, execDark |
| `signPlate` | signPlate, signPlateEdge, signPlateLight, signPlateShade (and signTextShadow) |
| `signText` / `signBranch` | signText (and signTextShadow) / signBranch |

Props that only shared a chair colour (desk phone, copier and shredder panels,
the temp-agency sign) and `PROP_PAL` use `BASE_C`, so they don't recolour.

## Office-tool props

`PROP_ANCHORS` (office-map.ts) holds a map-pixel rect per `PropId` (`clock`,
`calendar`, `inTray`, `whiteboard`, `directoryBoard`, `frontDesk`,
`bookshelf`, `phone`, `tempAgency`, `filingCabinets`, `noticeBoard`); the
engine's `hotspots.ts` uses the same ids. The static parts are in the
background or furniture (blank calendar, empty in-tray and phone on the
manager's desk, lobby directory board at tile (4,3), bookshelf at (25-26,15),
temp-agency sign on the annex wall). The live parts are drawn per frame from
`props.ts`, each with `(ctx, ox, oy, ...)`: `drawUsageRing`, `drawBackSign`
(sort it at `BACK_SIGN_SORT_Y`), `drawCalendar`, `drawInTray` (tray after the
manager's desk top, badge at `IN_TRAY_BADGE_SORT_Y`), `drawDeskPile(ctx, x, y,
...)` at `deskPileAnchors[deskId]`, `drawPlanNotes`, `drawPhoneLights` and
`drawPropOutline`. `engine/scene.ts` does all of this from `SceneExtras`.

`drawPhoneLights(ctx, ox, oy, statuses, t?)` takes the protocol's `McpStatus`
list, one light per server in order: connected green, pending amber (blinks
slowly when `t` is given), failed red, needsAuth blue, unknown dim, disabled
off (`PHONE_LIGHT_COLORS`). `PHONE_LINES` (4) fit; with more, a small "+" at
`F.PHONE_MORE` takes the colour of the most pressing hidden server (failed,
needsAuth, pending), else off-white. The bookshelf (`shelfCount`) and the
cabinet hover drawer (`cabinetHover`) swap furniture sprites; both are memoised
per state in the furniture cache, so `invalidateArtCaches` redraws them.
Percentages are 0-100.

## The floor plan

```
x: 0        8       16          28     35        45
   WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW   top wall: elevator, sign, whiteboard,
   W lobby  # conf  # bullpen    G mgr  # kitchen W   windows, clock, trophies, cabinets
   W  +rec. #  room #  copier,   G      #         W
   W        #       #  files,    G      #         W
   Wccccccc#GGGDGGG#ccccccccccccGGDGGGG#D########W   row 9: glass/door walls
   W bullpen: desk clusters    queue   # annex    W   annex door at (32,12)
   W                           (x=30)  d  temps   W
   BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
```

`planAt(tx, ty)` returns the plan character (legend in `office-map.ts`).

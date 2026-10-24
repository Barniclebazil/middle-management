/**
 * Public entry point for all Middle Management art. See README.md in this folder.
 */
export {
  CHAR_W, CHAR_H, CHAR_HEADROOM, CHAR_ANCHOR_X, CHAR_ANCHOR_Y, WALK_SPEED_PX_PER_S, SEAT_CUT_ROW,
  DIRS, POSES, ALL_POSES, poseCycleMs, frameAt, resolveDir, getCharacterFrame, warmCharacterCache,
  ARCHETYPES, TEMP_LOOKS, ALL_LOOKS, LOOKS, MANAGER_LOOK, RECEPTIONIST_LOOK, STAFF_SLOT_IDS, TEMP_SLOT_IDS, HEAD_SETS,
  buildLook, defaultSlotLook, registerLook, getLook, invalidateLook,
  specOfDef, specOfLook, builtinLookIdOf, builtinSpecOf, lookFieldUse, LOOK_FIELD_USE, LOOK_COLOUR_FIELDS,
  lookHasPose, poseForLook, CLEANER_LOOK, VENDOR_LOOK, DEZ_LOOK, FENWICK_LOOK, IT_SUPPORT_ROLE, NPC_LOOKS, NPC_LOOK_IDS, FOOD_IDS, FOOD_ROWS, DEFAULT_FOOD, foodSprite,
} from './characters.ts';
export type { Dir, Pose, PoseInfo, ArchetypeId, TempLookId, LookId, LookDef, HeadSet, LookSpecLike, FoodId } from './characters.ts';
export {
  FOOD_CART_SIZE, FOOD_CART_ANCHOR, FOOD_CART_OFFSET, FOOD_CART_SORT_DY, foodCartPlacement, foodCartSprite,
} from './foodCart.ts';
export type { CartFacing } from './foodCart.ts';

export {
  TILE, MAP_W, MAP_H, MAP_PX_W, MAP_PX_H,
  planAt, tileToPx, tileFeet, isWalkable, walkGrid,
  seats, desks, tempSeats, seatFor, poi,
  signRect, signTextRect, SIGN_TEXT_COLOR, SIGN_BRANCH_COLOR, signCompanyRect, signBranchRect, drawSignText,
  clockAnchor, drawClockHands, whiteboardRect, easelCanvasRect, calendarRect, inTrayAnchor, phoneAnchor,
  PROP_ANCHORS, deskPileAnchors,
  getFurniture, furnitureIds, renderBackground,
} from './office-map.ts';
export type { TilePos, Rect, Seat, SeatOwner, Desk, Spot, FurnitureItem, PropId, PropAnchor } from './office-map.ts';

export {
  drawUsageRing, drawBackSign, backSignBox, drawCalendar, drawInTray, drawDeskPile, drawPlanNotes, drawPhoneLights, drawPropOutline,
  BACK_SIGN_SORT_Y, IN_TRAY_BADGE_SORT_Y, PHONE_LINES, PHONE_LIGHT_COLORS, PROP_HIGHLIGHT,
  BOOKSHELF_SLOTS, bookshelfFor, drawBookshelf,
  HOVER_CABINET_IDS, DEFAULT_HOVER_CABINET, CABINET_DRAWER_STEPS, CABINET_DRAWER_MS_PER_PX, cabinetAjarSprite,
} from './props.ts';
export type { UsageLevel, PhoneLightState, PlanNoteCounts } from './props.ts';

export { drawScreen, SCREEN_FOR_ACTIVITY, BOOT_MS } from './screens.ts';
export type { ScreenKind } from './screens.ts';

export {
  ICON_IDS, ICON_SIZE, UI_ICON_SIZE, BUBBLE_STYLE, getIcon, getUiIcon, drawBubble, drawIconBubble, drawTextBubble, drawNameLabel, wrapPixelText,
} from './bubbles.ts';
export type { IconId, BubbleKind } from './bubbles.ts';

export {
  BASE_C, C, OFFICE_COLOR_SHADES, applyOfficeColors, currentOfficeColors, isOfficeColor, shadeLike, hexToHsl, hslToHex,
} from './palette.ts';
export type { PaletteKey } from './palette.ts';
export { invalidateArtCaches, artCacheSizes } from './caches.ts';
export { POST_BADGE_RECT, POST_ENVELOPE_RECT, POST_SORT_Y, drawHeadOfficePost, postBadgeSprite, signColours } from './post.ts';
export { drawPixelText, measurePixelText, fitPixelText, FONT_LINE_HEIGHT, FONT_CAP_HEIGHT, FONT_SPACING } from './font.ts';

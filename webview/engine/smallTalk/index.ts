import { CLASSIC_TALK } from './classics.ts';
import { DAYS_TALK } from './days.ts';
import { KITCHEN_TALK } from './kitchen.ts';
import { BUILDING_TALK } from './building.ts';
import { MEETINGS_TALK } from './meetings.ts';
import { WORK_TALK } from './work.ts';
import { LIFE_TALK } from './life.ts';

/** Two-line water-cooler exchanges (an opener and a reply): the classics plus every topic pool. */
export const SMALL_TALK: readonly (readonly [string, string])[] = [
  ...CLASSIC_TALK,
  ...DAYS_TALK,
  ...KITCHEN_TALK,
  ...BUILDING_TALK,
  ...MEETINGS_TALK,
  ...WORK_TALK,
  ...LIFE_TALK,
];

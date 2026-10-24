// The text behind the Front desk's "Copy a prompt" button: a self-contained request a user pastes into any Claude chat
// when they have not installed the Claude Code skill. It points Claude at the shipped schema, guide and example, says
// where to save the theme, and spells out the rules. Pure: no `vscode` import and no file access. The numeric limits
// come from `THEME_LIMITS`, so the prompt cannot drift from what `parseTheme` accepts. Printable ASCII plus newlines only.
import { join } from 'node:path';
import { THEME_LIMITS } from '../shared/theme.ts';

export interface ThemePromptInput {
  /** Where the new theme file is saved (the user's themes folder). */
  themesDir: string;
  schemaPath: string;
  guidePath: string;
  examplePath: string;
}

/** The first line; the user replaces the bracket. */
export const THEME_PROMPT_OPENER = 'Make me a theme for Middle Management that: [describe your office here]';

/** Absolute paths of the shipped files the prompt points Claude at. */
export function themePromptPaths(extensionPath: string): { schemaPath: string; guidePath: string; examplePath: string } {
  return {
    schemaPath: join(extensionPath, 'media', 'theme.schema.json'),
    guidePath: join(extensionPath, 'media', 'theme-guide.md'),
    examplePath: join(extensionPath, 'media', 'themes', 'spaceship.theme.json'),
  };
}

export function themePromptText(input: ThemePromptInput): string {
  const L = THEME_LIMITS;
  return [
    THEME_PROMPT_OPENER,
    '',
    'Middle Management is a VS Code extension that shows Claude Code sessions as pixel-art office workers. A theme is one JSON file (*.theme.json) that can rename the company, the people and their job titles, rewrite everything people say, and change how people look and the colours of the rooms and furniture. The floor plan and the furniture shapes stay the same.',
    '',
    'Please follow these steps.',
    '',
    `1. Read the guide at ${input.guidePath} and the schema at ${input.schemaPath}, and look at the example at ${input.examplePath}.`,
    '2. Ask me at most one question, and only if something major is unclear. Otherwise decide yourself.',
    `3. Save the theme as a new file with an unused kebab-case name, <name>.theme.json, in ${input.themesDir} (create the folder if needed). Never overwrite an existing file unless I asked you to edit it.`,
    `4. Set "name" (${L.name} characters max) and "description" (one sentence, ${L.description} characters max).`,
    `5. For a themed office, set "lineMode": "replace" and fill every line pool listed in the guide, at the guide's suggested counts (a pool holds at most ${L.lines} lines, small talk at most ${L.smallTalk}). Give small talk the most lines. Give titles for every role (${L.title} characters max each), and names and looks for the side characters.`,
    '6. Line rules:',
    '   - plain printable ASCII only, because the pixel font draws anything else as "?";',
    '   - no curly quotes, dashes or emoji;',
    `   - each line about 70 characters or fewer (${L.line} is the hard limit), with no line breaks.`,
    '7. Original material only: no characters, names or catchphrases from TV, film, books or games, and no real people or brands.',
    `8. Colours are #rrggbb. Keep the sign lettering readable on its plate, and the floors distinct from the walls. At most ${L.staff} staff and ${L.temps} temps.`,
    '9. Check the file before you finish: valid JSON, only keys from the schema, valid colours, and lines within the length and count limits. Fix anything that is wrong.',
    '10. Then tell me how to switch to it: click the receptionist (or the bell) to open the Front desk, go to the Theme tab, and pick it under "Your offices".',
    '',
  ].join('\n');
}

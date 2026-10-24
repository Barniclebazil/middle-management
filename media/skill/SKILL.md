---
name: middle-management-theme
description: Make, change or fix a theme for Middle Management, the VS Code extension that shows coding sessions as pixel-art office workers. Use it whenever the user asks for a Middle Management theme or an office theme, such as "make me a theme for Middle Management that is a pirate ship", "turn my office into a bakery", "rename the receptionist", "recolour the office" or "fix my theme file". It writes a .theme.json file in the user's themes folder.
---

# Make a Middle Management theme

A theme is one JSON file that restyles the user's pixel-art office: the sign, names, job titles, every line people say, their looks and the colours. Follow these steps in order.

## 1. Read the reference

Read these three files in this skill's folder before writing anything:

- `guide.md`: what every field does, the line pools and their suggested counts, the writing rules and a checklist.
- `theme.schema.json`: the exact keys and limits.
- `example.theme.json`: a complete themed office to match for depth and quality.

## 2. Pick a direction

Work out the setting, the cast and the tone from the user's request. Ask at most one question, and only if something major is unclear. Otherwise decide yourself and say what you chose at the end.

## 3. New theme

- List `{{THEMES_DIR}}`.
- Choose an unused kebab-case file name, `<name>.theme.json`, that fits the theme. Create the folder if it does not exist.
- Never overwrite an existing file.

## 4. Editing an existing theme

- Find it in `{{THEMES_DIR}}`, or use the path the user gives.
- Change only what was asked. Keep everything else byte-for-byte where possible: same keys, same order, same formatting.

## 5. Write the theme

- Set `name` and `description`.
- For a themed office, set `"lineMode": "replace"` and fill every line pool, plus `smallTalk`, at the suggested counts in `guide.md`.
- Set every title, the staff, and the names and looks of the manager, the receptionist and the side characters.
- Follow the writing rules in `guide.md`: printable ASCII only, about 70 characters or fewer per line, no line breaks, and original material only (no characters, names or catchphrases from existing fiction, no real people or brands).
- Never add a `pin` to a staff entry; keep any pin that is already there.

## 6. Check before finishing

- The file is valid JSON and uses only keys from the schema.
- Every colour is `#rrggbb`, and every count and length limit is respected.
- Run through the checklist at the end of `guide.md`.
- Read the saved file back to confirm it is what you meant to write.

## 7. Tell the user

- The file name, and a one-line summary of the office.
- How to switch to it: click the receptionist (or the bell) to open the Front desk, go to **Theme**, then **Your offices**, then the theme's name. The office updates within a couple of seconds.

---

Installed by Middle Management {{VERSION}}. Edits to this folder are kept, but the extension then stops updating it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, classifyTool, shorten } from '../src/model/activity.ts';

test('classifyTool table', () => {
  const rows: Array<[string, unknown, string, string | undefined]> = [
    ['Read', { file_path: '/a/b/app.ts' }, 'reading', 'app.ts'],
    ['NotebookRead', { notebook_path: '/a/n.ipynb' }, 'reading', 'n.ipynb'],
    ['Grep', { pattern: 'TODO', path: '/x' }, 'searching', '"TODO"'],
    ['Glob', { pattern: 'src/**/*.ts' }, 'searching', 'src/**/*.ts'],
    ['LS', { path: '/home/user/src' }, 'searching', 'src'],
    ['ToolSearch', { query: 'select:Foo' }, 'searching', 'Foo'],
    ['WebSearch', { query: 'vite config options' }, 'researching', 'vite config options'],
    ['WebFetch', { url: 'https://example.com/docs?x=1' }, 'researching', 'example.com'],
    ['mcp__claude-in-chrome__navigate', { url: 'https://example.com/docs' }, 'researching', 'example.com'],
    ['mcp__claude-in-chrome__computer', {}, 'researching', 'computer'],
    ['mcp__foo__web_lookup', {}, 'researching', 'web_lookup'],
    ['mcp__foo__fetch_page', {}, 'researching', 'fetch_page'],
    ['mcp__foo__browser_click', {}, 'researching', 'browser_click'],
    ['Edit', { file_path: '/p/src/a.ts' }, 'writing', 'a.ts'],
    ['MultiEdit', { file_path: '/p/src/a.ts' }, 'writing', 'a.ts'],
    ['Write', { file_path: '/p/src/a.ts' }, 'writing', 'a.ts'],
    ['NotebookEdit', { notebook_path: '/p/n.ipynb' }, 'writing', 'n.ipynb'],
    ['Edit', { file_path: '/p/logo.svg' }, 'drawing', 'logo.svg'],
    ['Artifact', { file_path: '/p/page.html' }, 'drawing', 'page.html'],
    ['mcp__figma__get_node', {}, 'drawing', 'get_node'],
    ['mcp__x__generate_image', {}, 'drawing', 'generate_image'],
    ['mcp__x__create_slide', {}, 'drawing', 'create_slide'],
    ['mcp__x__diagram', {}, 'drawing', 'diagram'],
    ['Bash', { command: 'npm test', description: 'Run the test suite' }, 'running', 'Run the test suite'],
    ['Bash', { command: 'npm test' }, 'running', 'npm test'],
    ['BashOutput', { bash_id: '1' }, 'running', undefined],
    ['KillShell', {}, 'running', undefined],
    ['Monitor', { description: 'watch logs' }, 'running', 'watch logs'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'running', 'Get-ChildItem'],
    ['TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }] }, 'planning', 'Doing B'],
    ['TodoWrite', { todos: [{ content: 'B', status: 'in_progress' }] }, 'planning', 'B'],
    ['Skill', { skill: 'code-review' }, 'planning', 'code-review'],
    ['EnterPlanMode', {}, 'planning', undefined],
    ['ExitPlanMode', { plan: 'x' }, 'planning', undefined],
    ['TaskCreate', { subject: 'Do thing' }, 'planning', 'Do thing'],
    ['TaskUpdate', {}, 'planning', undefined],
    ['Agent', { description: 'Review router' }, 'delegating', 'Review router'],
    ['Task', { description: 'Old style' }, 'delegating', 'Old style'],
    ['SendMessage', { to: 'worker' }, 'delegating', 'worker'],
    ['AskUserQuestion', { questions: [{ header: 'Framework', question: 'Which?' }] }, 'needsYou', 'Framework'],
    ['AskUserQuestion', { questions: [{ question: 'Which one?' }] }, 'needsYou', 'Which one?'],
    ['SomethingNew', {}, 'writing', 'SomethingNew'],
    ['mcp__server__do_stuff', {}, 'writing', 'do_stuff'],
  ];
  for (const [name, input, activity, detail] of rows) {
    const got = classifyTool(name, input);
    assert.equal(got.activity, activity, `${name} activity`);
    assert.equal(got.detail, detail, `${name} detail`);
  }
});

test('drawing versus writing depends on the file extension', () => {
  for (const ext of ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'drawio', 'excalidraw', 'fig', 'SVG']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      assert.equal(classifyTool(tool, { file_path: `/a/b/file.${ext}` }).activity, 'drawing', `${tool} .${ext}`);
    }
  }
  for (const ext of ['ts', 'js', 'json', 'md', 'py', 'txt', 'svg.bak']) {
    assert.equal(classifyTool('Write', { file_path: `/a/file.${ext}` }).activity, 'writing', `.${ext}`);
  }
  assert.equal(classifyTool('Write', { file_path: '/a/svg' }).activity, 'writing');
  assert.equal(classifyTool('Write', { file_path: 'C:\\a\\b\\style.css' }).detail, 'style.css');
});

test('basename handles both separators', () => {
  assert.equal(basename('/a/b/c.ts'), 'c.ts');
  assert.equal(basename('C:\\Users\\alice\\work\\proj'), 'proj');
  assert.equal(basename('C:\\Users\\alice\\work\\proj\\'), 'proj');
  assert.equal(basename('mixed/dir\\file.txt'), 'file.txt');
  assert.equal(basename(''), '');
});

test('details are trimmed to 32 characters with an ellipsis', () => {
  const long = 'x'.repeat(100);
  assert.equal(shorten(long).length, 32);
  assert.ok(shorten(long).endsWith('\u2026'));
  assert.equal(shorten('  short   text\n here '), 'short text here');
  const cases = [
    classifyTool('Read', { file_path: `/a/${long}.ts` }),
    classifyTool('Grep', { pattern: long }),
    classifyTool('WebSearch', { query: long }),
    classifyTool('Bash', { description: long }),
    classifyTool('Agent', { description: long }),
    classifyTool('mcp__s__' + long, {}),
  ];
  for (const c of cases) assert.ok(c.detail !== undefined && c.detail.length <= 32, String(c.detail));
  assert.equal(classifyTool('Grep', { pattern: long }).detail!.startsWith('"'), true);
  assert.equal(classifyTool('Grep', { pattern: long }).detail!.endsWith('"'), true);
  // Bash without a description: first 30 characters of the command.
  const b = classifyTool('Bash', { command: 'a'.repeat(80) }).detail!;
  assert.equal(b, 'a'.repeat(30) + '\u2026');
  assert.equal(classifyTool('Bash', { command: 'ls -la' }).detail, 'ls -la');
});

test('classifyTool never throws on weird input', () => {
  const weird: unknown[] = [undefined, null, 42, 'str', [], [1, 2], { file_path: 42 }, { todos: 'x' }, { questions: 'x' }, { questions: [null] }, { url: {} }, { command: ['a'] }];
  for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Bash', 'TodoWrite', 'Skill', 'Agent', 'AskUserQuestion', 'mcp__a__b', 'Weird', '']) {
    for (const input of weird) {
      const c = classifyTool(name, input);
      assert.equal(typeof c.activity, 'string');
    }
  }
  assert.doesNotThrow(() => classifyTool(undefined as unknown as string, undefined));
  assert.equal(classifyTool('WebFetch', { url: 'not a url' }).activity, 'researching');
});

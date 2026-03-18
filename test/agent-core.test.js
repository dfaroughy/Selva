const assert = require('assert');
const {
  buildDirectMessages,
  buildSystemPrompt,
  createToolkitBlock,
  sliceConversationHistory,
} = require('../lib/agent-core');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n\x1b[1mAgent Core\x1b[0m');

test('sliceConversationHistory keeps the history aligned to a user turn', () => {
  const history = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2-longer' },
    { role: 'assistant', content: 'a2-longer' },
  ];
  const sliced = sliceConversationHistory(history, 'u2-longera2-longer'.length);
  assert.deepStrictEqual(sliced, history.slice(2));
});

test('buildDirectMessages uses bootstrap prompt without conversation history', () => {
  const messages = buildDirectMessages({
    isBootstrap: true,
    bootstrapPrompt: 'bootstrap now',
    prompt: 'ignored',
    conversationHistory: [{ role: 'user', content: 'old' }],
    charBudget: 1000,
  });
  assert.deepStrictEqual(messages, [{ role: 'user', content: 'bootstrap now' }]);
});

test('buildDirectMessages keeps recent turns and appends the prompt', () => {
  const messages = buildDirectMessages({
    isBootstrap: false,
    bootstrapPrompt: '',
    prompt: 'new prompt',
    conversationHistory: [
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'old assistant' },
      { role: 'user', content: 'recent user' },
      { role: 'assistant', content: 'recent assistant' },
    ],
    charBudget: 100,
  });
  assert.strictEqual(messages[messages.length - 1].content, 'new prompt');
  assert.strictEqual(messages[messages.length - 2].content, 'recent assistant');
});

test('createToolkitBlock summarizes only user ecosystem tools', () => {
  const block = createToolkitBlock([
    { name: 'setValue', description: 'Built in', source: '/tmp/builtin' },
    { name: 'special_tool', description: 'User tool', source: '/Users/me/.selva/ecosystem/tools' },
  ]);
  assert.ok(block.includes('special_tool'));
  assert.ok(!block.includes('setValue'));
});

test('buildSystemPrompt injects repo context, schema, state, and additional instructions', () => {
  const prompt = buildSystemPrompt({
    template: 'A\n{{REPO_CONTEXT}}\nB\n{{SCHEMA_BLOCK}}\nC\n{{DASHBOARD_STATE}}\nD',
    repoContext: 'README excerpt',
    schemaBlock: 'schema here',
    stateBlock: 'state here',
    allTools: [
      { name: 'user_tool', description: 'desc', source: '/Users/me/.selva/ecosystem/tools' },
    ],
    additionalPrompt: 'do not miss plots',
    isBootstrap: false,
  });
  assert.ok(prompt.includes('README excerpt'));
  assert.ok(prompt.includes('schema here'));
  assert.ok(prompt.includes('state here'));
  assert.ok(prompt.includes('user_tool'));
  assert.ok(prompt.includes('do not miss plots'));
});

console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) process.exit(1);

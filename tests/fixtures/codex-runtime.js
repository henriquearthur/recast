#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const cdIndex = process.argv.indexOf('--cd');
if (cdIndex >= 0) process.chdir(process.argv[cdIndex + 1]);
const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenario.json'), 'utf8'));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (process.argv.includes('app-server')) {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  if (!scenario.bundledOnly) fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ slug: 'remote-codex' }] }));
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } } : request.method === 'model/list' ? { data: [{ model: 'remote-codex', displayName: 'Remote' }, { model: 'bundled', displayName: 'Bundled' }], nextCursor: null } : {};
    out({ id: request.id, result });
  });
} else {
  let prompt = '';
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(process.cwd(), 'received.json'), JSON.stringify({ args: process.argv.slice(2), prompt }));
    out({ type: 'thread.started', thread_id: 'fake' });
    out({ type: 'item.updated', item: { id: 'text', type: 'agent_message', text: 'Complete' } });
    if (scenario.outcome === 'wait') { setInterval(() => {}, 1000); return; }
    out({ type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'Complete article' } });
    if (scenario.outcome === 'error') out({ type: 'turn.failed', error: { message: 'failure' } });
    else out({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0 } });
  });
}

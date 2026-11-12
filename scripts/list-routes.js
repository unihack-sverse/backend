import { createApp } from '../src/app.js';

// Prints every mounted route; used to generate docs/routes.md.
const app = createApp();
const rows = [];
function mountPath(layer) {
  if (layer.regexp?.fast_slash) return '';
  const match = /^\^((?:\\\/[\w.-]+)+)\\\/\?\(\?=/.exec(layer.regexp?.source ?? '');
  return match ? match[1].replace(/\\\//g, '/') : '';
}
function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) rows.push(`${method.toUpperCase().padEnd(6)} ${prefix}${layer.route.path}`);
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer));
    }
  }
}
walk(app._router.stack, '');
console.log([...new Set(rows)].join('\n'));
process.exit(0);

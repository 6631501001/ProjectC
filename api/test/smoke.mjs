const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const checks = [];
async function check(name, path, expected = 200) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json().catch(() => ({}));
  const pass = response.status === expected;
  checks.push({ name, status: response.status, pass, body });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} - HTTP ${response.status}`);
}

await check('health', '/health');
await check('overview', '/api/overview');
await check('bots', '/api/bots');
await check('orders', '/api/orders');
await check('API docs', '/api/docs');
if (checks.some((entry) => !entry.pass)) process.exitCode = 1;

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// No database needed: the pool only connects on first query.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  DATABASE_SSL: 'false',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'x',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  STORAGE_PROVIDER: 'local',
});

let app;
let spec;
const mounts = {};

before(async () => {
  ({ createApp: app } = await import('../src/app.js'));
  ({ buildOpenApiSpec: spec } = await import('../src/docs/openapi.js'));
  for (const [prefix, file] of [
    ['/auth', 'authRoutes'],
    ['/products', 'productRoutes'],
    ['/categories', 'categoryRoutes'],
    ['/cart', 'cartRoutes'],
    ['/orders', 'orderRoutes'],
    ['/payments', 'paymentRoutes'],
    ['/admin', 'adminRoutes'],
    ['', 'index'],
  ]) {
    mounts[prefix] = (await import(`../src/routes/${file}.js`)).default;
  }
});

function expressRoutes() {
  const routes = [];
  for (const [prefix, router] of Object.entries(mounts)) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

test('every Express route is documented in the OpenAPI spec (and vice versa)', () => {
  const documented = Object.entries(spec().paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
  );
  const actual = expressRoutes();
  assert.deepEqual(
    actual.filter((r) => !documented.includes(r)),
    [],
    'routes missing from src/docs/openapi.js',
  );
  assert.deepEqual(
    documented.filter((r) => !actual.includes(r)),
    [],
    'documented routes that do not exist',
  );
});

test('every $ref points at a defined schema', () => {
  const doc = spec();
  const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) || [];
  for (const r of new Set(refs)) {
    assert.ok(doc.components.schemas[r.split('/').pop()], `undefined schema ${r}`);
  }
});

test('Swagger UI and the JSON spec are served', async () => {
  const api = request(app());
  const json = await api.get('/api/docs.json').expect(200);
  assert.equal(json.body.openapi, '3.0.3');
  const html = await api.get('/api/docs/').expect(200);
  assert.match(html.text, /swagger-ui/);
  // Assets are same-origin files, so they satisfy the Helmet CSP.
  await api.get('/api/docs/swagger-ui-init.js').expect(200);
  await api.get('/api/docs/swagger-ui-bundle.js').expect(200);
});

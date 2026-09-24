import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiSpec } from '../docs/openapi.js';

const router = Router();
const spec = buildOpenApiSpec();

router.get('/docs.json', (req, res) => res.json(spec));
router.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(spec, {
    customSiteTitle: 'De-Jolique Enterprise API',
    swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
  }),
);

export default router;

import { getIntegrationHealth } from '../services/integrationHealth.service.js';

export async function getHealth(req, res, next) {
  try {
    const health = await getIntegrationHealth();
    res.json({ data: health });
  } catch (err) {
    next(err);
  }
}

export default { getHealth };

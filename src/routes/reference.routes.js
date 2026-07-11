import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { adminOnly, requireRoles } from '../middleware/rbac.js';
import { fetchBostaCities, getBostaCitiesFromDb } from '../integrations/bosta/cities.service.js';
import { isBostaConfigured } from '../integrations/bosta/client.js';

const router = Router();

router.use(authenticate);

/** Cities needed by orders managers for manual orders / address edits. */
router.get('/bosta-cities', requireRoles('admin', 'orders_manager', 'stock_manager'), async (req, res, next) => {
  try {
    if (!isBostaConfigured()) {
      return res.json({ data: [], configured: false });
    }

    let cities = await getBostaCitiesFromDb();
    if (!cities.length) {
      cities = await fetchBostaCities();
    }

    res.json({
      data: cities,
      configured: true,
      count: cities.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bosta-cities/sync', adminOnly, async (req, res, next) => {
  try {
    const cities = await fetchBostaCities({ force: true });
    res.json({ data: cities, count: cities.length, synced: true });
  } catch (err) {
    next(err);
  }
});

export default router;

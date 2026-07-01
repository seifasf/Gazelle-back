import notificationService from '../services/notification.service.js';

export async function list(req, res, next) {
  try {
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Number(req.query.limit) || 30;
    const [items, unread] = await Promise.all([
      notificationService.listForUser(req.user, { limit, unreadOnly }),
      notificationService.unreadCount(req.user),
    ]);
    res.json({ data: { items, unread } });
  } catch (err) {
    next(err);
  }
}

export async function unreadCount(req, res, next) {
  try {
    const unread = await notificationService.unreadCount(req.user);
    res.json({ data: { unread } });
  } catch (err) {
    next(err);
  }
}

export async function markRead(req, res, next) {
  try {
    const unread = await notificationService.markRead(req.params.id, req.user);
    res.json({ data: { unread } });
  } catch (err) {
    next(err);
  }
}

export async function markAllRead(req, res, next) {
  try {
    await notificationService.markAllRead(req.user);
    res.json({ data: { unread: 0 } });
  } catch (err) {
    next(err);
  }
}

export default { list, unreadCount, markRead, markAllRead };

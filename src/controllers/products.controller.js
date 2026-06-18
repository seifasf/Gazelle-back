import * as productService from '../services/product.service.js';

export async function listProducts(req, res, next) {
  try {
    const result = await productService.listProducts(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateCogs(req, res, next) {
  try {
    const variant = await productService.updateVariantCogs(
      req.params.variantId,
      req.body.cogs,
      req.user._id
    );
    res.json({ data: variant });
  } catch (err) {
    next(err);
  }
}

export async function addCogsBatch(req, res, next) {
  try {
    const batch = await productService.addCogsBatch({
      ...req.body,
      variantId: req.params.variantId,
      userId: req.user._id,
    });
    res.json({ data: batch });
  } catch (err) {
    next(err);
  }
}

export default { listProducts, updateCogs, addCogsBatch };

/**
 * Lazily loaded screens. The reader (engine glue, panels, typography) and the
 * less-visited pages stay out of the entry chunk so Library paints first;
 * the same importers warm the chunks ahead of navigation.
 */
export const loadReader = () => import('./reader');
export const loadArticle = () => import('./article');
export const loadBook = () => import('./book');
export const loadSettings = () => import('./settings');

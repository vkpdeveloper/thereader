import { useCallback } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArticleRow } from '../components/ArticleRow';
import { IconButton } from '../components/buttons';
import { ShelfScene, hueStyle } from '../components/categories/Bookcase';
import { categoryActions, useDeleteCategory } from '../components/categories/categoryActions';
import { useCategoryDialog } from '../components/categories/CategoryDialog';
import { articleRef, bookRef, describeCount, useCategoryContents } from '../components/categories/model';
import { ChevronLeftIcon, MoreHorizIcon } from '../components/icons';
import { ContextMenu, menuPoint, useContextMenu, type MenuPoint } from '../components/overlay';
import { useRemoveArticle } from '../components/RemoveArticle';
import { useRemoveBook } from '../components/RemoveBook';
import { Eyebrow, LoadingLine, StateMessage } from '../components/states';
import { useToast } from '../components/toast';
import { useDocumentTitle, useElementWidth } from '../lib/hooks';
import { useServices, useStore } from '../lib/services/react';
import type { ArticleSummary, LibraryEntry } from '../lib/types';
import { articleActions, columnsFor, entryActions, GridItem } from './library';

/**
 * One category: its books in the Library's cover grid and its articles in the
 * same rows, newest filed first, with the same menus. The header renames,
 * recolours and deletes it.
 */
export function CategoryScreen() {
  const { id } = useParams({ from: '/shell/library/category/$id' });
  const services = useServices();
  const lib = useStore(services.library);
  const contents = useCategoryContents();
  const navigate = useNavigate();
  const toast = useToast();
  const menu = useContextMenu();
  const removal = useRemoveBook();
  const articleRemoval = useRemoveArticle();
  const filing = useCategoryDialog();
  const deletion = useDeleteCategory(() => void navigate({ to: '/library' }));
  const [grid, gridWidth] = useElementWidth<HTMLDivElement>();
  const category = contents.categories.find((c) => c.id === id);
  useDocumentTitle(category?.name ?? 'Category');

  const showMenu = menu.show;
  const askRemove = removal.ask;
  const askRemoveArticle = articleRemoval.ask;
  const fileMenu = filing.menuItems;
  const openMenu = useCallback(
    (entry: LibraryEntry, at: MenuPoint) => {
      const filingItems = fileMenu({ ...bookRef(entry), title: entry.book.title });
      showMenu({ ...at, label: entry.book.title, items: entryActions(services, entry, navigate, askRemove, filingItems) });
    },
    [services, navigate, showMenu, askRemove, fileMenu],
  );
  const openArticleMenu = useCallback(
    (article: ArticleSummary, at: MenuPoint) => {
      const filingItems = fileMenu({ ...articleRef(article), title: article.title });
      showMenu({ ...at, label: article.title, items: articleActions(article, navigate, askRemoveArticle, toast.show, filingItems) });
    },
    [navigate, showMenu, askRemoveArticle, toast.show, fileMenu],
  );

  const back = (
    <Link to="/library" className="category-back t-label-md">
      <ChevronLeftIcon size={16} />
      Library
    </Link>
  );

  if (!contents.loaded || !lib.loaded) {
    return (
      <div className="page-wide">
        {back}
        <LoadingLine />
      </div>
    );
  }

  if (!category) {
    return (
      <div className="page-wide">
        {back}
        <StateMessage
          title="This category is gone."
          body="It was deleted, maybe on another device. Its books and articles are back in your Library."
          actionLabel="Back to Library"
          onAction={() => void navigate({ to: '/library' })}
        />
      </div>
    );
  }

  const items = contents.items.get(category.id) ?? [];
  const books = items.flatMap((i) => (i.type === 'book' ? [i.entry] : []));
  const articles = items.flatMap((i) => (i.type === 'article' ? [i.article] : []));
  const columns = columnsFor(gridWidth || 360);
  const actions = categoryActions(category, { edit: filing.edit, askDelete: deletion.ask });

  return (
    <div className="page-wide category-page" style={hueStyle(category.color)}>
      {back}
      <header className="category-header">
        <button
          type="button"
          className="category-header-dot"
          aria-label={`Change colour of ${category.name}`}
          data-tooltip="Change colour"
          onClick={() => filing.edit(category, 'color')}
        />
        <h1 className="t-display-lg category-title" onDoubleClick={() => filing.edit(category, 'name')}>
          {category.name}
        </h1>
        <IconButton
          icon={MoreHorizIcon}
          label="Category actions"
          aria-haspopup="menu"
          tooltipSide="left"
          onClick={(e) => showMenu({ ...menuPoint(e, 'below'), label: category.name, items: actions })}
        />
      </header>
      <p className="t-body-sm category-count tabular">{describeCount(items)}</p>
      <hr className="divider category-divider" />
      {items.length === 0 ? (
        <div className="category-empty">
          <ShelfScene items={[]} color={category.color} className="is-empty-state" />
          <StateMessage
            title={`Nothing in ${category.name} yet.`}
            body={`Right-click a book or article in your Library and choose “Add to”, or drag its cover onto ${category.name} in the sidebar.`}
            tone="var(--cat)"
            actionLabel="Go to Library"
            onAction={() => void navigate({ to: '/library' })}
          />
        </div>
      ) : (
        <>
          <div
            ref={grid}
            className="library-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            hidden={books.length === 0}
          >
            {books.map((entry) => (
              <GridItem key={entry.id} entry={entry} readable={services.library.canRead(entry.id)} onMenu={openMenu} />
            ))}
          </div>
          {articles.length > 0 && (
            <section className="library-articles" aria-label="Articles">
              {books.length > 0 && <Eyebrow as="h2">Articles</Eyebrow>}
              <ul className="article-list">
                {articles.map((a) => (
                  <ArticleRow key={a.id} article={a} onMenu={openArticleMenu} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <ContextMenu request={menu.request} onClose={menu.close} />
      {removal.dialog}
      {articleRemoval.dialog}
      {filing.dialog}
      {deletion.dialog}
    </div>
  );
}

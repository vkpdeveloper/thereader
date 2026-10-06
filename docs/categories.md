# Categories

Categories are named, coloured groups you sort your library into, such as
"Programming" or "Philosophy". Books and saved articles can both go in one.
An item is in **at most one** category. Items in a category are shown only
inside it. The Library home shows uncategorized items, plus one "bookcase"
tile per category.

Categories and memberships sync through the existing scheduled `/v1/sync`
request, in the same durable outbox as books, highlights and articles. They
add no request of their own (see [cloud sync](cloud-sync.md); free plan).

## Colours

There are twelve semantic keys, each with one hue. The hues are tuned for the
pure-black palette and are the same on both clients. Unknown keys from a newer
build render as `gray`.

| key      | hex       | key      | hex       |
| -------- | --------- | -------- | --------- |
| `red`    | `#ff6166` | `teal`   | `#2dd4bf` |
| `orange` | `#ff9907` | `cyan`   | `#1da9b0` |
| `amber`  | `#f5c518` | `blue`   | `#52a8ff` |
| `lime`   | `#a3e635` | `indigo` | `#818cf8` |
| `green`  | `#62c073` | `purple` | `#c472fb` |
| `pink`   | `#f75f8f` | `gray`   | `#a1a1a1` |

The picker shows them in this order: red, orange, amber, lime, green, teal,
cyan, blue, indigo, purple, pink, gray. The default for a new category is the
first colour that no live category uses yet, or `blue` if all of them are in use.

## Identity

- **Category id:** a client-generated UUID (lowercase, v4).
- **Item reference:** `{itemType, itemId}`.
  - Books use `itemType: "book"` and `itemId` = the book's id (`Book.id`,
    which is the catalog id or `epub-<sha256>` for imports). This is the same
    `bookId` that sync uses for library membership.
  - Articles use `itemType: "article"` and `itemId` = the 32-hex article id.
- Locally, an assignment is keyed `"<itemType>:<itemId>"`.

## Sync wire format

Both change kinds use the sentinel edition `bookId: "_categories"`,
`sha256` = 64 zeros. This is the same pattern that articles use with
`_articles`.

### `category` change

```json
{ "categoryId": "3f2c…", "name": "Programming", "color": "blue",
  "createdAt": "2026-10-07T10:00:00.000Z", "deleted": false }
```

A tombstone is `{ "categoryId": "3f2c…", "deleted": true }`.

- `name` is trimmed, 1–60 characters, and contains no control characters.
  Names do not need to be unique. Clients warn about a duplicate name but
  still allow it.
- `color` matches `^[a-z]{1,20}$`. The server does not check it against the
  list of twelve colours, so it stays forward compatible.
- Renames and recolours use last-write-wins by `(updatedAt, change id)`.
- **Tombstones are final.** After the server stores a tombstone, it ignores
  any later non-deleted write for that `categoryId`. A deleted category
  cannot come back.

### `categoryItem` change

```json
{ "itemType": "book", "itemId": "epub-ab12…", "categoryId": "3f2c…" }
```

- `categoryId: null` removes the item from its category, so it shows in the
  Library home again.
- Writes use last-write-wins by `(updatedAt, change id)` on the row keyed by
  `(itemType, itemId)`.
- `itemId` uses the existing book id pattern (at most 128 characters) for
  books and `^[0-9a-f]{32}$` for articles.
- The server does not check that the category exists. A client treats an
  assignment to a deleted or unknown category as **uncategorized**.

### Pull

The request body adds `categoriesSince: null | number`. `null` means the full
set; otherwise, send the last `cursor` you received. Requests without
`categoriesSince` get the old response shape and cost no extra D1 reads.

```json
"categories": {
  "items": [{ "id": "3f2c…", "name": "Programming", "color": "blue",
              "createdAt": "…", "updatedAt": "…", "deleted": false, "rev": 41 }],
  "assignments": [{ "itemType": "book", "itemId": "epub-ab12…",
                    "categoryId": "3f2c…", "updatedAt": "…", "rev": 42 }],
  "cursor": 42,
  "more": false
}
```

- Categories and assignments share **one** rev sequence. Every accepted write
  to either table gets the next rev.
- A response has at most 500 rows in total, ordered by rev and including
  tombstones. When `more` is true, the client pulls again from `cursor`.
- Older servers reject a batch that contains these kinds. Clients then resend
  the batch without category changes and retry category sync six hours later,
  as they already do for articles and highlights.
- Deleting a category does not rewrite its assignments. Clients ignore them
  because the category is gone, so its items show in the Library home again.
  When the client that deletes a category also has the items, it queues
  `categoryId: null` for each of them. This keeps the stored state tidy.

## Client behaviour (both apps)

- **Library home** shows uncategorized items in the grid. A **Categories**
  section above the grid shows one bookcase tile per category: the three
  newest items stand like books on a shelf, tinted with the category colour,
  above the category's name and item count. On hover (web) or press (mobile),
  the books fan out like the petals of a flower opening. They rotate from a
  shared pivot at the bottom and lift slightly. They do not fly out of the
  tile. The animation respects `prefers-reduced-motion` and the platform's
  reduced-motion setting.
- **Continue reading** may show an item from any category. It is about where
  you left off, not where the item is filed.
- **Category view** shows the category's items, newest assignment first. You
  can rename it, recolour it and delete it. Deleting a category asks for
  confirmation, keeps the items and moves them back to the Library home.
- **Add to…** opens from an item's context menu: right-click on web, or long
  press or the more-actions menu on mobile.
  - If there are no categories yet, the dialog starts at the **create** step:
    a name field and the twelve colour swatches, then Create.
  - The new category is then selected in the **picker** step. The picker
    lists the categories, each with its colour dot, name and item count. The
    current one is marked, and the last row is "New category…".
  - Choosing a category assigns the item and closes the dialog with a toast
    such as "Added to Programming". An item already in a category shows
    **Move to…** and also offers **Remove from category**.
- **Web sidebar** lists the categories under the destinations, each with its
  colour dot and count, and links to its category view. The sidebar can be
  collapsed to an icon rail with a toggle button. This state is stored in
  `localStorage` (`thereader.sidebarCollapsed`) and restored before first
  paint, so a refresh keeps it. It is device-local and never synced.
- **Mobile** has no sidebar. The Categories section on the Library screen is
  the entry point.

# A Field Guide to HTML Structure

Readers care about structure even when they never think about it. Lists, tables and notes carry meaning that a wall of text cannot, so an extractor has to keep them intact.[^1]

## Lists

3. Third step: measure twice.
4. Fourth step: cut once.
   - Use a sharp blade.
   - Mind your fingers.

- [x] Write the draft
- [ ] Edit the draft

## Tables

Median page weight by year

| Year | Desktop (KB) | Mobile (KB) |
| --- | --: | --: |
| 2015 | 2,099 | 1,060 |
| 2020 | 2,124 | 1,914 |
| Source: HTTP Archive |  |  |

## Definitions

**Boilerplate**

Navigation, ads and footers that repeat on every page.

**Main content**

The text the page exists to deliver.

**Why not just use the largest block of text?**

Because comment sections and footers are often longer than the article itself, and because articles split across several containers.

> [!WARNING]
> Layout tables are not data tables. Treat them as containers, never as grids.

This paragraph lives inside a layout table, the way many older sites were built, and it should read as plain prose.

Old pages also separate paragraphs with line breaks instead of paragraph tags.

The extractor splits those into real paragraphs.\
A single break stays a line break.

---

### Math

Euler's identity $e^{i\pi}+1=0$ links five constants.

$$
a^2+b^2=c^2
$$

Words like HTML, “quoted speech”, H2O, x2, highlights, ~~mistakes~~ and underlines keep their marks.

[^1]: Structure is also what screen readers rely on.

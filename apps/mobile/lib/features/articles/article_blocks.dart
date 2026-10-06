import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:thereader_extract/thereader_extract.dart';

import '../../core/theme/tokens.dart';
import 'article_code.dart';
import 'article_media.dart';
import 'article_style.dart';
import 'article_text.dart';

/// Draws one block of the article model with native widgets.
class BlockView extends StatelessWidget {
  const BlockView({super.key, required this.block, this.depth = 0});

  final Block block;

  /// List nesting depth, for bullet shapes.
  final int depth;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final style = scope.style;
    final colors = style.colors;
    switch (block) {
      case HeadingBlock(:final level, :final content):
        return Semantics(header: true, child: ArticleText(content, style: style.heading(level)));
      case ParagraphBlock(:final content):
        return ArticleText(content, style: style.body, textAlign: style.align);
      case ListBlock list:
        return _ListView(list: list, depth: depth);
      case QuoteBlock(:final blocks, :final cite, :final pull):
        if (pull == true) {
          return Container(
            padding: EdgeInsets.symmetric(vertical: style.fontSize * 0.8),
            decoration: BoxDecoration(
              border: Border.symmetric(horizontal: BorderSide(color: colors.border)),
            ),
            child: scope.restyled(
              style.derive(scale: 1.25, italic: true),
              BlockColumn(blocks: blocks, align: TextAlign.center),
            ),
          );
        }
        return Container(
          padding: EdgeInsetsDirectional.only(start: style.fontSize * 0.9),
          decoration: BoxDecoration(
            border: BorderDirectional(start: BorderSide(color: colors.borderActive, width: 2)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              scope.restyled(style.derive(italic: true, ink: colors.muted), BlockColumn(blocks: blocks)),
              if (cite != null) ...[
                SizedBox(height: style.innerGap),
                ArticleText([const TextRun('— '), ...cite], style: style.caption),
              ],
            ],
          ),
        );
      case CodeBlock code:
        return CodeBlockView(block: code);
      case FigureBlock figure:
        return FigureView(figure: figure);
      case VideoBlock video:
        return VideoFacade(video: video);
      case AudioBlock audio:
        return AudioCard(audio: audio);
      case EmbedBlock embed:
        return EmbedCard(embed: embed);
      case TableBlock table:
        return _TableView(table: table);
      case RuleBlock():
        return Padding(
          padding: EdgeInsets.symmetric(vertical: style.fontSize * 0.6),
          child: Center(child: Text('·  ·  ·', style: style.body.copyWith(color: colors.subtle, letterSpacing: 4))),
        );
      case MathBlock(:final tex, :final text):
        final fallback = Text(text, style: style.body.copyWith(fontStyle: FontStyle.italic), textAlign: TextAlign.center);
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: MediaQuery.sizeOf(context).width - style.gutter * 2),
            child: Center(
              child: tex == null
                  ? fallback
                  : Math.tex(tex, textStyle: style.body.copyWith(height: 1), onErrorFallback: (_) => fallback),
            ),
          ),
        );
      case DefinitionListBlock(:final items):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) SizedBox(height: style.innerGap),
              ArticleText(items[i].term, style: style.body.copyWith(fontWeight: FontWeight.w700)),
              Padding(
                padding: EdgeInsetsDirectional.only(start: style.fontSize * 1.2, top: 2),
                child: BlockColumn(blocks: items[i].details),
              ),
            ],
          ],
        );
      case DetailsBlock details:
        return _DetailsView(details: details);
      case CalloutBlock callout:
        return _CalloutView(callout: callout);
      case FootnotesBlock(:final items):
        return _FootnotesView(items: items);
    }
  }
}

/// Nested blocks with the inner rhythm.
class BlockColumn extends StatelessWidget {
  const BlockColumn({super.key, required this.blocks, this.depth = 0, this.align});

  final List<Block> blocks;
  final int depth;

  /// Overrides paragraph alignment (pull quotes centre their text).
  final TextAlign? align;

  @override
  Widget build(BuildContext context) {
    final style = ArticleScope.of(context).style;
    return Column(
      crossAxisAlignment: align == TextAlign.center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < blocks.length; i++) ...[
          if (i > 0) SizedBox(height: blocks[i] is HeadingBlock ? style.gap : style.innerGap),
          if (align != null && blocks[i] is ParagraphBlock)
            ArticleText((blocks[i] as ParagraphBlock).content, style: style.body, textAlign: align)
          else
            BlockView(block: blocks[i], depth: depth),
        ],
      ],
    );
  }
}

class _ListView extends StatelessWidget {
  const _ListView({required this.list, required this.depth});

  final ListBlock list;
  final int depth;

  static const _bullets = ['•', '◦', '▪'];

  @override
  Widget build(BuildContext context) {
    final style = ArticleScope.of(context).style;
    final colors = style.colors;
    final start = list.start ?? 1;
    final markerWidth = style.fontSize * (list.ordered ? 1.9 : 1.3);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < list.items.length; i++) ...[
          if (i > 0) SizedBox(height: style.fontSize * 0.4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              SizedBox(
                width: markerWidth,
                child: switch (list.items[i].checked) {
                  final checked? => Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: Icon(
                        checked ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
                        size: style.fontSize * 1.05,
                        color: checked ? colors.primary : colors.subtle,
                        semanticLabel: checked ? 'Done' : 'Not done',
                      ),
                    ),
                  null => Text(
                      list.ordered ? '${start + i}.' : _bullets[depth % _bullets.length],
                      style: style.body.copyWith(
                        color: colors.muted,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                },
              ),
              Expanded(child: BlockColumn(blocks: list.items[i].blocks, depth: depth + 1)),
            ],
          ),
        ],
      ],
    );
  }
}

class _TableView extends StatelessWidget {
  const _TableView({required this.table});

  final TableBlock table;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final style = scope.style;
    final colors = style.colors;
    final cellStyle = style.body.copyWith(fontSize: style.fontSize * 0.86, height: 1.4);
    final headerRows = table.headerRows ?? 0;
    final grid = <List<TableCellData?>>[];
    final pending = <int, int>{};
    for (final row in table.rows) {
      final cells = <TableCellData?>[];
      var column = 0;
      void fillSpans() {
        while ((pending[column] ?? 0) > 0) {
          pending[column] = pending[column]! - 1;
          cells.add(null);
          column++;
        }
      }

      for (final cell in row.cells) {
        fillSpans();
        final span = (cell.colspan ?? 1).clamp(1, 50);
        for (var s = 0; s < span; s++) {
          cells.add(s == 0 ? cell : null);
          if ((cell.rowspan ?? 1) > 1) pending[column] = cell.rowspan! - 1;
          column++;
        }
      }
      fillSpans();
      grid.add(cells);
    }
    final columns = grid.fold<int>(0, (m, r) => r.length > m ? r.length : m);
    if (columns == 0) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (table.caption != null) ...[
          ArticleText(table.caption!, style: style.caption),
          const SizedBox(height: Space.sm),
        ],
        Container(
          decoration: BoxDecoration(
            border: Border.all(color: colors.border),
            borderRadius: const BorderRadius.all(Radii.sm),
          ),
          child: ClipRRect(
            borderRadius: const BorderRadius.all(Radii.sm),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Table(
                defaultColumnWidth: const IntrinsicColumnWidth(),
                defaultVerticalAlignment: TableCellVerticalAlignment.top,
                border: TableBorder(
                  horizontalInside: BorderSide(color: colors.border),
                  verticalInside: BorderSide(color: colors.border),
                ),
                children: [
                  for (var r = 0; r < grid.length; r++)
                    TableRow(
                      decoration: r < headerRows ? BoxDecoration(color: colors.panel) : null,
                      children: [
                        for (var c = 0; c < columns; c++)
                          _cell(c < grid[r].length ? grid[r][c] : null, r < headerRows, cellStyle),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _cell(TableCellData? cell, bool headerRow, TextStyle style) {
    if (cell == null) return const SizedBox.shrink();
    final header = headerRow || cell.header == true;
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 48, maxWidth: 280),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: ArticleText(
          cell.content,
          style: header ? style.copyWith(fontWeight: FontWeight.w700) : style,
          textAlign: switch (cell.align) {
            CellAlign.center => TextAlign.center,
            CellAlign.right => TextAlign.end,
            CellAlign.left || null => TextAlign.start,
          },
        ),
      ),
    );
  }
}

class _DetailsView extends StatefulWidget {
  const _DetailsView({required this.details});

  final DetailsBlock details;

  @override
  State<_DetailsView> createState() => _DetailsViewState();
}

class _DetailsViewState extends State<_DetailsView> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final style = ArticleScope.of(context).style;
    final colors = style.colors;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: colors.border),
        borderRadius: const BorderRadius.all(Radii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _open,
            child: InkWell(
              onTap: () => setState(() => _open = !_open),
              borderRadius: const BorderRadius.all(Radii.md),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 10, 14, 10),
                child: Row(
                  children: [
                    AnimatedRotation(
                      turns: _open ? 0.25 : 0,
                      duration: Motion.of(context, Motion.fast),
                      child: Icon(Icons.chevron_right, size: 20, color: colors.muted),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: ArticleText(widget.details.summary, style: style.body.copyWith(fontWeight: FontWeight.w700)),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: Motion.of(context, Motion.base),
            curve: Motion.curve,
            alignment: Alignment.topCenter,
            child: _open
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                    child: BlockColumn(blocks: widget.details.blocks),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class _CalloutView extends StatelessWidget {
  const _CalloutView({required this.callout});

  final CalloutBlock callout;

  @override
  Widget build(BuildContext context) {
    final style = ArticleScope.of(context).style;
    final colors = style.colors;
    final variant = callout.variant;
    final (accent, icon, label) = switch (variant) {
      CalloutVariant.note => (colors.blue, Icons.edit_note_rounded, 'Note'),
      CalloutVariant.tip => (colors.green, Icons.lightbulb_outline_rounded, 'Tip'),
      CalloutVariant.info => (colors.cyan, Icons.info_outline_rounded, 'Info'),
      CalloutVariant.warning => (colors.orange, Icons.warning_amber_rounded, 'Warning'),
      CalloutVariant.danger => (colors.pink, Icons.error_outline_rounded, 'Danger'),
      null => (colors.borderActive, null, null),
    };
    final titleStyle = style.body.copyWith(fontWeight: FontWeight.w700, color: variant == null ? colors.ink : accent);
    final title = callout.title;
    return Container(
      padding: EdgeInsetsDirectional.fromSTEB(style.fontSize * 0.9, 12, 14, 14),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        border: BorderDirectional(start: BorderSide(color: accent, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null || label != null) ...[
            Row(
              children: [
                if (icon != null) ...[Icon(icon, size: style.fontSize * 1.05, color: accent), const SizedBox(width: 8)],
                Expanded(child: title != null ? ArticleText(title, style: titleStyle) : Text(label!, style: titleStyle)),
              ],
            ),
            SizedBox(height: style.innerGap * 0.6),
          ],
          BlockColumn(blocks: callout.blocks),
        ],
      ),
    );
  }
}

class _FootnotesView extends StatelessWidget {
  const _FootnotesView({required this.items});

  final List<Footnote> items;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final style = scope.style;
    final colors = style.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Divider(color: colors.border),
        SizedBox(height: style.innerGap),
        Text('NOTES', style: style.caption.copyWith(letterSpacing: 0.6, fontWeight: FontWeight.w600)),
        SizedBox(height: style.innerGap),
        scope.restyled(
          style.derive(scale: 0.88),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final note in items)
                Padding(
                  key: scope.footnoteKey(note.id),
                  padding: EdgeInsets.only(bottom: style.innerGap),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      SizedBox(
                        width: style.fontSize * 1.8,
                        child: Semantics(
                          button: true,
                          label: 'Back from note ${note.label}',
                          excludeSemantics: true,
                          child: GestureDetector(
                            onTap: scope.onFootnoteBack,
                            child: Text(
                              '${note.label}.',
                              style: style.body.copyWith(
                                fontSize: style.fontSize * 0.88,
                                color: colors.primary,
                                fontFeatures: const [FontFeature.tabularFigures()],
                              ),
                            ),
                          ),
                        ),
                      ),
                      Expanded(child: BlockColumn(blocks: note.blocks)),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

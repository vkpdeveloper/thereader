import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/features/articles/article_blocks.dart';
import 'package:thereader/features/articles/article_style.dart';
import 'package:truffle/truffle.dart';

/// [blocks] drawn as the article screen draws them, at a phone's width.
Widget blocksAt(double width, List<Block> blocks) {
  final style = ArticleStyle.of(const ReaderPreferences(), AppColors.defaults);
  return MaterialApp(
    theme: AppTheme.dark,
    home: Scaffold(
      body: ArticleScope(
        style: style,
        onLink: (_) {},
        onFootnote: (_) {},
        onFootnoteBack: () {},
        onImages: (_, _) {},
        footnoteKey: (_) => GlobalKey(),
        child: SingleChildScrollView(
          child: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              child: Column(children: [for (final b in blocks) BlockView(block: b)]),
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('an inline formula wider than the line scrolls instead of overflowing', (tester) async {
    await tester.pumpWidget(
      blocksAt(320, [
        ParagraphBlock([
          InlineMath(
            tex: r'A = Q\,\text{diag}(\lambda_1,\ldots,\lambda_n)\,Q^T,\qquad Q = [q_1,\ldots,q_n] + \sum_{i=1}^{n} x_i^0 (1-\alpha\lambda_i)^k q_i',
            text: 'A = Q diag(...) Q^T',
          ),
        ]),
      ]),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byType(Math), findsOneWidget);
    final scroll = find.ancestor(of: find.byType(Math), matching: find.byType(SingleChildScrollView)).first;
    expect(scroll, findsOneWidget);
    expect(tester.getSize(scroll).width, lessThanOrEqualTo(320));
  });

  testWidgets('a long file name never hides the code language', (tester) async {
    await tester.pumpWidget(
      blocksAt(360, [
        CodeBlock(
          code: 'gem install stripe',
          language: 'ruby',
          title: 'GemfileSelect a languageRubyPythonPHPJavaNode.jsGo.NET No results and more words to overflow',
        ),
      ]),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final label = find.text('Ruby');
    expect(label, findsOneWidget);
    expect(tester.getRect(label).right, lessThanOrEqualTo(360));
    expect(tester.getRect(label).left, greaterThan(0));
  });

  testWidgets('short quotes are italic, long quotes stay upright', (tester) async {
    final long = 'An abstract that runs for several screens. ' * 12;
    await tester.pumpWidget(
      blocksAt(360, [
        QuoteBlock(blocks: [ParagraphBlock([const TextRun('A short quotation.')])]),
        QuoteBlock(blocks: [ParagraphBlock([TextRun(long)])]),
      ]),
    );
    await tester.pumpAndSettle();
    FontStyle? styleOf(String text) => tester
        .widget<Text>(find.byWidgetPredicate((w) => w is Text && (w.textSpan?.toPlainText().startsWith(text) ?? false)))
        .textSpan!
        .style
        ?.fontStyle;
    expect(styleOf('A short quotation.'), FontStyle.italic);
    expect(styleOf('An abstract'), FontStyle.normal);
  });

  testWidgets('a note mark stays with its word and closing punctuation never starts a line', (tester) async {
    final orphans = <double>[];
    for (var width = 120.0; width <= 360; width += 3) {
      await tester.pumpWidget(
        blocksAt(width, [
          ParagraphBlock([
            const TextRun('多くの首都機能が集約しており、事実上の首都である'),
            FootnoteRef(id: 'n2', label: '2'),
            const TextRun('。そのため文献の中には東京都を首都だと明言するものもある'),
            FootnoteRef(id: 'n12', label: '12'),
            const TextRun('。'),
          ]),
        ]),
      );
      final paragraph = tester.renderObject<RenderParagraph>(find.byType(RichText).first);
      final text = paragraph.text.toPlainText(includeSemanticsLabels: false);
      double top(int i) => paragraph.getBoxesForSelection(TextSelection(baseOffset: i, extentOffset: i + 1)).first.top;
      for (final mark in ['²', '¹²']) {
        final at = text.indexOf(mark);
        final dot = at + mark.length;
        // The mark sits on its word's line and the full stop on the mark's.
        if (top(at) > top(at - 2) + 1 || top(dot) > top(dot - 1) + 1) orphans.add(width);
      }
    }
    expect(orphans, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('punctuation after inline math stays with the formula', (tester) async {
    await tester.pumpWidget(
      blocksAt(300, [
        ParagraphBlock([
          const TextRun('when optimizing a smooth function '),
          InlineMath(tex: 'f', text: 'f'),
          const TextRun(', we make a small step'),
        ]),
      ]),
    );
    await tester.pumpAndSettle();
    final math = find.byType(Math);
    final inline = find.ancestor(of: math, matching: find.byType(RichText)).first;
    expect(tester.widget<RichText>(inline).text.toPlainText(), '￼,');
    expect(find.textContaining(' we make a small step', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

package dk.nota.flutterreadium

import dk.nota.flutterreadium.progressive.LoopbackArchiveOpener
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.LocalizedString
import org.readium.r2.shared.publication.Manifest
import org.readium.r2.shared.publication.Metadata
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.getOrElse
import org.readium.r2.shared.util.mediatype.MediaType
import org.readium.r2.shared.util.resource.Resource
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Regression for the blank reader on image-heavy maths books: the first
 * locator waits on [findAllCssSelectors], which was quadratic in chapter size.
 * The fixture is generated here, shaped like such a chapter: one container div,
 * thousands of id'd paragraphs, each with inline equation images.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class FindAllCssSelectorsTest {
    private val sections = 4000

    @Test fun largeChapterSelectorsAreCollectedInDocumentOrderQuickly() = runBlocking {
        val publication = publication()
        val started = System.nanoTime()
        val selectors = publication.findAllCssSelectors(Url("OEBPS/big.xhtml")!!)!!
        val elapsedMs = (System.nanoTime() - started) / 1_000_000

        val expected = listOf("#chapter-big") +
            (0 until sections).flatMap { listOf("#sec-$it", "#p-$it") }
        assertEquals(expected, selectors)
        // Upstream took about a minute on a 1.5 MB chapter; one parse is milliseconds.
        assertTrue("took ${elapsedMs}ms", elapsedMs < 5_000)
    }

    @Test fun selectorsStayWithinTheRequestedDocument() = runBlocking {
        val selectors = publication().findAllCssSelectors(Url("OEBPS/small.xhtml#p-1")!!)!!
        assertEquals(listOf("#small-title", "#small-p"), selectors)
    }

    @Test fun elementsWithoutIdsAreSkipped() {
        assertEquals(
            listOf("#a", "#c"),
            documentIdSelectors("<html><body><p id='a'>x</p><p>y</p><p id=''>z</p><div id='c'/></body></html>"),
        )
    }

    @Test fun pathSelectorsFallBackToTheirIdAnchoredAncestor() {
        assertEquals("#chapter-big", leadingIdSelector("#chapter-big > p:nth-child(3)"))
        assertEquals("#p-7", leadingIdSelector("#p-7 > span.math > img"))
        assertEquals(null, leadingIdSelector("#p-7"))
        assertEquals(null, leadingIdSelector(":root > body > p"))
    }

    private suspend fun publication(): Publication {
        val resource = BytesResource(epub(), "https://example.com/synthetic.epub")
        val asset = LoopbackArchiveOpener().sniffOpen(resource).getOrElse { throw AssertionError(it) }
        fun xhtml(href: String) = Link(href = Url(href)!!, mediaType = MediaType.XHTML)
        return Publication(
            manifest = Manifest(
                metadata = Metadata(
                    conformsTo = setOf(Publication.Profile.EPUB),
                    localizedTitle = LocalizedString("Synthetic maths"),
                ),
                readingOrder = listOf(xhtml("OEBPS/big.xhtml"), xhtml("OEBPS/small.xhtml")),
            ),
            container = asset.container,
        )
    }

    private fun epub(): ByteArray {
        val big = buildString {
            append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
            append("<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>Big</title></head><body>")
            append("<div id=\"chapter-big\">")
            for (i in 0 until sections) {
                append("<h2 id=\"sec-$i\">Section $i</h2><p id=\"p-$i\">Let ")
                append("<span class=\"math inline\"><img src=\"eq/$i.png\" alt=\"x_$i\"/></span>")
                append(" and <span class=\"math inline\"><img src=\"eq/$i-b.png\" alt=\"y_$i\"/></span>.</p>")
                append("<p>Unlabelled prose $i.</p>")
            }
            append("</div></body></html>")
        }
        val small =
            "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>" +
                "<h1 id=\"small-title\">Small</h1><p id=\"small-p\">Text</p></body></html>"

        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            fun add(name: String, bytes: ByteArray) {
                val entry = ZipEntry(name).apply {
                    method = ZipEntry.STORED
                    size = bytes.size.toLong()
                    compressedSize = size
                    crc = CRC32().apply { update(bytes) }.value
                }
                zip.putNextEntry(entry)
                zip.write(bytes)
                zip.closeEntry()
            }
            add("mimetype", "application/epub+zip".encodeToByteArray())
            add("OEBPS/big.xhtml", big.encodeToByteArray())
            add("OEBPS/small.xhtml", small.encodeToByteArray())
        }
        return out.toByteArray()
    }

    private class BytesResource(val bytes: ByteArray, url: String) : Resource {
        override val sourceUrl = AbsoluteUrl(url)!!
        override suspend fun length(): Try<Long, ReadError> = Try.success(bytes.size.toLong())
        override suspend fun properties(): Try<Resource.Properties, ReadError> = Try.success(Resource.Properties {})
        override suspend fun read(range: LongRange?): Try<ByteArray, ReadError> {
            val start = range?.first?.toInt() ?: 0
            val end = (range?.last?.plus(1)?.toInt() ?: bytes.size).coerceAtMost(bytes.size)
            return Try.success(bytes.copyOfRange(start, end))
        }
        override fun close() {}
    }
}

package dk.nota.flutterreadium

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.LocalizedString
import org.readium.r2.shared.publication.Manifest
import org.readium.r2.shared.publication.Metadata
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.util.Url
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class PublicationHrefIndexTest {
    private fun link(href: String, title: String = href, alternates: List<Link> = emptyList(), children: List<Link> = emptyList()) =
        Link(href = Url(href)!!, title = title, alternates = alternates, children = children)
    private fun publication(resources: List<Link>, readingOrder: List<Link> = emptyList(), links: List<Link> = emptyList()) =
        Publication(Manifest(metadata = Metadata(localizedTitle = LocalizedString("Fixture")), resources = resources, readingOrder = readingOrder, links = links))

    @Test fun preservesDepthFirstPrecedenceNormalizationAndExactBeforeFallback() {
        val p = publication(
            readingOrder = listOf(link("Text/../Text/chapter.xhtml", "spine", alternates = listOf(link("Images/a.png", "alternate")), children = listOf(link("Images/b.png", "child")))),
            resources = listOf(link("Images/a.png", "duplicate"), link("Images/b.png", "duplicate child"), link("Images/a.png?size=2#detail", "exact"), link("Images/a%20b.png")),
            links = listOf(link("Images/c.png", "link")),
        )
        for (href in listOf("Text/chapter.xhtml", "Images/a.png", "Images/b.png", "Images/c.png", "Images/a.png?size=2#detail", "Images/a.png?other=1#anchor", "Images/a%20b.png", "Images/missing.png", "https://example.com/a.png")) {
            val url = Url(href)!!
            assertEquals(href, p.linkWithHref(url), PublicationHrefIndex.lookup(p, url))
        }
    }

    @Test fun doesNotReuseAnotherPublicationsLinks() {
        val url = Url("image.png")!!
        val a = publication(listOf(link("image.png", "first")))
        val b = publication(listOf(link("image.png", "second")))
        assertEquals("first", PublicationHrefIndex.lookup(a, url)?.title)
        assertEquals("second", PublicationHrefIndex.lookup(b, url)?.title)
    }

    @Test fun imageHeavyManifestBenchmark() {
        val p = publication((0 until 7442).map { link("Images/$it.png") })
        val queries = (0 until 100).map { Url("Images/${(it * 73) % 7442}.png?size=1#fragment")!! }
        fun ms(block: () -> Unit): Double {
            val start = System.nanoTime(); block(); return (System.nanoTime() - start) / 1e6
        }
        val buildMs = ms { PublicationHrefIndex.lookup(p, queries.first()) }
        val oldMs = ms { queries.forEach { p.linkWithHref(it) } }
        val newMs = ms { queries.forEach { assertEquals(it.path!!.substringAfterLast('/'), PublicationHrefIndex.lookup(p, it)?.href.toString().substringAfterLast('/')) } }
        println("HREF_BENCH entries=7442 queries=100 buildMs=$buildMs scanMs=$oldMs indexMs=$newMs")
        // Semantic equality is the gate; timings are evidence, not a flaky CI ratio.
        queries.forEach { assertEquals(p.linkWithHref(it), PublicationHrefIndex.lookup(p, it)) }
    }
}

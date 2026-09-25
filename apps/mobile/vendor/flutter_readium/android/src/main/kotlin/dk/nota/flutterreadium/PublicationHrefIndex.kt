package dk.nota.flutterreadium

import java.util.WeakHashMap
import org.readium.r2.shared.DelicateReadiumApi
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.util.Url

/**
 * Equivalent to Manifest.linkWithHref, without normalizing the whole manifest
 * for every WebView image request. Publication has identity equality and an
 * immutable manifest. Values never retain their weak publication keys.
 */
@OptIn(DelicateReadiumApi::class)
object PublicationHrefIndex {
    private val publications = WeakHashMap<Publication, Map<Url, Link>>()

    @JvmStatic
    fun lookup(publication: Publication, href: Url): Link? {
        val index = synchronized(publications) {
            publications.getOrPut(publication) { build(publication) }
        }
        val normalized = href.normalize()
        return index[normalized] ?: index[normalized.removeFragment().removeQuery()]
    }

    private fun build(publication: Publication): Map<Url, Link> {
        val result = HashMap<Url, Link>()
        fun visit(links: List<Link>) {
            for (link in links) {
                result.putIfAbsent(link.url().normalize(), link)
                visit(link.alternates)
                visit(link.children)
            }
        }
        visit(publication.readingOrder)
        visit(publication.resources)
        visit(publication.links)
        return result
    }
}

package dk.nota.flutterreadium.progressive

import java.net.URI
import org.readium.r2.shared.util.archive.ArchiveOpener
import org.readium.r2.shared.util.asset.DefaultArchiveOpener
import org.readium.r2.shared.util.data.Readable
import org.readium.r2.shared.util.format.Format
import org.readium.r2.shared.util.resource.Resource

/** Only app-owned loopback EPUBs use the bounded progressive ZIP policy. */
internal class LoopbackArchiveOpener : ArchiveOpener {
    private val standard = DefaultArchiveOpener()
    private val progressive = StreamingZipArchiveProvider()

    override suspend fun open(format: Format, source: Readable) =
        if (source.isLoopback()) {
            progressive.open(format, source).map { org.readium.r2.shared.util.asset.ContainerAsset(format, it) }
        } else {
            standard.open(format, source)
        }

    override suspend fun sniffOpen(source: Readable) =
        if (source.isLoopback()) {
            // Keep ZIP format detection and EPUB refinement in AssetRetriever.
            progressive.sniffOpen(source).map {
                org.readium.r2.shared.util.asset.ContainerAsset(
                    Format(
                        specification = org.readium.r2.shared.util.format.FormatSpecification(
                            org.readium.r2.shared.util.format.Specification.Zip
                        ),
                        mediaType = org.readium.r2.shared.util.mediatype.MediaType.ZIP,
                        fileExtension = org.readium.r2.shared.util.FileExtension("zip")
                    ), it
                )
            }
        } else {
            standard.sniffOpen(source)
        }

    private fun Readable.isLoopback(): Boolean {
        val url = (this as? Resource)?.sourceUrl ?: return false
        val uri = runCatching { URI(url.toString()) }.getOrNull() ?: return false
        return uri.scheme == "http" && uri.host == "127.0.0.1"
    }
}

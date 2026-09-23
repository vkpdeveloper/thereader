package dk.nota.flutterreadium

import android.content.res.AssetManager
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.readium.r2.navigator.epub.css.FontStyle
import org.readium.r2.navigator.preferences.FontFamily
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.data.Container
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.resource.InMemoryResource
import org.readium.r2.shared.util.resource.Resource

// THEREADER PATCH: bundled host-app fonts declared to the EPUB navigator.
// The files are Flutter assets of the host app, read offline from the APK's
// `flutter_assets/assets/fonts/` folder.
//
// They are served on the publication origin (https://readium_package/), not
// on Readium's assets origin. Font loads are CORS requests, and the assets
// origin (androidx WebViewAssetLoader) sends no CORS headers, so Chromium
// blocks cross-origin faces. Same-origin needs no CORS and leaves WebView
// security settings alone.

data class HostFontFace(
    val asset: String,
    val italic: Boolean,
    val minWeight: Int,
    val maxWeight: Int,
)

data class HostFontFamily(
    val name: String,
    val fallback: String,
    val faces: List<HostFontFace>,
)

object HostFontFamilies {
    /** Reserved package path; [HostFontContainer] answers it before the EPUB. */
    const val FONT_PATH = "__thereader_fonts/"

    private const val PACKAGE_HOST = "readium_package"
    private const val ASSET_DIR = "assets/fonts/"

    private val NAME = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val ASSET = Regex("^assets/fonts/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$")

    /** Parses the `fontFamilies` creation param; malformed entries are dropped. */
    fun parse(raw: Any?): List<HostFontFamily> =
        (raw as? List<*>).orEmpty().mapNotNull { entry ->
            val map = entry as? Map<*, *> ?: return@mapNotNull null
            val name = (map["name"] as? String)?.takeIf { NAME.matches(it) } ?: return@mapNotNull null
            val fallback = if (map["fallback"] == "sans-serif") "sans-serif" else "serif"
            val faces =
                (map["faces"] as? List<*>).orEmpty().mapNotNull { f ->
                    val face = f as? Map<*, *> ?: return@mapNotNull null
                    val asset = (face["asset"] as? String)?.takeIf { ASSET.matches(it) } ?: return@mapNotNull null
                    val min = (face["minWeight"] as? Number)?.toInt()?.coerceIn(1, 1000) ?: 400
                    val max = (face["maxWeight"] as? Number)?.toInt()?.coerceIn(min, 1000) ?: min
                    HostFontFace(asset, face["style"] == "italic", min, max)
                }
            if (faces.isEmpty()) null else HostFontFamily(name, fallback, faces)
        }

    /** File name of a face, e.g. `Literata.ttf`; [ASSET] guarantees no slash. */
    fun fileName(face: HostFontFace): String = face.asset.removePrefix(ASSET_DIR)

    fun declareIn(
        config: EpubNavigatorFragment.Configuration,
        families: List<HostFontFamily>,
    ) {
        for (family in families) {
            val alternate = if (family.fallback == "sans-serif") FontFamily.SANS_SERIF else FontFamily.SERIF
            config.addFontFamilyDeclaration(FontFamily(family.name), listOf(alternate)) {
                for (face in family.faces) {
                    addFontFace {
                        // Absolute, so Readium keeps it instead of resolving it
                        // against the assets origin. Not preloaded, so only the
                        // faces a chapter actually uses are fetched.
                        addSource(AbsoluteUrl("https://$PACKAGE_HOST/$FONT_PATH${fileName(face)}")!!)
                        setFontStyle(if (face.italic) FontStyle.ITALIC else FontStyle.NORMAL)
                        setFontWeight(face.minWeight..face.maxWeight)
                    }
                }
            }
        }
    }

    /**
     * The font file requested by [url], when it targets [FONT_PATH] on the
     * package origin (or relative to it). Readium passes unknown package URLs
     * through absolute, so both forms are accepted.
     */
    fun requestedFile(url: Url): String? {
        if (url is AbsoluteUrl && url.host != PACKAGE_HOST) return null
        val path = url.path?.removePrefix("/") ?: return null
        if (!path.startsWith(FONT_PATH)) return null
        return path.removePrefix(FONT_PATH).takeIf { it.isNotEmpty() && '/' !in it }
    }
}

/**
 * Publication container that also answers [HostFontFamilies.FONT_PATH] for the
 * font files currently declared in [families], and nothing else. Other URLs,
 * the EPUB's entries and closing all go to [inner]; fonts are not listed in
 * [entries], so search and content iteration never see them.
 */
class HostFontContainer(
    private val inner: Container<Resource>,
    private val assets: AssetManager,
    private val families: () -> List<HostFontFamily>,
) : Container<Resource> {
    override val entries: Set<Url>
        get() = inner.entries

    override fun get(url: Url): Resource? {
        val file = HostFontFamilies.requestedFile(url) ?: return inner[url]
        val declared = families().any { family -> family.faces.any { HostFontFamilies.fileName(it) == file } }
        if (!declared) return inner[url]
        return InMemoryResource(sourceUrl = null, properties = Resource.Properties()) {
            withContext(Dispatchers.IO) {
                try {
                    Try.success(assets.open("flutter_assets/assets/fonts/$file").use { it.readBytes() })
                } catch (e: IOException) {
                    Try.failure(ReadError.Decoding(e))
                }
            }
        }
    }

    override fun close() {
        inner.close()
    }
}

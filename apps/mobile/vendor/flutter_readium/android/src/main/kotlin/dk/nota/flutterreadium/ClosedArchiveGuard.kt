package dk.nota.flutterreadium

import kotlinx.coroutines.CancellationException
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.data.Container
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.resource.Resource

/**
 * THEREADER PATCH: turns reads that race the publication's close into
 * [ReadError]s.
 *
 * Closing a book closes the EPUB's `java.util.zip.ZipFile` while the WebView may
 * still be fetching chapter resources (a slow, image-heavy chapter). Readium's
 * `FileZipContainer` only maps `IOException`, so `ZipFile.ensureOpen`'s
 * `IllegalStateException("zip file closed")` escaped on a Chromium IO thread
 * and killed the app as the reader closed.
 */
class ClosedArchiveGuard(
    private val inner: Container<Resource>,
) : Container<Resource> {
    override val sourceUrl: AbsoluteUrl?
        get() = inner.sourceUrl

    override val entries: Set<Url>
        get() = inner.entries

    override fun get(url: Url): Resource? = inner[url]?.let(::GuardedResource)

    override fun close() {
        inner.close()
    }

    private class GuardedResource(
        private val inner: Resource,
    ) : Resource {
        override val sourceUrl: AbsoluteUrl?
            get() = inner.sourceUrl

        override suspend fun properties(): Try<Resource.Properties, ReadError> = guard { inner.properties() }

        override suspend fun length(): Try<Long, ReadError> = guard { inner.length() }

        override suspend fun read(range: LongRange?): Try<ByteArray, ReadError> = guard { inner.read(range) }

        override fun close() {
            inner.close()
        }
    }

    companion object {
        /** Runs [block], mapping a closed archive's `IllegalStateException` to a failure. */
        suspend fun <T> guard(block: suspend () -> Try<T, ReadError>): Try<T, ReadError> =
            try {
                block()
            } catch (e: CancellationException) {
                // A subclass of IllegalStateException; cancellation must propagate.
                throw e
            } catch (e: IllegalStateException) {
                Try.failure(ReadError.Decoding(e))
            }
    }
}

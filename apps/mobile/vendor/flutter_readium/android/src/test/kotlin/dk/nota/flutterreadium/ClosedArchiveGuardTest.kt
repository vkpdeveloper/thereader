package dk.nota.flutterreadium

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.data.Container
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.resource.Resource
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Regression for the crash on closing a book mid-load: a WebView read reached
 * the EPUB's ZipFile after the publication closed it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class ClosedArchiveGuardTest {
    private val chapter = Url("OEBPS/chapter.xhtml")!!

    @Test fun readAfterTheArchiveClosesFailsInsteadOfThrowing() = runBlocking {
        val zip = zipFile(mapOf("OEBPS/chapter.xhtml" to "<p>x</p>"))
        val guarded = ClosedArchiveGuard(ZipContainer(zip))
        val resource = guarded[chapter]!!
        assertArrayEquals("<p>x</p>".toByteArray(), (resource.read() as Try.Success).value)

        guarded.close()

        val result = resource.read()
        assertTrue(result is Try.Failure)
        assertTrue((result as Try.Failure).value is ReadError.Decoding)
        assertTrue(resource.length() is Try.Failure)
    }

    @Test fun cancellationStillPropagates() = runBlocking {
        val cancelled = ClosedArchiveGuard(FixedContainer { throw CancellationException("cancelled") })
        val thrown = runCatching { cancelled[chapter]!!.read() }.exceptionOrNull()
        assertTrue(thrown is CancellationException)
    }

    @Test fun otherEntriesAndMissingOnesPassThrough() {
        val guarded = ClosedArchiveGuard(FixedContainer { Try.success(ByteArray(0)) })
        assertEquals(setOf(chapter), guarded.entries)
        assertEquals(null, guarded[Url("missing.xhtml")!!])
    }

    private fun zipFile(files: Map<String, String>): ZipFile {
        val file = File.createTempFile("guard", ".epub").apply { deleteOnExit() }
        ZipOutputStream(file.outputStream()).use { out ->
            files.forEach { (name, body) ->
                out.putNextEntry(ZipEntry(name))
                out.write(body.toByteArray())
                out.closeEntry()
            }
        }
        return ZipFile(file)
    }

    /** Reads like Readium's FileZipContainer: straight from the shared ZipFile. */
    private inner class ZipContainer(
        private val zip: ZipFile,
    ) : Container<Resource> {
        override val entries: Set<Url> = setOf(chapter)

        override fun get(url: Url): Resource? {
            val entry = zip.getEntry(url.toString()) ?: return null
            return FixedResource { Try.success(zip.getInputStream(entry).use { it.readBytes() }) }
        }

        override fun close() = zip.close()
    }

    private inner class FixedContainer(
        private val read: () -> Try<ByteArray, ReadError>,
    ) : Container<Resource> {
        override val entries: Set<Url> = setOf(chapter)

        override fun get(url: Url): Resource? = if (url == chapter) FixedResource(read) else null

        override fun close() {}
    }

    private class FixedResource(
        private val bytes: () -> Try<ByteArray, ReadError>,
    ) : Resource {
        override val sourceUrl: AbsoluteUrl? = null

        override suspend fun properties(): Try<Resource.Properties, ReadError> = bytes().map { Resource.Properties() }

        override suspend fun length(): Try<Long, ReadError> = bytes().map { it.size.toLong() }

        override suspend fun read(range: LongRange?): Try<ByteArray, ReadError> = bytes()

        override fun close() {}
    }
}

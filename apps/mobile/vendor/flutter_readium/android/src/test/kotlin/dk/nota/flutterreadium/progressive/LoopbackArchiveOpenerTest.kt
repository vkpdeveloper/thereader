package dk.nota.flutterreadium.progressive

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.getOrElse
import org.readium.r2.shared.util.resource.Resource

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class LoopbackArchiveOpenerTest {
    @Test fun smallLoopbackArchiveOpensWithoutReadingTheWholeBook() = runBlocking {
        val resource = CountingResource(fixture(), "http://127.0.0.1:12345/lease/book.epub")
        val asset = LoopbackArchiveOpener().sniffOpen(resource).getOrElse { throw AssertionError(it) }
        val text = asset.container[Url("chapter.xhtml")!!]!!.read().getOrElse { throw AssertionError(it) }
        assertEquals("<p>Readable first chapter</p>", text.decodeToString())
        assertTrue("Read ${resource.bytesRead}/${resource.bytes.size} bytes", resource.bytesRead < resource.bytes.size / 10)
        asset.close()
    }

    @Test fun ordinaryRemoteArchivesKeepTheUpstreamCachingPolicy() = runBlocking {
        val resource = CountingResource(fixture(), "https://example.com/book.epub")
        val asset = LoopbackArchiveOpener().sniffOpen(resource).getOrElse { throw AssertionError(it) }
        assertTrue(resource.bytesRead >= resource.bytes.size)
        asset.close()
    }

    private fun fixture(): ByteArray {
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
            add("chapter.xhtml", "<p>Readable first chapter</p>".encodeToByteArray())
            add("later.bin", ByteArray(2 * 1024 * 1024) { (it % 251).toByte() })
        }
        return out.toByteArray()
    }

    private class CountingResource(val bytes: ByteArray, url: String) : Resource {
        override val sourceUrl = AbsoluteUrl(url)!!
        var bytesRead = 0L
        override suspend fun length(): Try<Long, ReadError> = Try.success(bytes.size.toLong())
        override suspend fun properties(): Try<Resource.Properties, ReadError> = Try.success(Resource.Properties {})
        override suspend fun read(range: LongRange?): Try<ByteArray, ReadError> {
            val start = range?.first?.toInt() ?: 0
            val end = (range?.last?.plus(1)?.toInt() ?: bytes.size).coerceAtMost(bytes.size)
            val result = bytes.copyOfRange(start, end)
            bytesRead += result.size
            return Try.success(result)
        }
        override fun close() {}
    }
}

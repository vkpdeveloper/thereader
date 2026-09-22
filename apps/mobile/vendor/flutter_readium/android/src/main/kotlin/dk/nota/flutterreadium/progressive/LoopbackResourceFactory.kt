@file:OptIn(org.readium.r2.shared.ExperimentalReadiumApi::class, org.readium.r2.shared.InternalReadiumApi::class)

package dk.nota.flutterreadium.progressive

import java.io.IOException
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.http.HttpClient
import org.readium.r2.shared.util.http.HttpError
import org.readium.r2.shared.util.http.HttpRequest
import org.readium.r2.shared.util.http.HttpResource
import org.readium.r2.shared.util.resource.Resource
import org.readium.r2.shared.util.resource.ResourceFactory

/** Use exact ranges, instead of HttpResource's open-ended streaming read-ahead. */
internal class LoopbackResourceFactory(private val client: HttpClient) : ResourceFactory {
    override suspend fun create(url: AbsoluteUrl): Try<Resource, ResourceFactory.Error> {
        val uri = runCatching { URI(url.toString()) }.getOrNull()
        if (uri?.scheme != "http" || uri.host != "127.0.0.1") {
            return Try.failure(ResourceFactory.Error.SchemeNotSupported(url.scheme))
        }
        return Try.success(LoopbackResource(url, client))
    }
}

private class LoopbackResource(
    override val sourceUrl: AbsoluteUrl,
    private val client: HttpClient,
) : Resource {
    private val metadata = HttpResource(sourceUrl, client)
    override suspend fun properties() = metadata.properties()
    override suspend fun length() = metadata.length()
    override fun close() = metadata.close()

    override suspend fun read(range: LongRange?): Try<ByteArray, ReadError> = withContext(Dispatchers.IO) {
        try {
            val request = HttpRequest(sourceUrl) { range?.let { setRange(it) } }
            client.stream(request).mapFailure { ReadError.Access(it) }.map { response ->
                response.body.use { body ->
                    if (range != null && response.response.statusCode.code != 206) {
                        throw IOException("Loopback publication server did not honor the requested range")
                    }
                    val bytes = body.readBytes()
                    if (range != null && bytes.size.toLong() != range.last - range.first + 1) {
                        throw IOException("Loopback publication server returned an incomplete range")
                    }
                    bytes
                }
            }
        } catch (error: IOException) {
            Try.failure(ReadError.Access(HttpError.IO(error)))
        }
    }
}

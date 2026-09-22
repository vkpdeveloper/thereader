/*
 * Copyright 2023 Readium Foundation. All rights reserved.
 * Use of this source code is governed by the BSD-style license
 * available in the top-level LICENSE file of the project.
 */

@file:OptIn(InternalReadiumApi::class)

package dk.nota.flutterreadium.progressive

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.readium.r2.shared.InternalReadiumApi
import org.readium.r2.shared.extensions.findInstance
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.archive.ArchiveOpener
import org.readium.r2.shared.util.data.Container
import org.readium.r2.shared.util.data.ReadError
import org.readium.r2.shared.util.data.ReadException
import org.readium.r2.shared.util.data.Readable
import org.readium.r2.shared.util.format.Format
import org.readium.r2.shared.util.format.Specification
import org.readium.r2.shared.util.resource.Resource
import org.readium.r2.shared.util.zip.compress.archivers.zip.ZipFile
import org.readium.r2.shared.util.zip.jvm.SeekableByteChannel

/**
 * An [ArchiveOpener] able to open a ZIP archive served through a stream (e.g. HTTP server,
 * content URI, etc.).
 */
internal class StreamingZipArchiveProvider {

    suspend fun sniffOpen(source: Readable): Try<Container<Resource>, ArchiveOpener.SniffOpenError> {
        return try {
            val container = openBlob(source, ::ReadException, null)
            Try.success(container)
        } catch (exception: Exception) {
            exception.findInstance(ReadException::class.java)
                ?.let { Try.failure(ArchiveOpener.SniffOpenError.Reading(it.error)) }
                ?: Try.failure(ArchiveOpener.SniffOpenError.NotRecognized)
        }
    }

    suspend fun open(
        format: Format,
        source: Readable,
    ): Try<Container<Resource>, ArchiveOpener.OpenError> {
        if (!format.conformsTo(Specification.Zip)) {
            return Try.failure(
                ArchiveOpener.OpenError.FormatNotSupported(format)
            )
        }

        return try {
            val container = openBlob(
                source,
                ::ReadException,
                (source as? Resource)?.sourceUrl
            )
            Try.success(container)
        } catch (exception: Exception) {
            val error = exception.findInstance(ReadException::class.java)
                ?.let { ArchiveOpener.OpenError.Reading(it.error) }
                ?: ArchiveOpener.OpenError.Reading(ReadError.Decoding(exception))

            Try.failure(error)
        }
    }

    private suspend fun openBlob(
        readable: Readable,
        wrapError: (ReadError) -> IOException,
        sourceUrl: AbsoluteUrl?,
    ): Container<Resource> = withContext(Dispatchers.IO) {
        val datasourceChannel = ReadableChannelAdapter(readable, wrapError)
        val channel = wrapBaseChannel(datasourceChannel)
        val zipFile = ZipFile(channel, true)
        val sourceScheme = (readable as? Resource)?.sourceUrl?.scheme
        val cacheEntryMaxSize =
            when {
                sourceScheme?.isContent ?: false -> 5242880
                else -> 0
            }
        StreamingZipContainer(zipFile, sourceUrl, cacheEntryMaxSize)
    }

    private fun wrapBaseChannel(channel: SeekableByteChannel): SeekableByteChannel {
        val size = channel.size()
        // The app already caches edition-pinned chunks on disk. Never force a small
        // EPUB to download completely before its first chapter can be opened.
        val cacheStart = (size - CACHED_TAIL_SIZE).coerceAtLeast(0)
        val cachingChannel = CachingReadableChannel(channel, cacheStart)
        cachingChannel.cache()
        return BufferedReadableChannel(cachingChannel, DEFAULT_BUFFER_SIZE)
    }

    companion object {

        private const val CACHED_TAIL_SIZE = 65557
    }
}

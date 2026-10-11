package com.vkpdeveloper.reader

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : FlutterFragmentActivity() {
    private val copies = Executors.newSingleThreadExecutor()
    private val pending = mutableListOf<Map<String, String>>()
    private var channel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "thereader/open_epub")
        channel?.setMethodCallHandler { call, result ->
            if (call.method == "getPending") {
                synchronized(pending) {
                    result.success(pending.toList())
                    pending.clear()
                }
            } else {
                result.notImplemented()
            }
        }
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        accept(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        accept(intent)
    }

    private fun accept(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        if (uri.scheme != "content" && uri.scheme != "file") return
        copies.execute {
            val item = try {
                mapOf("path" to copyBook(uri, intent.type))
            } catch (_: Exception) {
                mapOf("error" to "Could not open this book from Files.")
            }
            synchronized(pending) { pending.add(item) }
            runOnUiThread { channel?.invokeMethod("filesReady", null) }
        }
    }

    private fun copyBook(uri: Uri, mimeType: String?): String {
        val displayName = runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        }.getOrNull()
        val suffix = (displayName ?: uri.lastPathSegment ?: "").substringAfterLast('.', "").lowercase()
        val extension = when {
            suffix == "mobi" || mimeType == "application/x-mobipocket-ebook" -> "mobi"
            suffix == "epub" || mimeType == "application/epub+zip" -> "epub"
            suffix == "cbz" || mimeType == "application/vnd.comicbook+zip" || mimeType == "application/x-cbz" -> "cbz"
            suffix == "cbr" || mimeType == "application/vnd.comicbook-rar" || mimeType == "application/x-cbr" -> "cbr"
            else -> error("Unsupported book type")
        }
        val directory = File(cacheDir, "external-book-${UUID.randomUUID()}")
        check(directory.mkdir())
        // A comic keeps its file name: it is the title when ComicInfo has none.
        val comic = extension == "cbz" || extension == "cbr"
        val name = displayName?.replace('/', '_')
        val target = File(
            directory,
            if (comic && name != null && !name.startsWith(".") && name.lowercase().endsWith(".$extension")) name
            else "book.$extension",
        )
        try {
            val source = contentResolver.openInputStream(uri) ?: error("File unavailable")
            source.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var count = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        count += read
                        val maximum = when {
                            extension == "mobi" -> 64L * 1024 * 1024
                            comic -> 1024L * 1024 * 1024
                            else -> 512L * 1024 * 1024
                        }
                        if (count > maximum) error("Book too large")
                        output.write(buffer, 0, read)
                    }
                }
            }
            return target.path
        } catch (error: Exception) {
            directory.deleteRecursively()
            throw error
        }
    }

    override fun onDestroy() {
        channel?.setMethodCallHandler(null)
        channel = null
        copies.shutdown()
        super.onDestroy()
    }
}

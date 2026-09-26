package com.vaibhav.thereader.thereader

import android.content.Intent
import android.net.Uri
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
                mapOf("path" to copyEpub(uri))
            } catch (_: Exception) {
                mapOf("error" to "Could not open this EPUB from Files.")
            }
            synchronized(pending) { pending.add(item) }
            runOnUiThread { channel?.invokeMethod("filesReady", null) }
        }
    }

    private fun copyEpub(uri: Uri): String {
        val directory = File(cacheDir, "external-epub-${UUID.randomUUID()}")
        check(directory.mkdir())
        val target = File(directory, "book.epub")
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
                        if (count > 512L * 1024 * 1024) error("EPUB too large")
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

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.vkpdeveloper.reader"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // Required by the Readium Kotlin toolkit (flutter_readium).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.vkpdeveloper.reader"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    packaging {
        // PDF parsing is disabled in the local wrapper. Keep EPUB builds free
        // of the unused PDFium native binaries for every ABI.
        jniLibs.excludes += setOf("**/libpdfium.cr.so", "**/libpdfiumandroid.so")
    }

    signingConfigs {
        create("releaseDebug") {
            // Public debug key used for installable GitHub release APKs. Keep it
            // stable so a later release can update an earlier one.
            storeFile = file("ci-debug-signing.p12")
            storeType = "PKCS12"
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("releaseDebug")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

// Readium 3.2 normalizes every manifest href for every image request. Route only
// the WebView server's three lookups through the equivalent publication index.
androidComponents {
    onVariants(selector().all()) { variant ->
        variant.instrumentation.transformClassesWith(
            com.thereader.gradle.ReadiumLookupTransform::class.java,
            com.android.build.api.instrumentation.InstrumentationScope.ALL,
        ) {}
    }
}

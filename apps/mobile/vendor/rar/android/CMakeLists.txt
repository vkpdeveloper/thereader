cmake_minimum_required(VERSION 3.18)

project(thereader_rar LANGUAGES C)

include(FetchContent)

# libarchive's RAR and RAR5 readers, pinned by hash. Only the static library
# is built; no compression, crypto or XML dependencies are needed for RAR.
FetchContent_Declare(
  libarchive
  URL https://github.com/libarchive/libarchive/releases/download/v3.8.9/libarchive-3.8.9.tar.gz
  URL_HASH SHA256=f5a6539059cf5e597dbeda37bfa4874b1e8dea063c8d93bf85a2b44af90a5bd4
)

FetchContent_GetProperties(libarchive)
if(NOT libarchive_POPULATED)
  FetchContent_Populate(libarchive)
  foreach(option
      ENABLE_TEST ENABLE_TAR ENABLE_CPIO ENABLE_CAT ENABLE_UNZIP ENABLE_XATTR
      ENABLE_ACL ENABLE_ICONV ENABLE_EXPAT ENABLE_LIBXML2 ENABLE_OPENSSL
      ENABLE_MBEDTLS ENABLE_NETTLE ENABLE_LIBB2 ENABLE_LZ4 ENABLE_LZO
      ENABLE_LZMA ENABLE_ZSTD ENABLE_ZLIB ENABLE_BZip2 ENABLE_PCREPOSIX
      ENABLE_PCRE2POSIX ENABLE_LIBGCC ENABLE_CNG ENABLE_WIN32_XMLLITE
      ENABLE_INSTALL)
    set(${option} OFF CACHE BOOL "" FORCE)
  endforeach()
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(${libarchive_SOURCE_DIR} ${libarchive_BINARY_DIR} EXCLUDE_FROM_ALL)
endif()

add_library(thereader_rar SHARED ../src/thereader_rar.c)
target_include_directories(thereader_rar PRIVATE ${libarchive_SOURCE_DIR}/libarchive)
target_compile_definitions(thereader_rar PRIVATE LIBARCHIVE_STATIC)
target_link_libraries(thereader_rar PRIVATE archive_static)
target_link_options(thereader_rar PRIVATE "-Wl,-z,max-page-size=16384")

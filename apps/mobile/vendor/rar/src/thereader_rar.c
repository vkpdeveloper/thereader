// RAR extraction for The Reader's comic import (Android, through FFI).
// Adapted from rar 0.3.0's rar_native.c (MIT, see LICENSE). Local changes:
// archive names never touch the file system. Regular file number i is written
// to `<destination>/i` with plain file I/O and its UTF-8 name is appended,
// NUL-terminated, to `<destination>/index`; links, devices, directories and
// permissions are never materialized. Encrypted entries and archives that
// expand beyond a byte limit are refused.

#include <archive.h>
#include <archive_entry.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RAR_OK 0
#define RAR_DAMAGED 1
#define RAR_ENCRYPTED 2
#define RAR_TOO_LARGE 4
#define RAR_IO 5

#define MAX_ENTRIES 100000

static int fail(char* error, int error_len, int code, const char* message) {
  if (error && error_len > 0) snprintf(error, (size_t)error_len, "%s", message ? message : "");
  return code;
}

__attribute__((visibility("default"))) __attribute__((used))
int32_t thereader_rar_extract(const char* archive_path, const char* destination,
                              int64_t max_bytes, char* error, int32_t error_len) {
  struct archive* reader = archive_read_new();
  if (!reader) return fail(error, error_len, RAR_IO, "Out of memory.");
  archive_read_support_format_rar(reader);
  archive_read_support_format_rar5(reader);
  int result = RAR_OK;
  if (archive_read_open_filename(reader, archive_path, 64 * 1024) != ARCHIVE_OK) {
    result = fail(error, error_len, RAR_DAMAGED, archive_error_string(reader));
    archive_read_free(reader);
    return result;
  }
  char path[4096];
  if (strlen(destination) > sizeof path - 32) {
    archive_read_free(reader);
    return fail(error, error_len, RAR_IO, "The destination path is too long.");
  }
  snprintf(path, sizeof path, "%s/index", destination);
  FILE* index = fopen(path, "wbx");
  if (!index) {
    archive_read_free(reader);
    return fail(error, error_len, RAR_IO, "Could not write the index.");
  }
  int64_t total = 0;
  int entries = 0;
  int files = 0;
  struct archive_entry* entry;
  char buffer[64 * 1024];
  int status;
  while ((status = archive_read_next_header(reader, &entry)) == ARCHIVE_OK) {
    if (++entries > MAX_ENTRIES) {
      result = fail(error, error_len, RAR_TOO_LARGE, "Too many entries.");
      break;
    }
    if (archive_entry_is_encrypted(entry)) {
      result = fail(error, error_len, RAR_ENCRYPTED, "The archive is encrypted.");
      break;
    }
    if (archive_entry_filetype(entry) != AE_IFREG) {
      archive_read_data_skip(reader);
      continue;
    }
    const char* name = archive_entry_pathname_utf8(entry);
    if (!name) name = archive_entry_pathname(entry);
    if (!name || name[0] == '\0') {
      result = fail(error, error_len, RAR_DAMAGED, "An entry has no name.");
      break;
    }
    if (fwrite(name, 1, strlen(name) + 1, index) != strlen(name) + 1) {
      result = fail(error, error_len, RAR_IO, "Could not write the index.");
      break;
    }
    snprintf(path, sizeof path, "%s/%d", destination, files++);
    FILE* out = fopen(path, "wbx");
    if (!out) {
      result = fail(error, error_len, RAR_IO, "Could not write a file.");
      break;
    }
    la_ssize_t read;
    while ((read = archive_read_data(reader, buffer, sizeof buffer)) > 0) {
      total += read;
      if (total > max_bytes) {
        result = fail(error, error_len, RAR_TOO_LARGE, "The archive expands beyond the size limit.");
        break;
      }
      if (fwrite(buffer, 1, (size_t)read, out) != (size_t)read) {
        result = fail(error, error_len, RAR_IO, "Could not write a file.");
        break;
      }
    }
    if (fclose(out) != 0 && result == RAR_OK) {
      result = fail(error, error_len, RAR_IO, "Could not write a file.");
    }
    if (result != RAR_OK) break;
    if (read < 0) {
      const char* message = archive_error_string(reader);
      int encrypted = message && (strstr(message, "assword") || strstr(message, "ncrypt"));
      result = fail(error, error_len, encrypted ? RAR_ENCRYPTED : RAR_DAMAGED, message);
      break;
    }
  }
  if (result == RAR_OK && status != ARCHIVE_EOF) {
    const char* message = archive_error_string(reader);
    int encrypted = message && (strstr(message, "assword") || strstr(message, "ncrypt"));
    result = fail(error, error_len, encrypted ? RAR_ENCRYPTED : RAR_DAMAGED, message);
  }
  if (fclose(index) != 0 && result == RAR_OK) {
    result = fail(error, error_len, RAR_IO, "Could not write the index.");
  }
  archive_read_free(reader);
  return result;
}
